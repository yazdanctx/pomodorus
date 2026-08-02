import { v, ConvexError } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import copy from "../lib/copy.json";
import { SWEEP_GRACE_MS, accept, isLive, isShowable, visibleLabel } from "../lib/presence";
import { tehranDayKey } from "./days";

export const WORK_MINUTES = [25, 55] as const;

async function requireUserId(ctx: MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError(copy.errors.signInFirst);
  return userId;
}

/**
 * Advertise the running session to the feed. Best-effort presence, not
 * truth (docs/adr/0001-local-first-timer.md): the row self-expires at
 * startedAt + durationMs, so an offline cancel goes stale for at most one
 * session length. `label` is the category name for public work sessions,
 * null for private tasks and breaks — denormalized here because the server
 * may not know offline-created categories yet.
 */
export const setPresence = mutation({
  args: {
    kind: v.union(v.literal("work"), v.literal("shortBreak"), v.literal("longBreak")),
    label: v.union(v.string(), v.null()),
    startedAt: v.number(),
    durationMs: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();
    const vetted = accept(args, now);
    if (vetted === null) return;

    const existing = await ctx.db
      .query("presence")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing) {
      await ctx.db.replace(existing._id, { userId, ...vetted });
    } else {
      await ctx.db.insert("presence", { userId, ...vetted });
    }
    // Opportunistic cleanup: long-expired rows from clients that never came
    // back to clear them. The table holds at most one row per active user.
    const all = await ctx.db.query("presence").collect();
    for (const p of all) {
      if (!isLive(p, now - SWEEP_GRACE_MS)) await ctx.db.delete(p._id);
    }
  },
});

/** Drop the presence row (cancel, skip, or completion seen while online). */
export const clearPresence = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/** Everyone working or on break right now. Public: also feeds the landing page. */
export const activeFeed = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const now = Date.now();
    const rows = await ctx.db.query("presence").take(200);
    const feed = [];
    for (const p of rows) {
      if (!isLive(p, now)) continue;
      const user = await ctx.db.get(p.userId);
      if (!user?.username) continue;
      if (!isShowable(p, user.username)) continue;
      feed.push({
        id: p._id,
        username: user.username,
        isMe: p.userId === userId,
        kind: p.kind,
        label: visibleLabel(p), // null on work = private task
        startedAt: p.startedAt,
        durationMs: p.durationMs,
      });
    }
    feed.sort((a, b) => a.startedAt - b.startedAt);
    return feed;
  },
});

/**
 * The signed-in user's focus so far in the current Tehran day: how many work
 * sessions completed and their total nominal time.
 *
 * Read from the server rather than from local storage even though the timer
 * is local-first (docs/adr/0002-todays-focus-from-the-server.md): the device
 * only keeps sessions until they sync, so a local count would drop to zero
 * the moment sync ran. The cost is that this line has nothing to show while
 * offline, which the timer screen renders as a held-open blank rather than a
 * claim that nothing was focused.
 *
 * Null when signed out, so the caller can tell "not yours to see" from a
 * genuine zero.
 */
export const todayFocus = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const today = tehranDayKey(Date.now());
    // Same full scan as the profile chart: pre-migration rows may lack
    // endedAt, and one casual user's session log is tiny.
    const completed = await ctx.db
      .query("sessions")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "completed"))
      .collect();

    let count = 0;
    let totalMs = 0;
    for (const s of completed) {
      if (s.kind !== "work") continue;
      if (tehranDayKey(s.endedAt ?? s.startedAt + s.durationMs) !== today) continue;
      count += 1;
      totalMs += s.durationMs;
    }
    return { count, totalMs };
  },
});

/**
 * No-op stub. The old server-authoritative timer scheduled this at every
 * session's end time; keeping the name prevents pre-migration scheduled
 * jobs from erroring after deploy. Safe to delete once none are pending.
 */
export const finalize = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async () => {},
});

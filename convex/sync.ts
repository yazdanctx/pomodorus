import { v, ConvexError } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import copy from "../lib/copy.json";
import { isProfane } from "../lib/profanity";
import { WORK_MINUTES } from "./sessions";

const MINUTE_MS = 60_000;
const CLOCK_SKEW_MS = 5 * MINUTE_MS;

// Dev-only fast sessions are credited at their nominal duration. Gated by
// the DEV_FAST_POMODORO env var on the deployment so production drops them.
const fastAllowed = () => process.env.DEV_FAST_POMODORO !== undefined;

/**
 * A device's category reference is its client-minted uuid; rows created
 * before the local-first move have no clientId and are addressed by their
 * Convex _id instead.
 */
async function findOwnCategory(
  ctx: MutationCtx,
  userId: Id<"users">,
  clientId: string,
): Promise<Doc<"categories"> | null> {
  const byClient = await ctx.db
    .query("categories")
    .withIndex("by_user_client", (q) => q.eq("userId", userId).eq("clientId", clientId))
    .unique();
  if (byClient) return byClient;
  const legacyId = ctx.db.normalizeId("categories", clientId);
  if (!legacyId) return null;
  const row = await ctx.db.get(legacyId);
  return row && row.userId === userId ? row : null;
}

/**
 * The same test the device applies before queueing the op (`lib/local/device`),
 * repeated because the device is not trusted with it: a category name reaches
 * the public feed, and the queue is a plain JSON blob in localStorage that
 * anyone can hand-edit. A refused name is dropped like any other invalid item,
 * silently — the client that meant it already said no in its own words.
 */
function validName(name: string | undefined): string | null {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length < 1 || trimmed.length > 40) return null;
  return isProfane(trimmed) ? null : trimmed;
}

/**
 * The whole sync protocol in one idempotent mutation
 * (docs/adr/0001-local-first-timer.md): a device uploads everything it has
 * done since it was last online. Category ops apply last-write-wins with
 * delete beating rename; completed work sessions append to the log, deduped by
 * clientId so retries are safe. Invalid items are dropped, never failed — the
 * client clears its queue on success.
 */
export const push = mutation({
  args: {
    categoryOps: v.array(
      v.object({
        clientId: v.string(),
        op: v.union(v.literal("upsert"), v.literal("delete")),
        name: v.optional(v.string()),
        isPublic: v.optional(v.boolean()),
        at: v.number(), // client edit timestamp, for last-write-wins
      }),
    ),
    sessions: v.array(
      v.object({
        clientId: v.string(),
        categoryClientId: v.optional(v.string()),
        startedAt: v.number(),
        durationMs: v.number(),
        endedAt: v.number(),
        devFast: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, { categoryOps, sessions }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new ConvexError(copy.errors.signInFirst);
    const now = Date.now();

    for (const op of categoryOps.slice(0, 200)) {
      const existing = await findOwnCategory(ctx, userId, op.clientId);
      if (existing?.deleted) continue; // tombstones never revive
      if (op.op === "delete") {
        if (existing) {
          await ctx.db.patch(existing._id, { deleted: true, updatedAt: op.at });
        } else {
          // Tombstone for a category the server never saw, so a stale
          // upsert queued on another device can't resurrect it.
          await ctx.db.insert("categories", {
            userId,
            clientId: op.clientId,
            name: "",
            isPublic: false,
            updatedAt: op.at,
            deleted: true,
          });
        }
        continue;
      }
      const name = validName(op.name);
      if (existing) {
        if (op.at <= (existing.updatedAt ?? 0)) continue;
        await ctx.db.patch(existing._id, {
          ...(name !== null ? { name } : {}),
          ...(op.isPublic !== undefined ? { isPublic: op.isPublic } : {}),
          updatedAt: op.at,
        });
      } else if (name !== null) {
        await ctx.db.insert("categories", {
          userId,
          clientId: op.clientId,
          name,
          isPublic: op.isPublic ?? true,
          updatedAt: op.at,
        });
      }
    }

    for (const s of sessions.slice(0, 500)) {
      const dupe = await ctx.db
        .query("sessions")
        .withIndex("by_user_client", (q) => q.eq("userId", userId).eq("clientId", s.clientId))
        .unique();
      if (dupe) continue;
      if (!WORK_MINUTES.some((m) => m * MINUTE_MS === s.durationMs)) continue;
      if (!Number.isFinite(s.startedAt) || !Number.isFinite(s.endedAt)) continue;
      if (s.endedAt > now + CLOCK_SKEW_MS) continue; // no future-dated credit
      if (s.devFast) {
        if (!fastAllowed()) continue;
        if (s.endedAt < s.startedAt) continue;
      } else if (Math.abs(s.endedAt - (s.startedAt + s.durationMs)) > 1000) {
        continue; // a real session ends exactly when its duration elapses
      }
      const category = s.categoryClientId
        ? await findOwnCategory(ctx, userId, s.categoryClientId)
        : null;
      await ctx.db.insert("sessions", {
        userId,
        kind: "work",
        ...(category ? { categoryId: category._id } : {}),
        startedAt: s.startedAt,
        durationMs: s.durationMs,
        status: "completed",
        endedAt: s.endedAt,
        clientId: s.clientId,
        ...(s.devFast ? { devFast: true } : {}),
      });
    }
  },
});

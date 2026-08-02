// Every rule of the local-first timer, as one function over state.
//
// The device that runs a session owns it (docs/adr/0001-local-first-timer.md),
// so these rules are what a user's focus time actually is — no server gets a
// say. They live here, pure, with the clock and id minting handed in, so all of
// them can be exercised as data. `./store` is the one adapter that binds them to
// localStorage, `Date.now` and `crypto.randomUUID`.

import copy from "../copy.json";
import { isProfane } from "../profanity";
import {
  type Category,
  type CategoryOp,
  type LocalState,
  type PendingSession,
  type ServerCategory,
  IDLE_RESET_MS,
  LONG_BREAK_MS,
  MINUTE_MS,
  SESSIONS_PER_CYCLE,
  SHORT_BREAK_MS,
  WORK_MINUTES,
  endAt,
} from "./types";

export type Command =
  /** Finalize whatever is already over. Every other command does this first. */
  | { type: "settle" }
  | { type: "startWork"; categoryClientId: string; minutes: number; fast: boolean }
  | { type: "cancelWork" }
  | { type: "skipBreak" }
  | { type: "createCategory"; name: string; isPublic: boolean }
  | { type: "updateCategory"; clientId: string; name: string; isPublic: boolean }
  | { type: "deleteCategory"; clientId: string }
  | { type: "setServerCategories"; rows: readonly unknown[] }
  | { type: "markSynced"; sessions: readonly PendingSession[]; ops: readonly CategoryOp[] };

/** What the rules need from the world: the clock, and fresh client-minted ids. */
export type Env = { now: number; newId: () => string };

export type Applied = {
  /** The next state — the same reference when nothing changed. */
  state: LocalState;
  /** Why the command did nothing, in user-facing copy. Absent when accepted. */
  rejected?: string;
  /** The new category's clientId, on an accepted `createCategory`. */
  created?: string;
};

/**
 * Run one command. Rejections are returned, not thrown: a rejected command must
 * still keep whatever settling the clock made due, and the caller decides
 * whether the reason is worth showing — most are unreachable by construction
 * (the buttons that would cause them are disabled), but a refused name is not.
 */
export function apply(state: LocalState, command: Command, env: Env): Applied {
  // A session whose end time has passed has already completed, whatever the
  // user is asking for now — so every command sees a settled state.
  const s = settled(state, env);

  switch (command.type) {
    case "settle":
      return { state: s };

    case "startWork": {
      if (!isWorkDuration(command.minutes)) {
        return { state: s, rejected: copy.errors.badDuration };
      }
      if (s.running) return { state: s, rejected: copy.errors.alreadyRunning };
      // An hour with nothing running abandons the cycle: four sessions spread
      // across a day were never one cycle. It is checked on the way into a new
      // session rather than on a timer, because nothing observes it in between.
      const idle = s.cycleCount > 0 && env.now - s.lastActivityAt > IDLE_RESET_MS;
      return {
        state: {
          ...s,
          ...(idle ? { cycleCount: 0 } : {}),
          running: {
            id: env.newId(),
            kind: "work",
            categoryClientId: command.categoryClientId,
            startedAt: env.now,
            durationMs: command.minutes * MINUTE_MS,
            ...(command.fast ? { devFast: true } : {}),
          },
        },
      };
    }

    case "cancelWork":
      if (!s.running || s.running.kind !== "work") {
        return { state: s, rejected: copy.errors.nothingRunning };
      }
      // Voided: no history credit, and the cycle counter is left alone.
      return { state: { ...s, running: null } };

    case "skipBreak":
      if (!s.running || s.running.kind === "work") {
        return { state: s, rejected: copy.errors.noBreakRunning };
      }
      return {
        state: {
          ...s,
          running: null,
          // Skipping the long break still closes the cycle.
          cycleCount: s.running.kind === "longBreak" ? 0 : s.cycleCount,
          lastActivityAt: env.now,
        },
      };

    case "createCategory": {
      const name = validName(command.name);
      if (name === null) return { state: s, rejected: copy.errors.categoryNameLength };
      if (isProfane(name)) return { state: s, rejected: copy.errors.categoryNameProfane };
      const clientId = env.newId();
      return {
        state: queueOp(s, {
          clientId,
          op: "upsert",
          name,
          isPublic: command.isPublic,
          at: env.now,
        }),
        created: clientId,
      };
    }

    case "updateCategory": {
      const name = validName(command.name);
      if (name === null) return { state: s, rejected: copy.errors.categoryNameLength };
      if (isProfane(name)) return { state: s, rejected: copy.errors.categoryNameProfane };
      if (isRunningOn(s, command.clientId)) {
        return { state: s, rejected: copy.errors.categoryBusy };
      }
      return {
        state: queueOp(s, {
          clientId: command.clientId,
          op: "upsert",
          name,
          isPublic: command.isPublic,
          at: env.now,
        }),
      };
    }

    case "deleteCategory":
      if (isRunningOn(s, command.clientId)) {
        return { state: s, rejected: copy.errors.categoryBusy };
      }
      return {
        state: queueOp(s, { clientId: command.clientId, op: "delete", at: env.now }),
      };

    case "setServerCategories": {
      const serverCategories = normalizeServerCategories(command.rows);
      // Cheap deep-equality check keeps reconnect churn from thrashing storage.
      if (JSON.stringify(s.serverCategories) === JSON.stringify(serverCategories)) {
        return { state: s };
      }
      return { state: { ...s, serverCategories } };
    }

    case "markSynced": {
      // Clear exactly what the push delivered; edits made since then survive.
      const sessionIds = new Set(command.sessions.map((x) => x.clientId));
      const opKeys = new Set(command.ops.map((o) => `${o.clientId}:${o.at}`));
      return {
        state: {
          ...s,
          pendingSessions: s.pendingSessions.filter((x) => !sessionIds.has(x.clientId)),
          pendingCategoryOps: s.pendingCategoryOps.filter(
            (o) => !opKeys.has(`${o.clientId}:${o.at}`),
          ),
        },
      };
    }
  }
}

/**
 * Finalize everything whose end time has passed — including whole chains that
 * elapsed while the app was closed: work completes retroactively at its exact
 * end time, its break auto-starts from that moment, and the break may itself
 * already be over.
 *
 * Returns the same reference when nothing was due.
 */
function settled(state: LocalState, env: Env): LocalState {
  let s = state;
  while (s.running && endAt(s.running) <= env.now) {
    const running = s.running;
    const end = endAt(running);
    if (running.kind === "work") {
      const completed: PendingSession = {
        clientId: running.id,
        ...(running.categoryClientId !== null
          ? { categoryClientId: running.categoryClientId }
          : {}),
        startedAt: running.startedAt,
        durationMs: running.durationMs,
        endedAt: end,
        ...(running.devFast ? { devFast: true } : {}),
      };
      const cycleCount = s.cycleCount + 1;
      const isLong = cycleCount >= SESSIONS_PER_CYCLE;
      s = {
        ...s,
        running: {
          id: env.newId(),
          kind: isLong ? "longBreak" : "shortBreak",
          categoryClientId: null,
          startedAt: end,
          durationMs: isLong ? LONG_BREAK_MS : SHORT_BREAK_MS,
          ...(running.devFast ? { devFast: true } : {}),
        },
        cycleCount,
        lastActivityAt: end,
        lastEnded: { id: running.id, kind: "work", at: end },
        pendingSessions: [...s.pendingSessions, completed],
      };
    } else {
      s = {
        ...s,
        running: null,
        cycleCount: running.kind === "longBreak" ? 0 : s.cycleCount,
        lastActivityAt: end,
        lastEnded: { id: running.id, kind: running.kind, at: end },
      };
    }
  }
  return s;
}

function isWorkDuration(minutes: number): boolean {
  return WORK_MINUTES.some((m) => m === minutes);
}

function validName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 40 ? trimmed : null;
}

/** A category cannot be edited out from under the session running on it. */
function isRunningOn(s: LocalState, clientId: string): boolean {
  return s.running?.kind === "work" && s.running.categoryClientId === clientId;
}

function queueOp(s: LocalState, op: CategoryOp): LocalState {
  // One pending op per category: a later edit replaces the queued one.
  return {
    ...s,
    pendingCategoryOps: [
      ...s.pendingCategoryOps.filter((o) => o.clientId !== op.clientId),
      op,
    ],
  };
}

// ---- Reads: the server cache with pending local ops applied on top ----

/**
 * Coerce whatever a server (or an old persisted cache) handed us into rows that
 * are safe to key by clientId. Born of a real incident: a stale backend without
 * clientId in its list response collapsed every category onto the single key
 * `undefined`, leaving one visible. Rows fall back to their Convex _id; rows
 * with no usable key or name are dropped.
 */
export function normalizeServerCategories(rows: readonly unknown[]): ServerCategory[] {
  const out: ServerCategory[] = [];
  for (const value of rows) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    const clientId =
      typeof row.clientId === "string"
        ? row.clientId
        : typeof row._id === "string"
          ? row._id
          : null;
    if (clientId === null || typeof row.name !== "string") continue;
    out.push({
      clientId,
      name: row.name,
      isPublic: row.isPublic !== false,
      updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
    });
  }
  return out;
}

/** The categories the picker shows: the server mirror with local edits on top. */
export function effectiveCategories(state: LocalState): Category[] {
  const byId = new Map<string, Category>();
  // Normalized again on read so a bad cache persisted by an old build still
  // renders correctly, not just future writes.
  for (const c of normalizeServerCategories(state.serverCategories)) {
    byId.set(c.clientId, c);
  }
  for (const op of state.pendingCategoryOps) {
    const existing = byId.get(op.clientId);
    if (existing && existing.updatedAt > op.at) continue; // server already newer
    if (op.op === "delete") {
      byId.delete(op.clientId);
    } else {
      byId.set(op.clientId, {
        clientId: op.clientId,
        name: op.name ?? existing?.name ?? "",
        isPublic: op.isPublic ?? existing?.isPublic ?? true,
        updatedAt: op.at,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "fa"));
}

// Every rule of the local-first timer, as one function over state.
//
// The device that runs a session owns it (docs/adr/0001-local-first-timer.md),
// so these rules are what a user's focus time actually is — no server gets a
// say. They live here, pure, with the clock and id minting handed in, so all of
// them can be exercised as data. `./store` is the one adapter that binds them to
// localStorage, `Date.now` and `crypto.randomUUID`.
//
// Nothing here advances on its own past the end of a session
// (docs/adr/0004-confirmed-transitions.md): sessions end into `ringing` and
// stay there until a human confirms.

import copy from "../copy.json";
import { isProfane } from "../profanity";
import {
  type BreakKind,
  type Category,
  type CategoryOp,
  type LocalState,
  type PendingSession,
  type RangeKey,
  type ServerCategory,
  type Settings,
  AUDIBLE_WINDOW_MS,
  IDLE_RESET_MS,
  MINUTE_MS,
  RANGE_FIELD,
  endAt,
  inRange,
} from "./types";

export type Command =
  /** Finalize whatever is already over. Every other command does this first. */
  | { type: "settle" }
  | { type: "selectCategory"; clientId: string | null }
  | { type: "setSetting"; key: RangeKey; value: number }
  | { type: "startWork"; fast: boolean }
  | { type: "pauseWork" }
  | { type: "resumeWork" }
  /** Acknowledge the ringing session. The only thing that ends a ring. */
  | { type: "confirm" }
  /** Acknowledge a ringing break and go straight back to work on the same task. */
  | { type: "continueWork"; fast: boolean }
  | { type: "cancelWork" }
  | { type: "skipBreak" }
  | { type: "createCategory"; name: string; isPublic: boolean }
  | { type: "updateCategory"; clientId: string; name: string; isPublic: boolean }
  | { type: "deleteCategory"; clientId: string }
  | { type: "setServerCategories"; rows: readonly unknown[] }
  /** Drop the queued items the server acknowledged, and only those. */
  | { type: "markSynced"; sessionIds: readonly string[]; opKeys: readonly string[] };

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
  // A session whose end time has passed is already over, whatever the user is
  // asking for now — so every command sees a settled state.
  const s = settled(state, env);

  switch (command.type) {
    case "settle":
      return { state: s };

    case "selectCategory":
      if (s.selectedCategoryId === command.clientId) return { state: s };
      return { state: { ...s, selectedCategoryId: command.clientId } };

    case "setSetting": {
      if (!inRange(command.key, command.value)) {
        return { state: s, rejected: copy.errors.badDuration };
      }
      const field = RANGE_FIELD[command.key];
      if (s.settings[field] === command.value) return { state: s };
      return { state: { ...s, settings: { ...s.settings, [field]: command.value } } };
    }

    case "startWork": {
      if (s.running) return { state: s, rejected: copy.errors.alreadyRunning };
      if (s.ringing) return { state: s, rejected: copy.errors.confirmFirst };
      if (s.selectedCategoryId === null) {
        return { state: s, rejected: copy.errors.categoryNotFound };
      }
      return { state: begin(s, s.selectedCategoryId, command.fast, env) };
          }

          case "pauseWork": {
            if (!s.running || s.running.kind !== "work") {
              return { state: s, rejected: copy.errors.nothingRunning };
            }
            if (s.running.pausedAt !== null) {
              return { state: s, rejected: "Already paused" };
            }
            return {
              state: {
                ...s,
                running: {
                  ...s.running,
                  pausedAt: env.now,
                },
              },
            };
          }

          case "resumeWork": {
            if (!s.running || s.running.kind !== "work") {
              return { state: s, rejected: copy.errors.nothingRunning };
            }
            if (s.running.pausedAt == null) {
              return { state: s, rejected: "Not paused" };
            }
            const pauseDuration = env.now - (s.running.pausedAt ?? 0);
            return {
              state: {
                ...s,
                running: {
                  ...s.running,
                  pausedAt: null,
                  pausedDurationMs: (s.running.pausedDurationMs || 0) + pauseDuration,
                },
              },
            };
          }

          case "confirm": {
      const ring = s.ringing;
      if (!ring) return { state: s, rejected: copy.errors.nothingRinging };
      // Ring time was rest, so it is spent out of the break rather than added
      // to it. Ring past the whole break and there is nothing left to take.
      if (ring.owedBreak !== null) {
        const remaining = ring.owedBreak.durationMs - (env.now - ring.endedAt);
        if (remaining > 0) {
          return {
            state: {
              ...s,
              ringing: null,
              running: {
                id: env.newId(),
                kind: ring.owedBreak.kind,
                categoryClientId: null,
                startedAt: env.now,
                durationMs: remaining,
                ...(ring.devFast ? { devFast: true } : {}),
              },
            },
          };
        }
      }
      // `lastActivityAt` is deliberately left where the bell put it: a long
      // ring is idleness, and the cycle's 1h reset must be able to see it.
      return { state: { ...s, ringing: null } };
    }

    case "continueWork": {
      const ring = s.ringing;
      if (!ring || ring.kind === "work") {
        return { state: s, rejected: copy.errors.noRingingBreak };
      }
      if (s.selectedCategoryId === null) {
        return { state: s, rejected: copy.errors.categoryNotFound };
      }
      return {
        state: begin(
          { ...s, ringing: null },
          s.selectedCategoryId,
          command.fast,
          env,
        ),
      };
    }

    case "cancelWork":
      if (!s.running || s.running.kind !== "work") {
        return { state: s, rejected: copy.errors.nothingRunning };
      }
      // Voided: no history credit, and the cycle counter is left alone. There
      // is no equivalent once a session is ringing — by then it is already
      // complete, credited, and quite possibly synced.
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

    case "deleteCategory": {
      if (isRunningOn(s, command.clientId)) {
        return { state: s, rejected: copy.errors.categoryBusy };
      }
      const next = queueOp(s, { clientId: command.clientId, op: "delete", at: env.now });
      // A deleted category cannot stay selected, or the start button would be
      // enabled for a task that no longer exists.
      return {
        state:
          next.selectedCategoryId === command.clientId
            ? { ...next, selectedCategoryId: null }
            : next,
      };
    }

    case "setServerCategories": {
      const serverCategories = normalizeServerCategories(command.rows);
      // Cheap deep-equality check keeps reconnect churn from thrashing storage.
      if (JSON.stringify(s.serverCategories) === JSON.stringify(serverCategories)) {
        return { state: s };
      }
      return { state: { ...s, serverCategories } };
    }

    case "markSynced": {
      // Clear exactly what the server acknowledged — never merely what was
      // sent. An item the push carried but the ack omits was not stored, so it
      // stays queued and goes again; edits made since the push survive either
      // way, because an op is keyed by its own timestamp.
      const sessionIds = new Set(command.sessionIds);
      const opKeys = new Set(command.opKeys);
      const pendingSessions = s.pendingSessions.filter((x) => !sessionIds.has(x.clientId));
      const pendingCategoryOps = s.pendingCategoryOps.filter(
        (o) => !opKeys.has(`${o.clientId}:${o.at}`),
      );
      // The same reference back when the ack cleared nothing we still held,
      // and not merely as an optimization: the sync engine re-runs whenever
      // the queue's identity changes, so handing back an equal-but-new array
      // after an empty ack would push, ack nothing, push again — a loop with
      // the server as its clock. An ack that frees nothing must be a no-op.
      if (
        pendingSessions.length === s.pendingSessions.length &&
        pendingCategoryOps.length === s.pendingCategoryOps.length
      ) {
        return { state: s };
      }
      return { state: { ...s, pendingSessions, pendingCategoryOps } };
    }
  }
}

/**
 * Fold the state a device wrote before it knew whose device it was into the
 * state of the account that turned out to own it (`./store`).
 *
 * With nothing stored for that account, the orphan simply *is* its state —
 * including a session still running, which the user is very likely watching
 * count down right now. Otherwise only the queues merge, deduped by the same
 * identities sync uses: the account's own timer is the live one, but unsynced
 * work is unsynced work whoever wrote it.
 */
export function claimOrphaned(
  existing: LocalState | null,
  orphaned: LocalState,
): LocalState {
  if (existing === null) return orphaned;
  const sessionIds = new Set(existing.pendingSessions.map((s) => s.clientId));
  const opKeys = new Set(existing.pendingCategoryOps.map((o) => `${o.clientId}:${o.at}`));
  return {
    ...existing,
    pendingSessions: [
      ...existing.pendingSessions,
      ...orphaned.pendingSessions.filter((s) => !sessionIds.has(s.clientId)),
    ],
    pendingCategoryOps: [
      ...existing.pendingCategoryOps,
      ...orphaned.pendingCategoryOps.filter((o) => !opKeys.has(`${o.clientId}:${o.at}`)),
    ],
  };
}

/**
 * Start a work session on `categoryClientId`, at the configured length.
 *
 * The break lengths ride along on the session: the numbers on screen when you
 * press start govern this whole pomodoro, so editing settings while it runs —
 * or while it rings — cannot change the break it hands you.
 */
function begin(
  s: LocalState,
  categoryClientId: string,
  fast: boolean,
  env: Env,
): LocalState {
  // An hour with nothing running abandons the cycle: four sessions spread
  // across a day were never one cycle. It is checked on the way into a new
  // session rather than on a timer, because nothing observes it in between.
  const idle = s.cycleCount > 0 && env.now - s.lastActivityAt > IDLE_RESET_MS;
  return {
    ...s,
    ...(idle ? { cycleCount: 0 } : {}),
    running: {
      id: env.newId(),
      kind: "work",
      categoryClientId,
      startedAt: env.now,
      durationMs: s.settings.workMinutes * MINUTE_MS,
      shortBreakMs: s.settings.shortBreakMinutes * MINUTE_MS,
      longBreakMs: s.settings.longBreakMinutes * MINUTE_MS,
      pausedAt: null,
      pausedDurationMs: 0,
      ...(fast ? { devFast: true } : {}),
    },
  };
}

/**
 * Finalize the running session if its end time has passed.
 *
 * A session ends into `ringing` and stops there — nothing chains, so at most
 * one transition is ever due, however long the app was closed. A work session
 * is credited at its full nominal duration at its exact end time, whether or
 * not anyone was watching; the ring that follows only decides what happens to
 * the *break*.
 *
 * Returns the same reference when nothing was due.
 */
function settled(state: LocalState, env: Env): LocalState {
  const running = state.running;
  if (!running || endAt(running, env.now) > env.now) return state;

  const end = endAt(running, env.now);
  // Decided once, here, and never revisited: within the window the app was
  // there to hear the bell; outside it, this is a ring being discovered on a
  // launch long afterwards.
  const audible = env.now - end <= AUDIBLE_WINDOW_MS;
  const devFast = running.devFast ? { devFast: true as const } : {};

  if (running.kind !== "work") {
    return {
      ...state,
      running: null,
      // The cycle closes when the long break is over, not when it is confirmed.
      cycleCount: running.kind === "longBreak" ? 0 : state.cycleCount,
      lastActivityAt: end,
      ringing: {
        id: running.id,
        kind: running.kind,
        categoryClientId: null,
        endedAt: end,
        owedBreak: null,
        audible,
        ...devFast,
      },
    };
  }

  const completed: PendingSession = {
    clientId: running.id,
    ...(running.categoryClientId !== null
      ? { categoryClientId: running.categoryClientId }
      : {}),
    startedAt: running.startedAt,
    durationMs: running.durationMs,
    endedAt: end,
    ...devFast,
  };
  const cycleCount = state.cycleCount + 1;
  // Pomodoros-per-cycle is the one interval that is *not* snapshotted: it
  // describes the cycle rather than any one session, so a change applies to
  // the very next completion.
  const isLong = cycleCount >= state.settings.perCycle;
  const kind: BreakKind = isLong ? "longBreak" : "shortBreak";
  return {
    ...state,
    running: null,
    cycleCount,
    lastActivityAt: end,
    pendingSessions: [...state.pendingSessions, completed],
    ringing: {
      id: running.id,
      kind: "work",
      categoryClientId: running.categoryClientId,
      endedAt: end,
      owedBreak: { kind, durationMs: owedBreakMs(running, isLong, state.settings) },
      audible,
      ...devFast,
    },
  };
}

/**
 * The break this session owes. Read off the session itself, falling back to
 * the current settings for sessions started before the lengths were carried
 * along — a blob persisted by an older build.
 */
function owedBreakMs(
  running: { shortBreakMs?: number; longBreakMs?: number },
  isLong: boolean,
  settings: Settings,
): number {
  const carried = isLong ? running.longBreakMs : running.shortBreakMs;
  if (typeof carried === "number") return carried;
  return (isLong ? settings.longBreakMinutes : settings.shortBreakMinutes) * MINUTE_MS;
}

/** How much of the owed break survives the ring, or 0 if the ring ate it. */
export function breakAfterRing(
  ring: { endedAt: number; owedBreak: { durationMs: number } | null },
  now: number,
): number {
  if (ring.owedBreak === null) return 0;
  return Math.max(0, ring.owedBreak.durationMs - (now - ring.endedAt));
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

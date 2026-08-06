// The local-first timer's state (docs/adr/0001-local-first-timer.md): the
// device owns the running session; everything here lives in localStorage,
// keyed by username, and the pending* queues drain to Convex on sync.
//
// Transitions are confirmed, never automatic
// (docs/adr/0004-confirmed-transitions.md): a session that reaches its end
// does not advance into the next one — it starts *ringing* and waits.

export type SessionKind = "work" | "shortBreak" | "longBreak";
export type BreakKind = Exclude<SessionKind, "work">;

export type RunningSession = {
  id: string; // client-minted uuid; becomes the log row's clientId
  kind: SessionKind;
  categoryClientId: string | null; // null on breaks
  startedAt: number;
  durationMs: number; // nominal; a devFast session really ends after 3s
  devFast?: boolean;
  /** When the session was paused, or null if running. */
  pausedAt?: number | null;
  /** Total paused duration accumulated so far (ms). */
  pausedDurationMs?: number;
  // The break lengths this work session owes, snapshotted at start so that
  // editing settings mid-session cannot change the break it hands you. Both
  // are carried because which one is owed depends on the cycle counter at
  // completion, and pomodoros-per-cycle is deliberately *not* snapshotted.
  shortBreakMs?: number;
  longBreakMs?: number;
};

/**
 * A session that has reached its end and is waiting to be acknowledged.
 *
 * The session itself is already over: a work session is credited at its full
 * nominal duration the moment it ends, before anyone taps anything. Ring time
 * is not focus time and never becomes any — all it does is eat into the break
 * that follows, on the grounds that time spent away from the desk was rest
 * whether or not it was labelled as such.
 */
export type Ringing = {
  id: string; // the id of the session that ended
  kind: SessionKind;
  categoryClientId: string | null;
  /** The session's nominal end — the moment the bell rang. */
  endedAt: number;
  /** The break owed on confirmation. Null when a break is what is ringing. */
  owedBreak: { kind: BreakKind; durationMs: number } | null;
  /**
   * Whether this ring makes a sound, decided once when it was born and never
   * revisited: a ring the app was present for keeps ringing for as long as it
   * takes, and a ring discovered on launch hours later never makes a sound.
   */
  audible: boolean;
  devFast?: boolean;
};

/** A completed work session waiting to be reported to the server. */
export type PendingSession = {
  clientId: string;
  categoryClientId?: string;
  startedAt: number;
  durationMs: number;
  endedAt: number;
  devFast?: boolean;
};

/** A category edit waiting to be reported. One op per category: later edits replace earlier ones. */
export type CategoryOp = {
  clientId: string;
  op: "upsert" | "delete";
  name?: string;
  isPublic?: boolean;
  at: number; // edit timestamp, for last-write-wins on the server
};

/** The server's view of a category, cached for offline use. */
export type ServerCategory = {
  clientId: string;
  name: string;
  isPublic: boolean;
  updatedAt: number;
};

/** ServerCategory with pending local ops applied on top. */
export type Category = ServerCategory;

/**
 * The intervals, in minutes. Device-local and never synced: the device owns
 * the timer (ADR 0001), and these durations *are* the timer. Two devices may
 * legitimately disagree about what a pomodoro is.
 */
export type Settings = {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  perCycle: number;
};

export type LocalState = {
  running: RunningSession | null;
  ringing: Ringing | null;
  cycleCount: number;
  // Last time a session/break ended — drives the 1h idle cycle reset. Stamped
  // at the nominal end, never at confirmation, so a long ring counts as the
  // idleness it was.
  lastActivityAt: number;
  settings: Settings;
  // The picked task and chosen length, persisted rather than held in React,
  // so a reload mid-session leaves you exactly where you were.
  selectedCategoryId: string | null;
  pendingSessions: PendingSession[];
  pendingCategoryOps: CategoryOp[];
  serverCategories: ServerCategory[];
};

export const MINUTE_MS = 60_000;

/** The classic technique: 25/5/20, long break every 4th pomodoro. */
export const DEFAULT_SETTINGS: Settings = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 20,
  perCycle: 4,
};

/**
 * What each setting may be set to. The bands keep the app near the technique
 * without pretending the numbers are sacred; the defaults above are the
 * technique itself.
 *
 * `work.max` is coupled to `MAX_SESSION_MS` in `lib/presence.ts`, which
 * refuses to advertise anything longer than 60 minutes. Raise one and the
 * other must move or the feed silently drops the session.
 */
export const RANGES = {
  work: { min: 15, max: 60, step: 5 },
  shortBreak: { min: 3, max: 15, step: 1 },
  longBreak: { min: 10, max: 35, step: 5 },
  perCycle: { min: 2, max: 6, step: 1 },
} as const;

export type RangeKey = keyof typeof RANGES;

/** The `Settings` field each range governs. */
export const RANGE_FIELD: Record<RangeKey, keyof Settings> = {
  work: "workMinutes",
  shortBreak: "shortBreakMinutes",
  longBreak: "longBreakMinutes",
  perCycle: "perCycle",
};

/** Is `value` a legal stop on this range's grid? */
export function inRange(key: RangeKey, value: number): boolean {
  const { min, max, step } = RANGES[key];
  return (
    Number.isInteger(value) && value >= min && value <= max && (value - min) % step === 0
  );
}

/**
 * Could the timer legitimately have produced a session of this length?
 *
 * Shared with the server, which re-checks it in `sync.push` because the
 * pending queue is editable localStorage. The old check was an exact match
 * against 25 or 55; both are still stops on the work grid, so history predating
 * configurable intervals continues to validate.
 */
export function isWorkDurationMs(durationMs: number): boolean {
  return durationMs % MINUTE_MS === 0 && inRange("work", durationMs / MINUTE_MS);
}

/** The next stop up or down, or null at the end of the range. */
export function stepValue(key: RangeKey, value: number, direction: 1 | -1): number | null {
  const { min, max, step } = RANGES[key];
  const next = value + direction * step;
  return next >= min && next <= max ? next : null;
}

export const IDLE_RESET_MS = 60 * MINUTE_MS;
// A ring born more than this long after the bell never makes a sound: the app
// was not there to hear it, and a siren for yesterday teaches distrust.
export const AUDIBLE_WINDOW_MS = 60_000;
// Dev-only fast sessions: credited at nominal duration, really end after this.
export const FAST_MS = 3_000;

/** The wall-clock moment a running session actually ends. */
export function endAt(running: RunningSession, now: number): number {
  // Time spent paused (accumulated on resume, plus the in-progress pause).
  const pausedNow = running.pausedAt != null ? now - running.pausedAt : 0;
  const totalPause = (running.pausedDurationMs ?? 0) + pausedNow;
  // The end shifts forward by every paused millisecond, so the countdown
  // holds steady while paused and resumes where it left off.
  const base = running.devFast ? FAST_MS : running.durationMs;
  return running.startedAt + base + totalPause;
}

export const EMPTY_STATE: LocalState = {
  running: null,
  ringing: null,
  cycleCount: 0,
  lastActivityAt: 0,
  settings: DEFAULT_SETTINGS,
  selectedCategoryId: null,
  pendingSessions: [],
  pendingCategoryOps: [],
  serverCategories: [],
};

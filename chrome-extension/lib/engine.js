// Pure timer engine — shared by the popup and the background service worker.
// Mirrors the local-first model from the web app's SPEC.md: startedAt + duration
// own the truth, nothing advances on its own, only an explicit confirm clears a ring.

export const DEFAULT_SETTINGS = {
  work: 25,
  short: 5,
  long: 20,
  perCycle: 4,
};

export const RANGES = {
  work: { min: 15, max: 60, step: 5 },
  short: { min: 3, max: 15, step: 1 },
  long: { min: 10, max: 35, step: 5 },
  perCycle: { min: 2, max: 6, step: 1 },
};

export const IDLE_RESET_MS = 60 * 60 * 1000;
export const RING_AUDIBLE_WINDOW_MS = 60 * 1000;

export function initialState() {
  return {
    phase: "idle", // idle | work-running | work-ringing | break-running | break-ringing
    startedAt: null,
    duration: null, // ms
    nominalEnd: null, // ms epoch — the moment this leg was due to end
    ringSince: null, // ms epoch — when the current ring was born
    audible: false,
    categoryId: null,
    workMinutes: DEFAULT_SETTINGS.work,
    breakKind: null, // 'short' | 'long' — decided when a work session rings
    breakDuration: null, // ms — frozen break length for the session in flight
    cycleCount: 0,
    lastNominalEnd: null, // for the 1h idleness reset
  };
}

function clamp(n, { min, max, step }) {
  const snapped = Math.round((n - min) / step) * step + min;
  return Math.min(max, Math.max(min, snapped));
}

export function clampSettings(raw) {
  return {
    work: clamp(raw.work ?? DEFAULT_SETTINGS.work, RANGES.work),
    short: clamp(raw.short ?? DEFAULT_SETTINGS.short, RANGES.short),
    long: clamp(raw.long ?? DEFAULT_SETTINGS.long, RANGES.long),
    perCycle: clamp(raw.perCycle ?? DEFAULT_SETTINGS.perCycle, RANGES.perCycle),
  };
}

// Advances state purely based on wall-clock time — call on every popup open
// and on every background alarm tick. Returns a NEW state object (or the same
// one if nothing changed) plus a list of side-effect events to perform.
export function tick(state, now) {
  const events = [];

  if (state.phase === "work-running" && now >= state.nominalEnd) {
    const ringSince = state.nominalEnd;
    const audible = now - state.nominalEnd < RING_AUDIBLE_WINDOW_MS;
    const cycleCount = state.cycleCount + 1;
    const breakKind =
      cycleCount % (state.perCycleAtRing ?? DEFAULT_SETTINGS.perCycle) === 0
        ? "long"
        : "short";
    const breakDuration =
      (breakKind === "long" ? state.longAtStart : state.shortAtStart) * 60 * 1000;
    events.push({ type: "work-ring", audible });
    return [
      {
        ...state,
        phase: "work-ringing",
        ringSince,
        audible,
        cycleCount,
        breakKind,
        breakDuration,
        lastNominalEnd: state.nominalEnd,
      },
      events,
    ];
  }

  if (state.phase === "break-running" && now >= state.nominalEnd) {
    const ringSince = state.nominalEnd;
    const audible = now - state.nominalEnd < RING_AUDIBLE_WINDOW_MS;
    events.push({ type: "break-ring", audible });
    return [
      {
        ...state,
        phase: "break-ringing",
        ringSince,
        audible,
        lastNominalEnd: state.nominalEnd,
      },
      events,
    ];
  }

  return [state, events];
}

export function startWork(state, settings, { categoryId, workMinutes }) {
  const now = Date.now();
  const idleFor = state.lastNominalEnd ? now - state.lastNominalEnd : Infinity;
  const cycleCount = idleFor > IDLE_RESET_MS ? 0 : state.cycleCount;
  const duration = workMinutes * 60 * 1000;
  return {
    ...state,
    phase: "work-running",
    startedAt: now,
    duration,
    nominalEnd: now + duration,
    ringSince: null,
    audible: false,
    categoryId,
    workMinutes,
    cycleCount,
    perCycleAtRing: settings.perCycle,
    shortAtStart: settings.short,
    longAtStart: settings.long,
  };
}

export function cancelWork(state) {
  if (state.phase !== "work-running") return state;
  return { ...state, phase: "idle", startedAt: null, duration: null, nominalEnd: null };
}

export function skipBreak(state) {
  if (state.phase !== "break-running") return state;
  const cycleCount = state.breakKind === "long" ? 0 : state.cycleCount;
  return {
    ...state,
    phase: "idle",
    startedAt: null,
    duration: null,
    nominalEnd: null,
    cycleCount,
  };
}

// Confirm a work ring: starts (what's left of) the break, or goes straight to
// idle if the ring itself ate the whole break.
export function confirmWorkRing(state) {
  if (state.phase !== "work-ringing") return state;
  const now = Date.now();
  const elapsedRing = now - state.ringSince;
  const remaining = state.breakDuration - elapsedRing;
  if (remaining <= 0) {
    return { ...state, phase: "idle", startedAt: null, duration: null, nominalEnd: null };
  }
  return {
    ...state,
    phase: "break-running",
    startedAt: state.ringSince,
    duration: state.breakDuration,
    nominalEnd: state.ringSince + state.breakDuration,
    ringSince: null,
    audible: false,
  };
}

export function confirmBreakRing(state, choice) {
  if (state.phase !== "break-ringing") return state;
  const cycleCount = state.breakKind === "long" ? 0 : state.cycleCount;
  if (choice === "continue") {
    const now = Date.now();
    const duration = state.workMinutes * 60 * 1000;
    return {
      ...state,
      phase: "work-running",
      startedAt: now,
      duration,
      nominalEnd: now + duration,
      ringSince: null,
      audible: false,
      cycleCount,
    };
  }
  return {
    ...state,
    phase: "idle",
    startedAt: null,
    duration: null,
    nominalEnd: null,
    cycleCount,
  };
}

export function remainingMs(state, now) {
  if (!state.nominalEnd) return 0;
  if (state.phase === "work-ringing" || state.phase === "break-ringing") {
    return now - state.ringSince; // counting UP while ringing
  }
  return Math.max(0, state.nominalEnd - now);
}

export function elapsedShare(state, now) {
  if (!state.startedAt || !state.duration) return 0;
  return Math.min(1, (now - state.startedAt) / state.duration);
}

export function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  const toFa = (n) => n.toString().padStart(2, "0").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
  return `${toFa(m)}:${toFa(s)}`;
}

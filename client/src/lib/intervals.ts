/**
 * What a break is worth, and how many pomodoros make a set.
 *
 * These live on the account rather than on this device — the server owns the
 * timer, so it owns these — which is why there is no `usePersisted` here and no
 * default worth caching: the values arrive with the timer state, and the shapes
 * below only describe what may be asked for.
 *
 * The pomodoro's own length is deliberately not one of them. It stays on the
 * start screen, where it genuinely is a per-session decision.
 */

export type Intervals = {
  shortBreakMs: number;
  longBreakMs: number;
  /** How many pomodoros until the long break. */
  perCycle: number;
};

const MINUTE = 60_000;

/** The classic technique, and what a fresh account is. */
export const CLASSIC: Intervals = {
  shortBreakMs: 5 * MINUTE,
  longBreakMs: 20 * MINUTE,
  perCycle: 4,
};

/**
 * The band each interval may be drawn from, and the step it moves in — the same
 * bands the server refuses anything outside of, so nothing a stepper can
 * produce can be rejected.
 *
 * Breaks are in minutes here rather than milliseconds, because that is the unit
 * the row is read in and the unit the band is legible in. The conversion
 * happens at the edge, in `step`.
 */
export const BANDS = {
  shortBreakMs: { min: 3, max: 15, step: 1 },
  longBreakMs: { min: 10, max: 35, step: 5 },
  perCycle: { min: 2, max: 6, step: 1 },
} as const;

export type IntervalKey = keyof typeof BANDS;

/** Whether a field is measured in minutes rather than counted. */
const isDuration = (key: IntervalKey) => key !== "perCycle";

/** An interval as the stepper shows it: minutes for the breaks, a count otherwise. */
export function shown(intervals: Intervals, key: IntervalKey): number {
  return isDuration(key) ? intervals[key] / MINUTE : intervals[key];
}

/**
 * The next stop up or down, or `null` at the end of the band — which is what
 * disables the button rather than letting it silently do nothing, so the range
 * is visible instead of being something you discover by pressing.
 */
export function step(
  intervals: Intervals,
  key: IntervalKey,
  direction: 1 | -1,
): Intervals | null {
  const band = BANDS[key];
  const next = shown(intervals, key) + direction * band.step;
  if (next < band.min || next > band.max) return null;
  return { ...intervals, [key]: isDuration(key) ? next * MINUTE : next };
}

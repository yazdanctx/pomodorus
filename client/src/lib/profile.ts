/**
 * One person's public page: their handle, and their focus time per Tehran day.
 *
 * Public and read-only. A profile is a link somebody sent to somebody else, so
 * nothing here needs an account and nothing here is pushed — a chart of days
 * that are already over does not change while you look at it.
 */

import { useCallback, useEffect, useState } from "react";

import { ApiError, get, type ServerTimed } from "@/lib/api";

/**
 * One row of a day's detail.
 *
 * `name` is null for the two rows that have none: a stranger's view of all the
 * private tasks at once, and work recorded against no task at all. They are
 * not the same row and they do not read the same — one is masking something
 * and the other is not — so the kind is carried rather than inferred from the
 * missing name.
 */
export type DayTask = {
  kind: "task" | "private" | "none";
  name: string | null;
  totalMs: number;
};

/** One column: a Tehran day, what was credited in it, and what of. */
export type ChartDay = {
  /** `YYYY-MM-DD` in Tehran. A day is a name, not an instant. */
  day: string;
  totalMs: number;
  /** Largest first, and empty on a day with nothing in it. */
  tasks: DayTask[];
};

/** The three presets. There is no custom picker, by design. */
export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = 7;

type ProfilePayload = ServerTimed & {
  handle: string;
  days: ChartDay[];
  everFocused: boolean;
  owner: boolean;
};

export type ProfileValue = {
  /** The canonical handle, which may differ in case from the one in the URL. */
  handle: string | undefined;
  /** `undefined` while the chart is being fetched — including on a range change. */
  days: ChartDay[] | undefined;
  /** Whether the person exists at all, once that is known. */
  missing: boolean;
  /**
   * Whether they have ever finished a pomodoro.
   *
   * Not the same as an empty range: a week off is a flat line, and drawing it
   * is the whole reason the days are zero-filled. Only somebody who has never
   * focused at all gets the empty state.
   */
  everFocused: boolean;
  /**
   * Whether the server is showing this reader the real task names, which it
   * does only on their own profile. Said out loud on the page rather than
   * inferred from the handle: only the server knows whose cookie this is, and
   * seeing your private tasks named is exactly the moment you might think
   * strangers can too.
   */
  owner: boolean;
  /** The read failed for a reason that is not "no such person". */
  failed: boolean;
};

export function useProfile(handle: string, range: Range): ProfileValue {
  const [profile, setProfile] = useState<ProfilePayload | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  // Bumped on every range change so the chart area can fall back to a skeleton
  // while the shell — the heading and the range buttons — stays exactly where
  // it is. Switching range must not make the page jump.
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const payload = await get<ProfilePayload>(
        `/api/profile/${encodeURIComponent(handle)}?days=${range}`,
      );
      setProfile(payload);
      setMissing(false);
    } catch (failure) {
      // A handle nobody has is its own state: the page says so rather than
      // drawing a flat line for a person who does not exist.
      if (failure instanceof ApiError && failure.status === 404) {
        setProfile(undefined);
        setMissing(true);
        return;
      }
      // Anything else is said out loud rather than left as a skeleton pulsing
      // forever. A placeholder that never resolves is the app pretending to
      // still be working on something it has given up on.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [handle, range]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    handle: profile?.handle,
    days: loading || failed ? undefined : profile?.days,
    everFocused: profile?.everFocused ?? false,
    owner: profile?.owner ?? false,
    missing,
    failed,
  };
}

/** Which day the chart marks, and the detail docked below it. */
export type Selection = {
  /** Always a day in the range, so the chart has something to mark. */
  day: string;
  /**
   * The day's detail, or undefined when the marked day is empty. The chart is
   * zero-filled, so a flat stretch can still be pointed at — and such a day
   * gets no panel at all rather than ۰:۰۰ over an empty list.
   */
  detail: ChartDay | undefined;
};

/**
 * The day the profile is showing: the one being pointed at, or the most recent
 * one with anything in it.
 *
 * Null when no day in the range has any focus time — a week off is a flat line
 * and nothing more, with no marker on it and nothing docked below.
 */
export function selectDay(
  days: ChartDay[],
  pointed: string | null,
): Selection | null {
  const latest = lastDayWithFocus(days);
  if (latest === undefined) return null;

  // Pointing wins while it lands inside the range; otherwise the panel rests
  // on the most recent day that has data, which is what the page opens on.
  const day =
    pointed !== null && days.some((column) => column.day === pointed)
      ? pointed
      : latest.day;

  const marked = days.find((column) => column.day === day);
  return { day, detail: marked !== undefined && marked.totalMs > 0 ? marked : undefined };
}

/** The most recent day carrying focus time. `days` is oldest first. */
function lastDayWithFocus(days: ChartDay[]): ChartDay | undefined {
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (day !== undefined && day.totalMs > 0) return day;
  }
  return undefined;
}

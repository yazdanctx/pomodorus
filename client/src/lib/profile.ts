/**
 * One person's public page: their handle, and their focus time per Tehran day.
 *
 * Public and read-only. A profile is a link somebody sent to somebody else, so
 * nothing here needs an account and nothing here is pushed — a chart of days
 * that are already over does not change while you look at it.
 */

import { useCallback, useEffect, useState } from "react";

import { ApiError, get, type ServerTimed } from "@/lib/api";

/** One column: a Tehran day, and what was credited in it. */
export type ChartDay = {
  /** `YYYY-MM-DD` in Tehran. A day is a name, not an instant. */
  day: string;
  totalMs: number;
};

/** The three presets. There is no custom picker, by design. */
export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = 7;

type ProfilePayload = ServerTimed & {
  handle: string;
  days: ChartDay[];
  everFocused: boolean;
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
    missing,
    failed,
  };
}

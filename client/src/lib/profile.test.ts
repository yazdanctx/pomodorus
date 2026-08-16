import { describe, expect, it } from "vitest";

import { selectDay, type ChartDay } from "@/lib/profile";

/** A column, with a single task's worth of work in it when it has any. */
function day(key: string, totalMs: number): ChartDay {
  return {
    day: key,
    totalMs,
    tasks: totalMs > 0 ? [{ kind: "task", name: "درس", totalMs }] : [],
  };
}

const WEEK: ChartDay[] = [
  day("2026-03-09", 0),
  day("2026-03-10", 25 * 60_000),
  day("2026-03-11", 0),
  day("2026-03-12", 50 * 60_000),
  day("2026-03-13", 0),
  day("2026-03-14", 0),
  day("2026-03-15", 0),
];

describe("the day the profile shows", () => {
  it("opens on the most recent day with anything in it", () => {
    // Not the last column — that is today, and today may be a day off. The
    // page opens on the last thing there is to say.
    expect(selectDay(WEEK, null)?.day).toBe("2026-03-12");
  });

  it("follows the day being pointed at", () => {
    const selected = selectDay(WEEK, "2026-03-10");
    expect(selected?.day).toBe("2026-03-10");
    expect(selected?.detail?.totalMs).toBe(25 * 60_000);
  });

  it("marks a day with nothing in it, and docks no detail under it", () => {
    // The chart is zero-filled, so a flat stretch can still be pointed at. The
    // marker follows the finger; the panel is simply not rendered, rather than
    // showing ۰:۰۰ over an empty list.
    const selected = selectDay(WEEK, "2026-03-13");
    expect(selected?.day).toBe("2026-03-13");
    expect(selected?.detail).toBeUndefined();
  });

  it("ignores a day that is not in the range", () => {
    // A range switch can leave the pointed-at day outside the chart. The panel
    // falls back to where the page opens rather than showing nothing.
    expect(selectDay(WEEK, "2025-01-01")?.day).toBe("2026-03-12");
  });

  it("selects nothing at all when no day has anything", () => {
    // A week off is a flat line and nothing more: no marker, no panel.
    expect(selectDay([day("2026-03-14", 0), day("2026-03-15", 0)], null)).toBeNull();
  });
});

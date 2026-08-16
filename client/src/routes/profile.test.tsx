import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Auth } from "@/lib/auth";
import { copy, t } from "@/lib/copy";
import { faDate, faDateShort, faDigits, faDuration, faHourClock } from "@/lib/format";
import { ProfileRoute } from "@/routes/profile";
import { renderAt } from "@/test/render";

const NOW = 1_800_000_000_000;

type Task = { kind: "task" | "private" | "none"; name: string | null; totalMs: number };
type Day = { day: string; totalMs: number; tasks: Task[] };

/** One row of a day's detail, the way the server sends one. */
function task(name: string, totalMs: number): Task {
  return { kind: "task", name, totalMs };
}

/** The masked row: every private task at once, with no name to send. */
function masked(totalMs: number): Task {
  return { kind: "private", name: null, totalMs };
}

/**
 * `days` columns ending on the last of them, all empty unless said otherwise.
 *
 * A day is given either a total — which becomes one task's worth of work — or
 * the rows it is made of, which is what the detail is actually about.
 */
function chart(days: number, worked: Record<string, number | Task[]> = {}): Day[] {
  const out: Day[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const at = new Date(Date.UTC(2026, 2, 15) - i * 86_400_000);
    const day = at.toISOString().slice(0, 10);
    const of = worked[day] ?? 0;
    const tasks = typeof of === "number" ? (of > 0 ? [task("درس", of)] : []) : of;
    out.push({ day, totalMs: tasks.reduce((sum, row) => sum + row.totalMs, 0), tasks });
  }
  return out;
}

/**
 * The seam is `fetch`. The route is fed server payloads and the assertion is
 * what is on screen.
 */
function server({
  handle = "yazdan",
  days = chart(7, { "2026-03-15": 75 * 60_000 }),
  everFocused = true,
  owner = false,
  status = 200,
  hold = false,
}: {
  handle?: string;
  days?: Day[];
  everFocused?: boolean;
  owner?: boolean;
  status?: number;
  hold?: boolean;
} = {}) {
  const asked: string[] = [];
  const fetched = vi.fn(async (input: string) => {
    asked.push(input);
    if (hold) return new Promise<Response>(() => {});
    if (status !== 200) {
      return new Response(JSON.stringify({ error: "profile_not_found", serverNow: NOW }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ handle, days, everFocused, owner, serverNow: NOW }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetched);
  return { asked, fetched };
}

const renderProfile = (handle = "yazdan", auth: Auth = { status: "anonymous" }) =>
  renderAt(<ProfileRoute />, { path: `/u/${handle}`, auth });

/**
 * jsdom does no layout, so every box measures zero and the responsive wrapper
 * would render an empty chart there is nothing to assert about. This stands in
 * for the one thing the chart actually needs from a browser: a size.
 *
 * The suite-wide stub in test/setup.ts is a no-op, which is right for cmdk —
 * it observes a list to keep a selection in view, which needs a viewport to
 * mean anything. recharts genuinely reads the number, so this one reports one.
 */
const CHART_BOX = { width: 600, height: 176 };

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly notify: ResizeObserverCallback) {}
      observe(target: Element) {
        this.notify(
          [{ target, contentRect: { ...CHART_BOX, top: 0, left: 0, bottom: 176, right: 600, x: 0, y: 0 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("a public profile", () => {
  it("reads without signing in, and names whose it is", async () => {
    server();
    renderProfile();

    // A link somebody sent: no account, and the handle in Latin type.
    const heading = await screen.findByRole("heading", { name: "yazdan" });
    expect(heading.className).toContain("ui-sans-serif");
  });

  it("shows the canonical handle, not the one in the URL", async () => {
    server({ handle: "yazdan" });
    renderProfile("YaZdAn");

    await screen.findByRole("heading", { name: "yazdan" });
  });

  it("heads your own profile differently, and offers the way out", async () => {
    server();
    renderProfile("yazdan", { status: "authenticated", handle: "yazdan" });

    await screen.findByRole("heading", { name: copy.profile.title });
    expect(screen.getByRole("button", { name: new RegExp(copy.header.signOut) })).toBeTruthy();
  });

  it("offers no way out on somebody else's profile", async () => {
    server({ handle: "someone" });
    renderProfile("someone", { status: "authenticated", handle: "yazdan" });

    await screen.findByRole("heading", { name: "someone" });
    expect(screen.queryByRole("button", { name: new RegExp(copy.header.signOut) })).toBeNull();
  });

  it("says so when nobody has that handle", async () => {
    server({ status: 404 });
    renderProfile("nobody");

    // Not an empty chart: a flat line for somebody who does not exist would
    // read as a real person who never worked.
    await screen.findByText(copy.profile.notFound);
    expect(screen.queryByRole("heading", { name: copy.profile.focusPerDay })).toBeNull();
  });

  it("shows the empty state for somebody who has never focused", async () => {
    server({ days: chart(7), everFocused: false });
    renderProfile();

    await screen.findByText(copy.profile.emptyTitle);
  });

  it("draws a flat line for a week off, rather than calling the profile empty", async () => {
    // Somebody with a history who did nothing in the selected range. The
    // zero-fill exists to draw exactly this; telling them their profile is
    // empty would be the chart making a claim about them, not about the week.
    server({ days: chart(7), everFocused: true });
    const { container } = renderProfile();

    await waitFor(() => expect(container.querySelector("svg")).toBeTruthy());
    expect(screen.queryByText(copy.profile.emptyTitle)).toBeNull();
  });

  it("says so when the read fails, rather than pulsing forever", async () => {
    // A skeleton that never resolves is the app pretending to still be working
    // on something it has given up on.
    server({ status: 500 });
    const { container } = renderProfile();

    await screen.findByText(copy.login.serverError);
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });
});

describe("the range presets", () => {
  it("offers three and opens on seven days", async () => {
    const { asked } = server();
    renderProfile();

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toContain("days=7");

    for (const days of [7, 30, 90]) {
      expect(
        screen.getByRole("button", { name: t(copy.profile.rangeDays, { n: faDigits(days) }) }),
      ).toBeTruthy();
    }
    // And says which one is on, since there is no hue to mark it with.
    const seven = screen.getByRole("button", {
      name: t(copy.profile.rangeDays, { n: faDigits(7) }),
    });
    expect(seven.getAttribute("aria-pressed")).toBe("true");
  });

  it("asks for the range that was pressed", async () => {
    const { asked } = server();
    renderProfile();

    await waitFor(() => expect(asked).toHaveLength(1));
    await userEvent.click(
      screen.getByRole("button", { name: t(copy.profile.rangeDays, { n: faDigits(90) }) }),
    );

    await waitFor(() => expect(asked[asked.length - 1]).toContain("days=90"));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: t(copy.profile.rangeDays, { n: faDigits(90) }) })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("keeps the shell and falls back only where the chart is", async () => {
    const { fetched } = server();
    const { container } = renderProfile();

    await screen.findByRole("heading", { name: copy.profile.focusPerDay });

    // Hold the next answer open, then switch range.
    fetched.mockImplementation(() => new Promise<Response>(() => {}));
    await userEvent.click(
      screen.getByRole("button", { name: t(copy.profile.rangeDays, { n: faDigits(30) }) }),
    );

    // The heading and the buttons have not moved; only the chart area is a
    // skeleton. Switching range must not reflow the page under the finger
    // that pressed it.
    await waitFor(() => expect(container.querySelector(".h-44.animate-pulse")).toBeTruthy());
    expect(screen.getByRole("heading", { name: copy.profile.focusPerDay })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t(copy.profile.rangeDays, { n: faDigits(30) }) }),
    ).toBeTruthy();
  });
});

describe("the focus chart", () => {
  it("draws a line of daily totals", async () => {
    server();
    const { container } = renderProfile();

    await waitFor(() => expect(container.querySelector("svg")).toBeTruthy());
    // One series, one line. No legend, because the heading names it.
    await waitFor(() =>
      expect(container.querySelectorAll("path.recharts-line-curve").length).toBe(1),
    );
  });

  it("labels the axis in Jalali, short form", async () => {
    server();
    const { container } = renderProfile();

    await waitFor(() => expect(container.querySelector(".recharts-xAxis")).toBeTruthy());

    // «۲۴ اسفند» — day and month, no year, in Persian digits. Read off the
    // rendered SVG text rather than a scoped query, because recharts puts the
    // labels in a sibling group of the axis element itself.
    const ticks = () =>
      [...container.querySelectorAll("text")].map((node) => node.textContent);
    await waitFor(() => expect(ticks()).toContain(faDateShort("2026-03-15")));
    // The short form: a year on every tick would not fit and would not help.
    expect(ticks().join(" ")).not.toContain("۱۴۰۴");
  });

  it("runs time left to right inside the right-to-left page", async () => {
    server();
    const { container } = renderProfile();

    await waitFor(() => expect(container.querySelector("svg")).toBeTruthy());
    // A chart that ran the other way would put today where the eye looks for
    // the oldest day.
    expect(container.querySelector('[dir="ltr"]')).toBeTruthy();
  });
});

describe("the day detail", () => {
  it("docks below the chart, opened on the most recent day with data", async () => {
    server({
      days: chart(7, {
        "2026-03-13": 75 * 60_000,
        // Nothing on the 14th or the 15th: the page opens on the last thing
        // there is to say, not on today.
      }),
    });
    renderProfile();

    // The header: the Jalali date above, the total as a clock, the caption
    // below it — so the bare number is never left to stand for itself.
    await screen.findByText(faDate("2026-03-13"));
    expect(screen.getByText(faHourClock(75 * 60_000))).toBeTruthy();
    expect(screen.getByText(copy.profile.focusedHours)).toBeTruthy();
  });

  it("puts a picture beside the total, and keeps it there", async () => {
    server({ days: chart(7, { "2026-03-15": 75 * 60_000 }) });
    const { container } = renderProfile();

    await screen.findByText(copy.profile.focusedHours);
    const image = container.querySelector("img");
    // Decoration, so it is not announced: the day is already spelled out
    // beside it in words.
    expect(image?.getAttribute("alt")).toBe("");
    expect(image?.getAttribute("src")).toBeTruthy();
  });

  it("lists the tasks as they were sent, each with its share of the day", async () => {
    // Largest first is the server's answer — it is the one that knows what a
    // day was made of — and the panel does not second-guess the order.
    server({
      days: chart(7, {
        "2026-03-15": [task("ریاضی", 75 * 60_000), task("درس", 25 * 60_000)],
      }),
    });
    const { container } = renderProfile();

    await screen.findByText(copy.profile.focusedHours);
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((row) => row.textContent)).toEqual([
      `ریاضی${faDuration(75 * 60_000)}`,
      `درس${faDuration(25 * 60_000)}`,
    ]);
    // The bars are shares of the day, which is what makes the rows comparable
    // at a glance — the durations beside them are the exact answer.
    const bars = rows.map((row) => row.querySelector<HTMLElement>(".bg-chart-1")?.style.width);
    expect(bars).toEqual(["75%", "25%"]);
  });

  it("shows a visitor one masked row for all the private tasks", async () => {
    server({
      days: chart(7, { "2026-03-15": [masked(50 * 60_000), task("درس", 25 * 60_000)] }),
    });
    renderProfile();

    // How long somebody worked is public; what they were doing is theirs. The
    // names never reached the client for this row to be built from.
    await screen.findByText(copy.profile.privateBucket);
    expect(screen.getByText("درس")).toBeTruthy();
    // And a stranger is not told about the owner's view of it.
    expect(screen.queryByText(copy.profile.ownerNote)).toBeNull();
  });

  it("names an untasked row without masking it", async () => {
    server({
      days: chart(7, { "2026-03-15": [{ kind: "none", name: null, totalMs: 25 * 60_000 }] }),
    });
    renderProfile();

    // Work with no task is not hiding anything, so it does not read as
    // something withheld.
    await screen.findByText(copy.profile.noTask);
    expect(screen.queryByText(copy.profile.privateBucket)).toBeNull();
  });

  it("says on your own page that others do not see these names", async () => {
    server({
      owner: true,
      days: chart(7, { "2026-03-15": [task("درمان", 50 * 60_000)] }),
    });
    renderProfile("yazdan", { status: "authenticated", handle: "yazdan" });

    // Seeing your private tasks named is exactly the moment you might think
    // strangers can too.
    await screen.findByText("درمان");
    expect(screen.getByText(copy.profile.ownerNote)).toBeTruthy();
  });

  it("renders no panel for a chart with nothing in it", async () => {
    // Somebody with a history who did nothing this week: a flat line, and no
    // detail to dock under it — not a panel reading ۰:۰۰.
    server({ days: chart(7), everFocused: true });
    const { container } = renderProfile();

    await waitFor(() => expect(container.querySelector("svg")).toBeTruthy());
    expect(screen.queryByText(copy.profile.focusedHours)).toBeNull();
  });
});

describe("pointing at the chart", () => {
  // A week with two worked days, far enough apart on the axis to point at one
  // and then the other.
  const WEEK = () =>
    chart(7, {
      "2026-03-10": [task("ریاضی", 30 * 60_000)],
      "2026-03-15": [task("درس", 75 * 60_000)],
    });

  /** Point at the chart, `x` pixels across the six hundred it is stubbed at. */
  async function point(container: HTMLElement, x: number) {
    // The chart is code-split, and measures itself once it arrives.
    const chartArea = await waitFor(() => {
      const drawn = container.querySelector(".recharts-wrapper");
      if (drawn === null) throw new Error("the chart has not drawn yet");
      return drawn;
    });
    fireEvent.mouseMove(chartArea, { clientX: x, clientY: 50 });
  }

  it("selects the day under the pointer and docks its detail", async () => {
    server({ days: WEEK() });
    const { container } = renderProfile();

    // It opens on the most recent day with data...
    await screen.findByText(faDate("2026-03-15"));

    // ...and follows the pointer to an earlier one.
    await point(container, 100);
    await screen.findByText(faDate("2026-03-10"));
    expect(screen.getByText(faHourClock(30 * 60_000))).toBeTruthy();
    expect(screen.getByText("ریاضی")).toBeTruthy();
  });

  it("marks the selected day on the line", async () => {
    server({ days: WEEK() });
    const { container } = renderProfile();

    // The panel always has a visible anchor on the line it came from: a dot on
    // the day, and a faint crosshair down it.
    await waitFor(() => expect(container.querySelector(".recharts-reference-dot")).toBeTruthy());
    expect(container.querySelector(".recharts-reference-line")).toBeTruthy();
  });

  it("lets the outgoing panel leave before the incoming one arrives", async () => {
    server({ days: WEEK() });
    const { container } = renderProfile();

    await screen.findByText(faDate("2026-03-15"));
    await point(container, 100);

    // The two days differ in height with the length of the task list, so
    // dissolving them through each other would shunt the page around under
    // whoever is reading it. While the outgoing panel is fading, it is still
    // the only one there.
    await waitFor(() => expect(container.querySelector(".opacity-0")).toBeTruthy());
    expect(screen.getByText(faDate("2026-03-15"))).toBeTruthy();
    expect(screen.queryByText(faDate("2026-03-10"))).toBeNull();

    await screen.findByText(faDate("2026-03-10"));
    expect(screen.queryByText(faDate("2026-03-15"))).toBeNull();
  });

  it("keeps each day's picture as the pointer goes back and forth", async () => {
    server({ days: WEEK() });
    const { container } = renderProfile();

    await screen.findByText(faDate("2026-03-15"));
    const first = container.querySelector("img")?.getAttribute("src");

    await point(container, 100);
    await screen.findByText(faDate("2026-03-10"));
    const second = container.querySelector("img")?.getAttribute("src");
    // Consecutive days are given different pictures...
    expect(second).not.toBe(first);

    await point(container, 590);
    await screen.findByText(faDate("2026-03-15"));
    // ...and coming back does not reshuffle the art, which would read as a
    // glitch rather than as a picture.
    expect(container.querySelector("img")?.getAttribute("src")).toBe(first);
  });

  it("shows nothing under a day with nothing in it", async () => {
    server({ days: WEEK() });
    const { container } = renderProfile();

    await screen.findByText(faDate("2026-03-15"));
    // The 12th, which nobody worked. The chart is zero-filled so it can be
    // pointed at; the panel is simply not rendered for it.
    await point(container, 300);

    await waitFor(() => expect(screen.queryByText(copy.profile.focusedHours)).toBeNull());
  });
});

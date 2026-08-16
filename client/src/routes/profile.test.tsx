import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Auth } from "@/lib/auth";
import { copy, t } from "@/lib/copy";
import { faDateShort, faDigits } from "@/lib/format";
import { ProfileRoute } from "@/routes/profile";
import { renderAt } from "@/test/render";

const NOW = 1_800_000_000_000;

type Day = { day: string; totalMs: number };

/** `days` columns ending on the last of them, all empty unless said otherwise. */
function chart(days: number, worked: Record<string, number> = {}): Day[] {
  const out: Day[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const at = new Date(Date.UTC(2026, 2, 15) - i * 86_400_000);
    const day = at.toISOString().slice(0, 10);
    out.push({ day, totalMs: worked[day] ?? 0 });
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
  status = 200,
  hold = false,
}: {
  handle?: string;
  days?: Day[];
  everFocused?: boolean;
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
    return new Response(JSON.stringify({ handle, days, everFocused, serverNow: NOW }), {
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

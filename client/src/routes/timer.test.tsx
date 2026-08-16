import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { copy, t } from "@/lib/copy";
import { faClock, faDigits, faDuration, faElapsed } from "@/lib/format";
import { noteServerTime } from "@/lib/server-clock";
import { TimerRoute } from "@/routes/timer";
import { holding, renderAt, SIGNED_IN } from "@/test/render";

/** The timer only exists for somebody signed in, so every test starts there. */
const renderTimer = () => renderAt(<TimerRoute />, { auth: SIGNED_IN });

const NOW = 1_800_000_000_000;
const CATEGORY = { id: "c1", name: "درس", isPublic: true };

type Session = {
  id: string;
  kind: string;
  categoryId: string | null;
  categoryName: string | null;
  startedAt: number;
  endsAt: number;
  durationMs: number;
  breakEndsAt: number | null;
  resumeCategoryId: string | null;
  resumeDurationMs: number | null;
};

type Cycle = { count: number };
/** What a break is worth on this account, and how long a cycle is. */
type Intervals = { shortBreakMs: number; longBreakMs: number; perCycle: number };
/** How the Tehran day has gone so far, credited at the bell. */
type Today = { count: number; totalMs: number };

const EMPTY_DAY: Today = { count: 0, totalMs: 0 };

const CLASSIC: Intervals = {
  shortBreakMs: 5 * 60_000,
  longBreakMs: 20 * 60_000,
  perCycle: 4,
};

const SHORT_BREAK = 5 * 60_000;

const workSession = (over: Partial<Session> = {}): Session => {
  const endsAt = over.endsAt ?? NOW + 25 * 60_000;
  return {
    id: "s1",
    kind: "work",
    categoryId: CATEGORY.id,
    categoryName: CATEGORY.name,
    startedAt: NOW,
    durationMs: 25 * 60_000,
    // The rest it owes, anchored at its own end: the ring is spent out of it,
    // so this instant does not move however late the bell is answered.
    breakEndsAt: endsAt + SHORT_BREAK,
    resumeCategoryId: null,
    resumeDurationMs: null,
    ...over,
    endsAt,
  };
};

/**
 * The break a pomodoro handed over, as the server sends it: it *began* at that
 * pomodoro's nominal end, which is why a break started after a two-minute ring
 * has two minutes already gone.
 */
const breakSession = (over: Partial<Session> = {}): Session => ({
  id: "b1",
  kind: "shortBreak",
  categoryId: null,
  categoryName: null,
  startedAt: NOW,
  endsAt: NOW + SHORT_BREAK,
  durationMs: SHORT_BREAK,
  breakEndsAt: null,
  // What "another one" resumes, read off the pomodoro this break followed.
  resumeCategoryId: CATEGORY.id,
  resumeDurationMs: 25 * 60_000,
  ...over,
});

/**
 * The seam is `fetch`. The route is fed server payloads and the assertion is
 * what is on screen — the same shape a real browser would be in.
 */
function server({
  session = null as Session | null,
  cycle = { count: 0 } as Cycle,
  intervals = CLASSIC,
  today = EMPTY_DAY,
  categories = [CATEGORY],
  onStart,
  onCancel,
  onConfirm,
  onIntervals,
}: {
  session?: Session | null;
  cycle?: Cycle;
  intervals?: Intervals;
  today?: Today;
  categories?: typeof CATEGORY[];
  onStart?: (body: Record<string, unknown>) => Response;
  onCancel?: () => Response;
  onConfirm?: () => Response;
  // A promise rather than a plain Response where a test wants to hold the
  // request open and see the row while it is in flight.
  onIntervals?: (body: Record<string, unknown>) => Response | Promise<Response>;
} = {}) {
  const started = vi.fn();
  const cancelled = vi.fn();
  const confirmed = vi.fn();
  const saved = vi.fn();

  const fetched = vi.fn(async (input: string, init?: RequestInit) => {
    const body: Record<string, unknown> =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    if (input === "/api/categories") {
      return json({ categories, serverNow: NOW });
    }
    if (input === "/api/session") {
      return timer({ session });
    }
    if (input === "/api/session/start") {
      started(body);
      return onStart ? onStart(body) : timer({ session: workSession() });
    }
    if (input.endsWith("/cancel")) {
      cancelled();
      return onCancel ? onCancel() : timer({ session: null });
    }
    if (input.endsWith("/confirm")) {
      confirmed();
      return onConfirm ? onConfirm() : timer({ session: null });
    }
    // The intervals are edited with an ordinary POST and answered with the
    // whole timer state, exactly like every other mutation.
    if (input === "/api/intervals") {
      saved(body);
      return onIntervals
        ? onIntervals(body)
        : json({ session, cycle, intervals: body, today, serverNow: NOW });
    }
    throw new Error(`unstubbed request: ${input}`);
  });

  // Every answer about the timer carries the session, the cycle, the account's
  // intervals and today's total together, exactly as the server sends them.
  const timer = ({ session }: { session: Session | null }) =>
    json({ session, cycle, intervals, today, serverNow: NOW });

  vi.stubGlobal("fetch", fetched);
  return { started, cancelled, confirmed, saved };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A whole timer payload, for the handlers a test overrides itself. */
const timerJson = (
  session: Session | null,
  cycle: Cycle = { count: 0 },
  intervals: Intervals = CLASSIC,
  today: Today = EMPTY_DAY,
) => json({ session, cycle, intervals, today, serverNow: NOW });

beforeEach(() => {
  vi.unstubAllGlobals();
  // Anchor the clock where the fixtures are, so a countdown is a statement
  // about a fixed instant rather than about when the suite happened to run.
  noteServerTime(NOW, performance.now());
});

/** Nothing can be started without a task, so most tests begin by picking one. */
async function pickTask(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("combobox"));
  await user.click(await screen.findByText(CATEGORY.name));
}

describe("the start screen", () => {
  it("offers the stepper at its default and the picked task", async () => {
    server();
    renderTimer();

    expect(await screen.findByText(faDigits(25))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });

  it("cannot start without a task", async () => {
    server({ categories: [] });
    renderTimer();

    const button = await screen.findByRole("button", { name: copy.timer.start });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("cannot start on a task that has been deleted since it was picked", async () => {
    // The remembered id is a device preference and the list is the truth; a
    // stale one has to fall back rather than be sent to a server that would
    // refuse it.
    localStorage.setItem("pomodorus.category", JSON.stringify("gone"));
    server();
    renderTimer();

    const button = await screen.findByRole("button", { name: copy.timer.start });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("walks the range in five-minute steps", async () => {
    server();
    renderTimer();
    const user = userEvent.setup();

    await screen.findByText(faDigits(25));
    await user.click(screen.getByRole("button", { name: /۳۰/ }));
    expect(screen.getByText(faDigits(30))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /۲۵/ }));
    expect(screen.getByText(faDigits(25))).toBeTruthy();
  });

  it("disables the button for a limit it has reached", async () => {
    server();
    renderTimer();
    const user = userEvent.setup();
    await screen.findByText(faDigits(25));

    // Down to the floor: the minus is then disabled rather than silently
    // doing nothing, so the range is visible.
    for (let m = 25; m > 15; m -= 5) {
      await user.click(screen.getByRole("button", { name: new RegExp(faDigits(m - 5)) }));
    }
    expect(screen.getByText(faDigits(15))).toBeTruthy();
    const minus = screen.getByRole("button", { name: new RegExp(faDigits(10)) });
    expect(minus.getAttribute("disabled")).not.toBeNull();
  });

  it("starts with the task and the length that are on screen", async () => {
    const { started } = server();
    renderTimer();
    const user = userEvent.setup();

    await pickTask(user);
    await user.click(screen.getByRole("button", { name: /۳۰/ }));
    await user.click(screen.getByRole("button", { name: copy.timer.start }));

    await waitFor(() => expect(started).toHaveBeenCalled());
    const body = started.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.categoryId).toBe(CATEGORY.id);
    expect(body.durationMs).toBe(30 * 60_000);
    // A client-minted id, so a retry cannot start a second timer.
    expect(typeof body.id).toBe("string");
  });

  it("remembers the task and the length across a reload", async () => {
    server();
    const first = renderTimer();
    const user = userEvent.setup();

    await pickTask(user);
    await user.click(screen.getByRole("button", { name: /۳۰/ }));
    first.unmount();

    renderTimer();
    expect(await screen.findByText(faDigits(30))).toBeTruthy();
    // The task too: a refresh should not lose your place.
    expect(
      (await screen.findByRole("button", { name: copy.timer.start })).getAttribute(
        "disabled",
      ),
    ).toBeNull();
  });

  it("says why a start was refused rather than doing nothing", async () => {
    server({ onStart: () => json({ error: "bad_duration", serverNow: NOW }, 400) });
    renderTimer();
    const user = userEvent.setup();

    await pickTask(user);
    await user.click(screen.getByRole("button", { name: copy.timer.start }));

    expect(await screen.findByText(copy.errors.badDuration)).toBeTruthy();
  });
});

describe("a running session", () => {
  it("shows the task, the countdown and a cancel", async () => {
    server({ session: workSession() });
    renderTimer();

    expect(await screen.findByText("درس")).toBeTruthy();
    expect(screen.getByText(faClock(25 * 60_000))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.cancelWork }),
    ).toBeTruthy();
    // Never a start button while one is running — that is how a second timer
    // used to get started.
    expect(screen.queryByRole("button", { name: copy.timer.start })).toBeNull();
  });

  it("counts down from the session's own facts, not from anything streamed", async () => {
    // A session that began five minutes ago. Nothing was pushed to say how far
    // in it is — the countdown is computed from startedAt, endsAt and the
    // clock, which is what makes a dropped connection invisible.
    server({
      session: workSession({
        startedAt: NOW - 5 * 60_000,
        endsAt: NOW + 20 * 60_000,
      }),
    });
    renderTimer();

    expect(await screen.findByText(faClock(20 * 60_000))).toBeTruthy();
  });

  it("shows a generic label for a task whose name is not ours to render", async () => {
    server({ session: workSession({ categoryName: null }) });
    renderTimer();

    expect(await screen.findByText(copy.timer.privateTask)).toBeTruthy();
  });

  it("cancels, and returns to the start screen", async () => {
    const { cancelled } = server({ session: workSession() });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.cancelWork }),
    );

    await waitFor(() => expect(cancelled).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });

  it("says why a cancel was refused", async () => {
    server({
      session: workSession(),
      onCancel: () => json({ error: "not_cancellable", serverNow: NOW }, 409),
    });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.cancelWork }),
    );

    expect(await screen.findByText(copy.errors.notCancellable)).toBeTruthy();
  });
});

describe("the progress bar", () => {
  it("starts at zero for a new session", async () => {
    server({ session: workSession() });
    renderTimer();

    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });

  it("never renders an invalid width at the very end", async () => {
    // A negative percentage is invalid CSS: the declaration would be dropped,
    // width would fall back to auto, and the bar would flash full white at
    // exactly the moment a session ends.
    server({
      session: workSession({ startedAt: NOW - 25 * 60_000, endsAt: NOW + 1 }),
    });
    renderTimer();

    const bar = await screen.findByRole("progressbar");
    const width = Number.parseFloat(bar.style.width);
    expect(width).toBeGreaterThanOrEqual(0);
    expect(width).toBeLessThanOrEqual(100);
  });

  it("clamps rather than going negative before a session starts", async () => {
    server({
      session: workSession({ startedAt: NOW + 60_000, endsAt: NOW + 26 * 60_000 }),
    });
    renderTimer();

    const bar = await screen.findByRole("progressbar");
    expect(Number.parseFloat(bar.style.width)).toBeGreaterThanOrEqual(0);
  });
});

describe("the bell", () => {
  /** A session whose nominal end was `ago` milliseconds back: ringing. */
  const ringing = (ago: number) =>
    workSession({ startedAt: NOW - 25 * 60_000 - ago, endsAt: NOW - ago });

  it("rings where the countdown was, counting up", async () => {
    server({ session: ringing(65_000) });
    renderTimer();

    expect(await screen.findByText(copy.timer.ringWorkTitle)).toBeTruthy();
    // Up, not down, and prefixed — a clock that has stopped meaning "time
    // left" has to be unmistakable.
    expect(screen.getByText(faElapsed(65_000))).toBeTruthy();
    expect(screen.getByText("درس")).toBeTruthy();
  });

  it("is the only red in the app", async () => {
    server({ session: ringing(1000) });
    renderTimer();

    const clock = await screen.findByText(faElapsed(1000));
    expect(clock.className.split(/\s+/)).toContain("text-rose-500");
  });

  it("cannot be cancelled: the work is complete and already credited", async () => {
    server({ session: ringing(1000) });
    renderTimer();

    await screen.findByText(copy.timer.ringWorkTitle);
    expect(
      screen.queryByRole("button", { name: copy.timer.cancelWork }),
    ).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("ends on a deliberate tap, and hands over the break in the same one", async () => {
    const rest = breakSession({ startedAt: NOW - 1000, endsAt: NOW - 1000 + SHORT_BREAK });
    const { confirmed } = server({
      session: ringing(1000),
      onConfirm: () => timerJson(rest),
    });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.confirmWork }),
    );

    await waitFor(() => expect(confirmed).toHaveBeenCalled());
    // One tap: the pomodoro is acknowledged and the rest it earned is running.
    expect(
      await screen.findByRole("button", { name: copy.timer.skipBreak }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.timer.start })).toBeNull();
  });

  it("keeps ringing when a confirmation is refused, and says why", async () => {
    server({
      session: ringing(1000),
      onConfirm: () => json({ error: "nothing_ringing", serverNow: NOW }, 409),
    });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.confirmWork }),
    );

    expect(await screen.findByText(copy.errors.nothingRinging)).toBeTruthy();
    expect(screen.getByText(copy.timer.ringWorkTitle)).toBeTruthy();
  });

  it("rings a session that ended while the tab was asleep", async () => {
    // Nothing was scheduled and nothing was pushed: the state is recomputed
    // from `endsAt` and the clock, so however long the app was away it opens
    // into the ring rather than into a finished countdown.
    server({ session: ringing(3 * 60 * 60_000) });
    renderTimer();

    expect(await screen.findByText(copy.timer.ringWorkTitle)).toBeTruthy();
    expect(screen.getByText(faElapsed(3 * 60 * 60_000))).toBeTruthy();
  });
});

describe("the button on a ringing pomodoro", () => {
  /** A pomodoro whose bell went `ago` ago, owing a five-minute break. */
  const rang = (ago: number) =>
    workSession({ startedAt: NOW - 25 * 60_000 - ago, endsAt: NOW - ago });

  it("promises the chill while there is still some of it left", async () => {
    server({ session: rang(SHORT_BREAK - 1000) });
    renderTimer();

    expect(
      await screen.findByRole("button", { name: copy.timer.confirmWork }),
    ).toBeTruthy();
  });

  it("says so instead once the ring has eaten the whole break", async () => {
    // Anchored at the nominal end: five minutes of ringing is five minutes of
    // break spent, so this tap buys silence and nothing else. The label has to
    // say that a moment *before* it is pressed, not after.
    server({ session: rang(SHORT_BREAK) });
    renderTimer();

    expect(
      await screen.findByRole("button", { name: copy.timer.confirmWorkNoBreak }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: copy.timer.confirmWork }),
    ).toBeNull();
  });

  it("drops back to the start screen when nothing survived", async () => {
    const { confirmed } = server({ session: rang(2 * 60 * 60_000) });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.confirmWorkNoBreak }),
    );

    await waitFor(() => expect(confirmed).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });
});

describe("a running break", () => {
  it("counts down what survived the ring, and offers a skip", async () => {
    // Two minutes of it were spent ringing, so three are left — the client is
    // told nothing about that; it reads one end time like any other.
    server({
      session: breakSession({
        startedAt: NOW - 2 * 60_000,
        endsAt: NOW + 3 * 60_000,
      }),
    });
    renderTimer();

    expect(await screen.findByText(copy.timer.kindShortBreak)).toBeTruthy();
    expect(screen.getByText(faClock(3 * 60_000))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.skipBreak }),
    ).toBeTruthy();
    // A break belongs to no task, so it never shows one.
    expect(screen.queryByText(CATEGORY.name)).toBeNull();
  });

  it("shows the ring time as already spent", async () => {
    // The bar is measured from the break's start, which is the pomodoro's
    // nominal end — so two minutes of ringing are already behind it when it
    // first appears, rather than being quietly forgiven.
    server({
      session: breakSession({
        startedAt: NOW - 2 * 60_000,
        endsAt: NOW + 3 * 60_000,
      }),
    });
    renderTimer();

    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
  });

  it("names the long one as the long one", async () => {
    server({ session: breakSession({ kind: "longBreak" }) });
    renderTimer();

    expect(await screen.findByText(copy.timer.kindLongBreak)).toBeTruthy();
  });

  it("skips back to the start screen", async () => {
    const { cancelled } = server({ session: breakSession() });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.skipBreak }),
    );

    await waitFor(() => expect(cancelled).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });
});

describe("a ringing break", () => {
  const rang = (over: Partial<Session> = {}) =>
    breakSession({ startedAt: NOW - SHORT_BREAK, endsAt: NOW, ...over });

  it("asks the technique's own question: another one, or stop", async () => {
    server({ session: rang() });
    renderTimer();

    expect(await screen.findByText(copy.timer.ringBreakTitle)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.continueWork }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.confirmBreak }),
    ).toBeTruthy();
  });

  it("continues on the same task at the same length", async () => {
    // Neither comes from this device: the break carries the task and the
    // length of the pomodoro it followed, so a second device that has picked
    // nothing continues onto the same work rather than onto its own guess.
    localStorage.setItem("pomodorus.minutes", JSON.stringify(15));
    const { started, confirmed } = server({
      session: rang({ resumeDurationMs: 30 * 60_000 }),
    });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.continueWork }),
    );

    // Acknowledged first, then started: one live session at a time.
    await waitFor(() => expect(started).toHaveBeenCalled());
    expect(confirmed).toHaveBeenCalled();
    const body = started.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.categoryId).toBe(CATEGORY.id);
    expect(body.durationMs).toBe(30 * 60_000);
    // And the stepper behind it now agrees with what is running.
    expect(JSON.parse(localStorage.getItem("pomodorus.minutes") ?? "0")).toBe(30);
  });

  it("falls back to this device's picks when the break carries none", async () => {
    localStorage.setItem("pomodorus.category", JSON.stringify(CATEGORY.id));
    localStorage.setItem("pomodorus.minutes", JSON.stringify(20));
    const { started } = server({
      session: rang({ resumeCategoryId: null, resumeDurationMs: null }),
    });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.continueWork }),
    );

    await waitFor(() => expect(started).toHaveBeenCalled());
    const body = started.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.categoryId).toBe(CATEGORY.id);
    expect(body.durationMs).toBe(20 * 60_000);
  });

  it("cannot continue onto a task that is gone", async () => {
    // The task the pomodoro was on has since been deleted, and this device has
    // nothing remembered to fall back to. The list is the truth.
    server({ session: rang({ resumeCategoryId: "gone" }) });
    renderTimer();

    const button = await screen.findByRole("button", {
      name: copy.timer.continueWork,
    });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("says why a continue never became a pomodoro", async () => {
    // The break was acknowledged, so this screen is already gone by the time
    // the start fails. The reason has to survive that, or the tap looks like
    // it did nothing.
    server({
      session: rang(),
      onStart: () => json({ error: "category_not_found", serverNow: NOW }, 404),
    });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.continueWork }),
    );

    expect(await screen.findByText(copy.errors.categoryNotFound)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });

  it("stops, with both still picked", async () => {
    localStorage.setItem("pomodorus.category", JSON.stringify(CATEGORY.id));
    const { started, confirmed } = server({ session: rang() });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.confirmBreak }),
    );

    await waitFor(() => expect(confirmed).toHaveBeenCalled());
    expect(started).not.toHaveBeenCalled();
    // Back where it started, ready to go again on the same task.
    const start = await screen.findByRole("button", { name: copy.timer.start });
    expect(start.getAttribute("disabled")).toBeNull();
  });
});

describe("the cycle dots", () => {
  it("show how far into the cycle a running session is", async () => {
    server({ session: workSession(), cycle: { count: 2 } });
    renderTimer();

    const dots = await screen.findByTitle(
      t(copy.timer.cycleTitle, { n: faDigits(2), total: faDigits(4) }),
    );
    expect(dots.childElementCount).toBe(4);
    const filled = [...dots.children].filter((dot) =>
      dot.className.includes("bg-foreground"),
    );
    expect(filled.length).toBe(2);
  });

  it("clamp rather than grow for somebody who keeps declining the long break", async () => {
    server({ session: workSession(), cycle: { count: 6 } });
    renderTimer();

    const dots = await screen.findByTitle(
      t(copy.timer.cycleTitle, { n: faDigits(4), total: faDigits(4) }),
    );
    expect(dots.childElementCount).toBe(4);
  });

  it("are not on the start screen, where there is no session to be in one", async () => {
    server({ cycle: { count: 2 } });
    renderTimer();

    await screen.findByRole("button", { name: copy.timer.start });
    expect(
      screen.queryByTitle(
        t(copy.timer.cycleTitle, { n: faDigits(2), total: faDigits(4) }),
      ),
    ).toBeNull();
  });
});

describe("the settings dialog", () => {
  /** Open it from the start screen, which is the only place it is offered. */
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: copy.timer.settings }));
  }

  const stepper = (label: string, direction: "+" | "−") =>
    screen.getByRole("button", { name: `${label} ${direction}` });

  it("shows the three intervals the account is set to", async () => {
    server({ intervals: { shortBreakMs: 8 * 60_000, longBreakMs: 30 * 60_000, perCycle: 3 } });
    renderTimer();
    await openSettings(userEvent.setup());

    // The account's, not this device's: there is nothing in localStorage to
    // read them from, and two devices may not disagree about them.
    expect(screen.getByText(t(copy.timer.minutes, { m: faDigits(8) }))).toBeTruthy();
    expect(screen.getByText(t(copy.timer.minutes, { m: faDigits(30) }))).toBeTruthy();
    expect(screen.getByText(t(copy.timer.count, { n: faDigits(3) }))).toBeTruthy();
  });

  it("sends all three, with the one that was stepped changed", async () => {
    const { saved } = server();
    renderTimer();
    const user = userEvent.setup();
    await openSettings(user);

    await user.click(stepper(copy.timer.settingsShortBreak, "+"));

    // All three every time: there is nothing to merge, so a stepper tapped
    // here cannot quietly revert what another device set a moment ago.
    expect(saved).toHaveBeenCalledWith({
      shortBreakMs: 6 * 60_000,
      longBreakMs: 20 * 60_000,
      perCycle: 4,
    });
    expect(
      await screen.findByText(t(copy.timer.minutes, { m: faDigits(6) })),
    ).toBeTruthy();
  });

  it("walks each interval in its own step", async () => {
    const { saved } = server();
    renderTimer();
    const user = userEvent.setup();
    await openSettings(user);

    // A minute for the short break, five for the long one, one pomodoro for
    // the cycle — the bands the server refuses anything outside of.
    await user.click(stepper(copy.timer.settingsLongBreak, "−"));
    expect(saved).toHaveBeenLastCalledWith(
      expect.objectContaining({ longBreakMs: 15 * 60_000 }),
    );

    await user.click(stepper(copy.timer.settingsPerCycle, "−"));
    expect(saved).toHaveBeenLastCalledWith(
      expect.objectContaining({ perCycle: 3 }),
    );
  });

  it("disables the button for a limit it has reached", async () => {
    server({
      intervals: { shortBreakMs: 3 * 60_000, longBreakMs: 35 * 60_000, perCycle: 6 },
    });
    renderTimer();
    await openSettings(userEvent.setup());

    // The end of the band is visible rather than something you discover by
    // pressing, exactly as the pomodoro's own stepper behaves.
    expect(stepper(copy.timer.settingsShortBreak, "−").getAttribute("disabled")).not.toBeNull();
    expect(stepper(copy.timer.settingsShortBreak, "+").getAttribute("disabled")).toBeNull();
    expect(stepper(copy.timer.settingsLongBreak, "+").getAttribute("disabled")).not.toBeNull();
    expect(stepper(copy.timer.settingsPerCycle, "+").getAttribute("disabled")).not.toBeNull();
  });

  it("reports a refused edit rather than showing a number only this device has", async () => {
    server({ onIntervals: () => json({ error: "bad_interval", serverNow: NOW }, 400) });
    renderTimer();
    const user = userEvent.setup();
    await openSettings(user);

    await user.click(stepper(copy.timer.settingsShortBreak, "+"));

    expect(await screen.findByText(copy.errors.badDuration)).toBeTruthy();
    // Still five: the value on screen is the server's answer, and a tap that
    // never landed did not change what a break is worth.
    expect(screen.getByText(t(copy.timer.minutes, { m: faDigits(5) }))).toBeTruthy();
  });

  it("goes inert while an edit is in flight rather than counting off a stale value", async () => {
    // The number on screen is the server's answer, so a second tap computed
    // from the one it is about to replace would be a tap silently dropped.
    let land!: (answer: Response) => void;
    const held = new Promise<Response>((resolve) => {
      land = resolve;
    });
    const { saved } = server({ onIntervals: () => held });
    renderTimer();
    const user = userEvent.setup();
    await openSettings(user);

    await user.click(stepper(copy.timer.settingsShortBreak, "+"));
    await waitFor(() =>
      expect(
        stepper(copy.timer.settingsShortBreak, "+").getAttribute("disabled"),
      ).not.toBeNull(),
    );

    await user.click(stepper(copy.timer.settingsShortBreak, "+"));
    expect(saved).toHaveBeenCalledTimes(1);

    // And live again the moment the answer lands, at the value it carried.
    land(
      json({
        session: null,
        cycle: { count: 0 },
        intervals: { ...CLASSIC, shortBreakMs: 6 * 60_000 },
        serverNow: NOW,
      }),
    );
    expect(
      await screen.findByText(t(copy.timer.minutes, { m: faDigits(6) })),
    ).toBeTruthy();
    expect(
      stepper(copy.timer.settingsShortBreak, "+").getAttribute("disabled"),
    ).toBeNull();
  });

  it("asks again when the tab is looked at, so another device's edit arrives", async () => {
    // There is no socket yet, so this is what "applies on every device you have
    // open" rests on: a tab that has been away asks the moment it is back.
    server({ intervals: { shortBreakMs: 9 * 60_000, longBreakMs: 20 * 60_000, perCycle: 4 } });
    renderTimer();
    const user = userEvent.setup();
    await openSettings(user);
    expect(screen.getByText(t(copy.timer.minutes, { m: faDigits(9) }))).toBeTruthy();

    // The account changes elsewhere; this tab comes back to the front.
    server({ intervals: { shortBreakMs: 4 * 60_000, longBreakMs: 20 * 60_000, perCycle: 4 } });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(
      await screen.findByText(t(copy.timer.minutes, { m: faDigits(4) })),
    ).toBeTruthy();
  });

  it("takes the cycle it was given straight to the dots", async () => {
    // Pomodoros-per-cycle is read at completion rather than snapshotted, so a
    // shorter cycle is felt immediately — including by what is on screen.
    server({ session: workSession(), cycle: { count: 1 } });
    renderTimer();

    expect(
      await screen.findByTitle(t(copy.timer.cycleTitle, { n: faDigits(1), total: faDigits(4) })),
    ).toBeTruthy();
  });

  it("is not offered while something is running", async () => {
    // It is opened from the start screen, where the intervals are a decision
    // about what comes next rather than about what is already under way.
    server({ session: workSession() });
    renderTimer();

    await screen.findByText(CATEGORY.name);
    expect(screen.queryByRole("button", { name: copy.timer.settings })).toBeNull();
  });
});

describe("opening on a second device", () => {
  it("shows the running timer rather than a start button", async () => {
    // The server owns the timer, so "a second device" is just another client
    // asking the same question and getting the same answer.
    server({ session: workSession() });
    renderTimer();

    expect(await screen.findByText(faClock(25 * 60_000))).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.timer.start })).toBeNull();
  });

  it("reserves the page rather than flashing a start button while it asks", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderTimer();

    expect(screen.queryByRole("button", { name: copy.timer.start })).toBeNull();
    expect(
      screen.queryByRole("button", { name: copy.timer.cancelWork }),
    ).toBeNull();
  });
});

describe("today's focus", () => {
  it("says how the day has gone", async () => {
    server({ today: { count: 3, totalMs: 80 * 60_000 } });
    renderTimer();

    // «امروز ۳ تا — ۱ ساعت و ۲۰ دقیقه» — the count and the total, in Persian
    // digits, as a sentence rather than a clock.
    await screen.findByText(
      t(copy.timer.todaySummary, {
        count: faDigits(3),
        duration: faDuration(80 * 60_000),
      }),
    );
  });

  it("says the day is empty only once the server has said so", async () => {
    server({ today: { count: 0, totalMs: 0 } });
    renderTimer();

    await screen.findByText(copy.timer.todayEmpty);
  });

  it("says nothing at all while it is still asking", () => {
    // A blank row, not «امروز تمرکز نکردی کلا» — flashing that at somebody who
    // has done four pomodoros is worse than saying nothing.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderTimer();

    expect(screen.queryByText(copy.timer.todayEmpty)).toBeNull();
  });

  it("holds the row's height whether or not it knows", async () => {
    // The reserved box, and the only state where the start screen is up while
    // the day is still unknown: a context that has a session but no total.
    // The row is there and empty rather than absent, so nothing above it moves
    // when the answer lands.
    const unknown = renderAt(<TimerRoute />, {
      auth: SIGNED_IN,
      session: holding(null, { today: undefined }),
    });
    const blank = unknown.container.querySelector("p.h-5");
    expect(blank).toBeTruthy();
    expect(blank?.textContent).toBe("");
    unknown.unmount();

    const known = renderAt(<TimerRoute />, {
      auth: SIGNED_IN,
      session: holding(null, { today: { count: 2, totalMs: 50 * 60_000 } }),
    });
    const filled = known.container.querySelector("p.h-5");
    // The same box, now with something in it.
    expect(filled).toBeTruthy();
    expect(filled?.textContent).toContain(faDigits(2));
  });

  it("ticks up when a pomodoro completes, without a reload", async () => {
    // The total rides on the timer payload, so acknowledging a bell answers
    // with the new day as part of the same response.
    server({
      session: workSession({ endsAt: NOW - 1000 }),
      today: EMPTY_DAY,
      onConfirm: () => timerJson(null, { count: 1 }, CLASSIC, {
        count: 1,
        totalMs: 25 * 60_000,
      }),
    });
    renderTimer();

    const confirm = await screen.findByRole("button", {
      name: new RegExp(copy.timer.confirmWork),
    });
    await userEvent.click(confirm);

    await screen.findByText(
      t(copy.timer.todaySummary, {
        count: faDigits(1),
        duration: faDuration(25 * 60_000),
      }),
    );
  });
});

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { copy } from "@/lib/copy";
import { faClock, faDigits, faElapsed } from "@/lib/format";
import { noteServerTime } from "@/lib/server-clock";
import { TimerRoute } from "@/routes/timer";
import { renderAt, SIGNED_IN } from "@/test/render";

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
};

const workSession = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  kind: "work",
  categoryId: CATEGORY.id,
  categoryName: CATEGORY.name,
  startedAt: NOW,
  endsAt: NOW + 25 * 60_000,
  durationMs: 25 * 60_000,
  ...over,
});

/**
 * The seam is `fetch`. The route is fed server payloads and the assertion is
 * what is on screen — the same shape a real browser would be in.
 */
function server({
  session = null as Session | null,
  categories = [CATEGORY],
  onStart,
  onCancel,
  onConfirm,
}: {
  session?: Session | null;
  categories?: typeof CATEGORY[];
  onStart?: (body: Record<string, unknown>) => Response;
  onCancel?: () => Response;
  onConfirm?: () => Response;
} = {}) {
  const started = vi.fn();
  const cancelled = vi.fn();
  const confirmed = vi.fn();

  const fetched = vi.fn(async (input: string, init?: RequestInit) => {
    const body: Record<string, unknown> =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    if (input === "/api/categories") {
      return json({ categories, serverNow: NOW });
    }
    if (input === "/api/session") {
      return json({ session, serverNow: NOW });
    }
    if (input === "/api/session/start") {
      started(body);
      return onStart ? onStart(body) : json({ session: workSession(), serverNow: NOW });
    }
    if (input.endsWith("/cancel")) {
      cancelled();
      return onCancel ? onCancel() : json({ session: null, serverNow: NOW });
    }
    if (input.endsWith("/confirm")) {
      confirmed();
      return onConfirm ? onConfirm() : json({ session: null, serverNow: NOW });
    }
    throw new Error(`unstubbed request: ${input}`);
  });

  vi.stubGlobal("fetch", fetched);
  return { started, cancelled, confirmed };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

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

  it("ends on a deliberate tap, and nothing advances on its own", async () => {
    const { confirmed } = server({ session: ringing(1000) });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.confirmWorkNoBreak }),
    );

    await waitFor(() => expect(confirmed).toHaveBeenCalled());
    // Back to the start screen: acknowledging starts nothing.
    expect(
      await screen.findByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });

  it("keeps ringing when a confirmation is refused, and says why", async () => {
    server({
      session: ringing(1000),
      onConfirm: () => json({ error: "nothing_ringing", serverNow: NOW }, 409),
    });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.confirmWorkNoBreak }),
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

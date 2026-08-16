import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSession, type Session } from "@/lib/session";
import { renderAt, SIGNED_IN } from "@/test/render";

const NOW = 1_800_000_000_000;

/**
 * A socket the test holds both ends of.
 *
 * jsdom has a real WebSocket that would try to reach a real server, so the
 * seam is the constructor — the same seam the rest of the suite uses for
 * `fetch`. Every instance made is recorded, which is how "it reconnected" is
 * asserted at all.
 */
class FakeSocket {
  static opened: FakeSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
    // Connected on the next turn, the way a real one is: nothing may assume a
    // socket is open in the same tick it was constructed.
    queueMicrotask(() => this.onopen?.());
  }

  /** A frame arriving from the server. */
  push(frame: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  /** The connection dropping — a tunnel, a proxy, a laptop lid. */
  drop() {
    this.closed = true;
    this.onclose?.();
  }

  close() {
    this.closed = true;
  }

  /** The most recently opened one — the connection currently in play. */
  static get last(): FakeSocket {
    const socket = FakeSocket.opened.at(-1);
    if (!socket) throw new Error("no socket has been opened");
    return socket;
  }
}

const workSession = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  kind: "work",
  categoryId: "c1",
  categoryName: "درس",
  startedAt: NOW,
  endsAt: NOW + 25 * 60_000,
  durationMs: 25 * 60_000,
  breakEndsAt: NOW + 30 * 60_000,
  resumeCategoryId: null,
  resumeDurationMs: null,
  ...over,
});

const CLASSIC = { shortBreakMs: 5 * 60_000, longBreakMs: 20 * 60_000, perCycle: 4 };

/** A timer frame, exactly as the server encodes one. */
const timerFrame = (session: Session | null, over: Record<string, unknown> = {}) => ({
  type: "timer",
  timer: { session, cycle: { count: 0 }, intervals: CLASSIC, serverNow: NOW, ...over },
});

/** Reads the session out of the context and puts it where a test can see it. */
function Probe() {
  const { session, cycle, intervals } = useSession();
  if (session === undefined) return <p>waiting</p>;
  return (
    <p>
      {session === null ? "idle" : `${session.id} ends ${session.endsAt}`} · {cycle.count} ·{" "}
      {intervals.perCycle}
    </p>
  );
}

/** The server answers the one read the provider makes on sign-in. */
function api(session: Session | null = null) {
  const fetched = vi.fn(async (input: string) => {
    if (input === "/api/session") {
      return new Response(
        JSON.stringify({ session, cycle: { count: 0 }, intervals: CLASSIC, serverNow: NOW }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetched);
  return fetched;
}

describe("the live timer", () => {
  beforeEach(() => {
    FakeSocket.opened = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens a socket on the same origin, with no token in the URL", async () => {
    api();
    renderAt(<Probe />, { auth: SIGNED_IN });

    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    const url = new URL(FakeSocket.last.url);
    expect(url.pathname).toBe("/ws");
    expect(url.protocol).toBe("ws:");
    // The credential is the httpOnly cookie the browser attaches by itself.
    expect(url.search).toBe("");
  });

  it("opens no socket for somebody anonymous", async () => {
    api();
    renderAt(<Probe />, { auth: { status: "anonymous" } });

    // Nothing to push, and the upgrade would only be a 401.
    await Promise.resolve();
    expect(FakeSocket.opened).toHaveLength(0);
  });

  it("shows a pomodoro started on another device", async () => {
    const fetched = api(null);
    renderAt(<Probe />, { auth: SIGNED_IN });

    await screen.findByText(/idle/);
    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

    FakeSocket.last.push(timerFrame(workSession()));

    // The same instants, so the same digits — and without a second request,
    // because the frame is the whole answer.
    await screen.findByText(new RegExp(`s1 ends ${NOW + 25 * 60_000}`));
    expect(fetched.mock.calls.filter(([path]) => path === "/api/session")).toHaveLength(1);
  });

  it("clears a timer cancelled on another device", async () => {
    api(workSession());
    renderAt(<Probe />, { auth: SIGNED_IN });

    await screen.findByText(/s1 ends/);
    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

    FakeSocket.last.push(timerFrame(null));
    await screen.findByText(/idle/);
  });

  it("applies the cycle and intervals a frame carries", async () => {
    api(null);
    renderAt(<Probe />, { auth: SIGNED_IN });

    await screen.findByText(/idle/);
    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

    FakeSocket.last.push(
      timerFrame(null, { cycle: { count: 3 }, intervals: { ...CLASSIC, perCycle: 3 } }),
    );
    await screen.findByText(/idle · 3 · 3/);
  });

  it("reconnects after the socket drops, and leaves the countdown alone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api(workSession());
      renderAt(<Probe />, { auth: SIGNED_IN });

      await screen.findByText(/s1 ends/);
      await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

      FakeSocket.last.drop();

      // The tunnel costs nothing while it lasts: the countdown is computed
      // from the session's own instants, so what is on screen is still right.
      expect(screen.getByText(new RegExp(`s1 ends ${NOW + 25 * 60_000}`))).toBeTruthy();

      // And a new socket is opened, which the server answers with the current
      // state — so the resynchronisation needs nothing from this side.
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a frame it cannot read", async () => {
    api(workSession());
    renderAt(<Probe />, { auth: SIGNED_IN });

    await screen.findByText(/s1 ends/);
    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

    // A frame from another build, and a kind this one does not handle. Neither
    // may blank the screen.
    FakeSocket.last.onmessage?.(new MessageEvent("message", { data: "not json" }));
    FakeSocket.last.push({ type: "feed", entries: [] });

    expect(screen.getByText(new RegExp(`s1 ends ${NOW + 25 * 60_000}`))).toBeTruthy();
  });

  it("closes the socket when there is nobody to hold it for", async () => {
    api();
    const { unmount } = renderAt(<Probe />, { auth: SIGNED_IN });

    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    unmount();

    expect(FakeSocket.last.closed).toBe(true);
    // An unmount is not a drop, so nothing chases it.
    expect(FakeSocket.opened).toHaveLength(1);
  });
});

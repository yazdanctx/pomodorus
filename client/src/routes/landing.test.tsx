import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copy } from "@/lib/copy";
import { faClock } from "@/lib/format";
import { noteServerTime } from "@/lib/server-clock";
import { LandingRoute } from "@/routes/landing";
import type { Auth } from "@/lib/auth";
import { renderAt, SIGNED_IN } from "@/test/render";

const NOW = 1_800_000_000_000;

type Entry = {
  handle: string;
  kind: "work" | "shortBreak" | "longBreak";
  task: string | null;
  endsAt: number;
};

const working = (over: Partial<Entry> = {}): Entry => ({
  handle: "yazdan",
  kind: "work",
  task: "درس",
  endsAt: NOW + 25 * 60_000,
  ...over,
});

/**
 * The seam is `fetch` and the socket, as everywhere else. The landing is fed
 * server payloads and the assertion is what is on screen.
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
    queueMicrotask(() => this.onopen?.());
  }

  push(frame: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  close() {
    this.closed = true;
  }

  static get last(): FakeSocket {
    const socket = FakeSocket.opened.at(-1);
    if (!socket) throw new Error("no socket has been opened");
    return socket;
  }
}

const feedFrame = (entries: Entry[]) => ({
  type: "feed",
  feed: { entries, serverNow: NOW },
});

function server(entries: Entry[] = []) {
  const fetched = vi.fn(async (input: string) => {
    if (input === "/api/feed") {
      return new Response(JSON.stringify({ entries, serverNow: NOW }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetched);
  return fetched;
}

const renderLanding = (auth: Auth = { status: "anonymous" }) =>
  renderAt(<LandingRoute />, { auth });

beforeEach(() => {
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  noteServerTime(NOW, performance.now());
});
afterEach(() => vi.unstubAllGlobals());

describe("the landing page", () => {
  it("renders for somebody who has never signed in", async () => {
    server();
    renderLanding();

    // The wordmark, the pitch, the way in, the note — all of it, with no
    // account and no request having to succeed first.
    expect(screen.getByRole("heading", { name: copy.landing.tagline })).toBeTruthy();
    expect(screen.getByText(copy.landing.pitch)).toBeTruthy();
    expect(screen.getByText(copy.landing.sub)).toBeTruthy();
    expect(screen.getByRole("link", { name: copy.landing.enter })).toBeTruthy();
    await screen.findByText(copy.feed.empty);
  });

  it("offers the timer to somebody signed in", () => {
    server();
    renderLanding(SIGNED_IN);

    expect(screen.getByRole("link", { name: copy.landing.goWork })).toBeTruthy();
    expect(screen.queryByRole("link", { name: copy.landing.enter })).toBeNull();
  });

  it("reserves the CTA box rather than flashing the wrong label", () => {
    server();
    renderLanding({ status: "loading" });

    // Neither label, and the box is still there — reserving is not guessing.
    expect(screen.queryByRole("link", { name: copy.landing.enter })).toBeNull();
    expect(screen.queryByRole("link", { name: copy.landing.goWork })).toBeNull();
    expect(document.querySelector(".h-11.w-40")).toBeTruthy();
  });

  it("links to the source", () => {
    server();
    renderLanding();

    const link = screen.getByRole("link", { name: new RegExp(copy.landing.github) });
    expect(link.getAttribute("href")).toContain("github.com");
    // A new tab, and no window.opener handed to it.
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("paints the hero as its own box, so nothing moves when the image lands", () => {
    server();
    const { container } = renderLanding();

    const hero = container.querySelector("img");
    expect(hero?.getAttribute("src")).toBe("/main.avif");
    // The wrapper owns the aspect ratio; the image has no intrinsic size here.
    expect(hero?.parentElement?.className).toContain("aspect-video");
    expect(hero?.getAttribute("fetchpriority")).toBe("high");
  });
});

describe("the feed", () => {
  it("lists who is working, with the task and the time left", async () => {
    server([working()]);
    renderLanding();

    await screen.findByRole("link", { name: "yazdan" });
    expect(screen.getByText(/درس/)).toBeTruthy();
    expect(screen.getByText(faClock(25 * 60_000))).toBeTruthy();
  });

  it("links a handle to its profile, in Latin type", async () => {
    server([working()]);
    renderLanding();

    const link = await screen.findByRole("link", { name: "yazdan" });
    expect(link.getAttribute("href")).toBe("/u/yazdan");
    expect(link.className).toContain("ui-sans-serif");
  });

  it("shows a private task generically", async () => {
    // The name never left the server, so there is nothing here to mask.
    server([working({ task: null })]);
    renderLanding();

    await screen.findByText(new RegExp(copy.feed.privateTask));
    expect(screen.getByRole("link", { name: "yazdan" })).toBeTruthy();
  });

  it("shows a break without a countdown", async () => {
    server([working({ kind: "shortBreak", task: null, endsAt: NOW + 5 * 60_000 })]);
    renderLanding();

    await screen.findByText(new RegExp(copy.feed.onBreak));
    // How long somebody's rest has left is not what this list is for, and it
    // would read as work.
    expect(screen.queryByText(faClock(5 * 60_000))).toBeNull();
  });

  it("updates without a reload when somebody starts", async () => {
    const fetched = server([]);
    renderLanding();

    await screen.findByText(copy.feed.empty);
    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

    FakeSocket.last.push(feedFrame([working()]));

    await screen.findByRole("link", { name: "yazdan" });
    // One request, and everything after it was pushed.
    expect(fetched.mock.calls.filter(([path]) => path === "/api/feed")).toHaveLength(1);
  });

  it("updates without a reload when somebody stops", async () => {
    server([working()]);
    renderLanding();

    await screen.findByRole("link", { name: "yazdan" });
    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

    FakeSocket.last.push(feedFrame([]));
    await screen.findByText(copy.feed.empty);
  });

  it("drops a row at its bell without being told to", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // A pomodoro with two seconds left. Nothing will be pushed when it ends —
      // a bell is derived from a stored fact plus now, and there is no
      // scheduler anywhere in this app.
      server([working({ endsAt: NOW + 2_000 })]);
      renderLanding();

      await vi.waitFor(() => expect(screen.getByRole("link", { name: "yazdan" })).toBeTruthy());

      noteServerTime(NOW + 3_000, performance.now());
      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => expect(screen.queryByRole("link", { name: "yazdan" })).toBeNull());
      expect(screen.getByText(copy.feed.empty)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing rather than 'nobody is here' before the answer arrives", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container } = renderLanding();

    expect(screen.queryByText(copy.feed.empty)).toBeNull();
    // And the box still holds a row's height, so the page does not reflow
    // under whoever is reading it when the answer lands.
    expect(container.querySelector("section li")).toBeTruthy();
  });

  it("opens one socket for the whole page", async () => {
    server([working()]);
    renderLanding(SIGNED_IN);

    // The feed and the session both listen; the server pushes both kinds down
    // one connection, and a second would be a second upgrade and a second
    // keepalive for nothing.
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0));
    expect(FakeSocket.opened).toHaveLength(1);
  });
});

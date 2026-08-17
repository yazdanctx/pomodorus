import { beforeEach, describe, expect, it, vi } from "vitest";

import copy from "./copy.json";

type Listener = (event: unknown) => void;

type Window = { visibilityState: string; focus: () => Promise<void> };

/**
 * Stands up the worker's globals and loads it, which is the only way to reach
 * the handlers: a service worker's whole interface is what it registered on
 * `self`, so a test drives it by firing the events a browser would.
 */
async function worker(windows: Window[] = []) {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const claim = vi.fn(async () => {});
  const skipWaiting = vi.fn(async () => {});

  vi.stubGlobal("self", {
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
    skipWaiting,
    registration: { showNotification },
    clients: {
      matchAll: vi.fn(async () => windows),
      openWindow,
      claim,
    },
  });

  vi.resetModules();
  await import("./sw");

  /** Fires an event at the worker and waits for whatever it took on. */
  const fire = async (type: string, event: Record<string, unknown> = {}) => {
    const waited: Promise<unknown>[] = [];
    listeners.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => waited.push(promise),
    });
    await Promise.all(waited);
  };

  /** A push carrying a payload the server would have sent. */
  const push = (bell: unknown) =>
    fire("push", {
      data: bell === undefined ? null : { json: () => bell },
    });

  return { fire, push, showNotification, openWindow, claim, skipWaiting };
}

const bell = (kind: string) => ({
  sessionId: "6f1e0f0e-0000-4000-8000-000000000000",
  kind,
  endsAt: 1_773_566_700_000,
});

const hidden: Window = { visibilityState: "hidden", focus: vi.fn(async () => {}) };
const visible: Window = {
  visibilityState: "visible",
  focus: vi.fn(async () => {}),
};

beforeEach(() => vi.unstubAllGlobals());

describe("a push at the bell", () => {
  it("announces a pomodoro with no tab on screen", async () => {
    const { push, showNotification } = await worker([hidden]);

    await push(bell("work"));

    expect(showNotification).toHaveBeenCalledOnce();
    const [title, options] = showNotification.mock.calls[0] as unknown as [
      string,
      NotificationOptions,
    ];
    expect(title).toBe(copy.notifications.workDoneTitle);
    expect(options.body).toBe(copy.notifications.workDoneBody);
    // It stays until it is dismissed rather than fading after a few seconds:
    // the whole point of it is not being missed.
    expect(options.requireInteraction).toBe(true);
    expect(options.dir).toBe("rtl");
  });

  it("says a break ended when a break ended", async () => {
    const { push, showNotification } = await worker([hidden]);

    await push(bell("shortBreak"));

    const [title] = showNotification.mock.calls[0] as unknown as [string];
    expect(title).toBe(copy.notifications.breakDoneTitle);
  });

  it("stands down when a tab is on screen", async () => {
    const { push, showNotification } = await worker([hidden, visible]);

    await push(bell("work"));

    // That tab is already ringing — the alarm sounds, the title counts up, and
    // it posts its own notification. A second one here is the same bell twice.
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("announces something even when the payload is unreadable", async () => {
    const { fire, showNotification } = await worker([hidden]);

    await fire("push", {
      data: {
        json: () => {
          throw new Error("not JSON");
        },
      },
    });

    // A browser that is woken and shown nothing eventually posts its own "this
    // site was updated in the background", and keeps doing it.
    expect(showNotification).toHaveBeenCalledOnce();
    const [title] = showNotification.mock.calls[0] as unknown as [string];
    expect(title).toBe(copy.notifications.workDoneTitle);
  });

  it("uses one tag, so bells replace rather than stack", async () => {
    const { push, showNotification } = await worker([hidden]);

    await push(bell("work"));
    await push(bell("shortBreak"));

    const tags = showNotification.mock.calls.map(
      (call) => (call as unknown as [string, NotificationOptions])[1].tag,
    );
    expect(tags).toEqual(["pomodorus", "pomodorus"]);
  });
});

describe("tapping the notification", () => {
  it("brings an open window forward rather than opening a second one", async () => {
    const existing = { visibilityState: "hidden", focus: vi.fn(async () => {}) };
    const { fire, openWindow } = await worker([existing]);
    const close = vi.fn();

    await fire("notificationclick", { notification: { close } });

    expect(close).toHaveBeenCalledOnce();
    expect(existing.focus).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens the timer when nothing is open", async () => {
    const { fire, openWindow } = await worker([]);

    await fire("notificationclick", { notification: { close: vi.fn() } });

    // The timer, and never a confirmation: ending a ring is a deliberate tap
    // inside the app, and a notification dismissed by a sleeve is not that.
    expect(openWindow).toHaveBeenCalledWith("/app");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Loaded fresh for every test. The module remembers one thing — whether this
// device has a subscription, which the in-tab alarm reads at the bell — and a
// device is exactly what a test is standing up.
let push: typeof import("@/lib/push");
const enableNotifications = () => push.enableNotifications();
const registerWorker = () => push.registerWorker();
const pushSupported = () => push.pushSupported();
const pushHandlesTheBell = () => push.pushHandlesTheBell();

beforeEach(async () => {
  vi.resetModules();
  push = await import("@/lib/push");
});

/**
 * The subscription a browser hands back, as `PushSubscription.toJSON()` spells
 * it. Only the endpoint and the two keys are ever read.
 */
function subscription(endpoint: string) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "public-half", auth: "secret" } }),
  };
}

type Browser = {
  permission?: NotificationPermission;
  /** What the browser answers when asked; "granted" unless a case says else. */
  grants?: NotificationPermission;
  /** An existing subscription, as a device that has been here before has. */
  existing?: ReturnType<typeof subscription> | null;
  /** Whether this browser can be pushed at all. */
  canPush?: boolean;
};

/** Stands up just enough of a browser for the push path to run in jsdom. */
function browser(options: Browser = {}) {
  const {
    permission = "default",
    grants = "granted",
    existing = null,
    canPush = true,
  } = options;

  let granted = permission;
  const requestPermission = vi.fn(async () => {
    granted = grants;
    return grants;
  });

  const Notification = {
    get permission() {
      return granted;
    },
    requestPermission,
  };
  vi.stubGlobal("Notification", Notification);

  const subscribe = vi.fn(async (_options: PushSubscriptionOptionsInit) =>
    subscription("https://push.example/new"),
  );
  const manager = {
    getSubscription: vi.fn(async () => existing),
    subscribe,
  };
  const register = vi.fn(async () => ({ pushManager: manager }));

  if (canPush) {
    vi.stubGlobal("PushManager", class {});
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        ready: Promise.resolve({ pushManager: manager }),
      },
    });
  } else {
    vi.unstubAllGlobals();
    vi.stubGlobal("Notification", Notification);
    Reflect.deleteProperty(navigator, "serviceWorker");
  }

  return { requestPermission, subscribe, register, manager };
}

/** The calls the app made, in order, so a test can say what came before what. */
function fetching(
  answers: Record<string, unknown> = { "/api/push/key": { publicKey: "BBBB-_-" } },
) {
  const calls: string[] = [];
  const fetch = vi.fn(async (path: string) => {
    calls.push(path);
    return {
      ok: true,
      status: 200,
      json: async () => answers[path] ?? {},
    } as Response;
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

/** The JSON a recorded fetch call carried. */
function bodyOf(call: unknown): string {
  const [, init] = call as [string, RequestInit];
  return init.body as string;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("asking to be allowed to notify", () => {
  it("asks at the moment a session starts, before anything is fetched", async () => {
    const { requestPermission } = browser();
    const { calls } = fetching();

    await enableNotifications();

    expect(requestPermission).toHaveBeenCalledOnce();
    // A prompt is only allowed while the gesture that led to it is still being
    // handled. A round trip before it is what quietly disqualifies it, so the
    // ask has to be the first thing that happens.
    expect(calls).not.toHaveLength(0);
    expect(requestPermission.mock.invocationCallOrder[0]).toBeLessThan(
      // The fetch for the server key came after the prompt, not before.
      (globalThis.fetch as unknown as { mock: { invocationCallOrder: number[] } })
        .mock.invocationCallOrder[0]!,
    );
  });

  it("does not ask again once it has an answer", async () => {
    const { requestPermission } = browser({ permission: "granted" });
    fetching();

    await enableNotifications();

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("subscribes nothing when the answer was no", async () => {
    const { subscribe } = browser({ grants: "denied" });
    const { calls } = fetching();

    await enableNotifications();

    expect(subscribe).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("is silent in a browser that has no notifications at all", async () => {
    vi.unstubAllGlobals();
    const { calls } = fetching();

    await expect(enableNotifications()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("subscribing this device", () => {
  it("registers with the server key and posts what the browser gave back", async () => {
    const { subscribe } = browser();
    const { fetch } = fetching();

    await enableNotifications();

    expect(subscribe).toHaveBeenCalledOnce();
    const asked = subscribe.mock.calls[0]![0];
    // Every push this app sends ends in a notification, which is the deal the
    // browsers offer in exchange for waking a closed app.
    expect(asked.userVisibleOnly).toBe(true);
    // The key arrives as base64url and has to reach the browser as bytes.
    // This one is seven characters — so it needs padding — and carries both of
    // the substituted characters, which is the whole of what can go wrong.
    expect(Array.from(asked.applicationServerKey as Uint8Array)).toEqual([
      4, 16, 65, 251, 255,
    ]);

    const post = fetch.mock.calls.find(
      ([path]) => path === "/api/push/subscribe",
    );
    expect(post).toBeDefined();
    expect(JSON.parse(bodyOf(post))).toEqual({
      endpoint: "https://push.example/new",
      p256dh: "public-half",
      auth: "secret",
    });
  });

  it("reuses the subscription a device already has", async () => {
    const { subscribe } = browser({
      permission: "granted",
      existing: subscription("https://push.example/known"),
    });
    const { fetch, calls } = fetching();

    await enableNotifications();

    // Its endpoint is this device's name to its push service and does not go
    // stale, so there is nothing to mint — and no reason to ask for the key.
    expect(subscribe).not.toHaveBeenCalled();
    expect(calls).toEqual(["/api/push/subscribe"]);
    expect(JSON.parse(bodyOf(fetch.mock.calls[0])).endpoint).toBe(
      "https://push.example/known",
    );
  });

  it("subscribes to nothing on a deployment with no keypair", async () => {
    const { subscribe } = browser({ permission: "granted" });
    const { calls } = fetching({ "/api/push/key": { publicKey: "" } });

    await enableNotifications();

    expect(subscribe).not.toHaveBeenCalled();
    expect(calls).toEqual(["/api/push/key"]);
  });

  it("swallows a browser that refuses to subscribe", async () => {
    const { manager } = browser({ permission: "granted" });
    manager.subscribe.mockRejectedValueOnce(new Error("no push service"));
    fetching();

    // The session is running either way. A failure here costs a notification
    // and must never reach the screen.
    await expect(enableNotifications()).resolves.toBeUndefined();
  });

  it("still grants permission in a browser that cannot be pushed", async () => {
    const { requestPermission } = browser({ canPush: false });
    const { calls } = fetching();

    await enableNotifications();

    // The tab's own notification needs the permission and nothing else, so a
    // desktop Safari with no push still rings with a tab open.
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0);
    expect(pushSupported()).toBe(false);
  });
});

describe("which carrier announces the bell", () => {
  // The in-tab alarm reads this at the ring, synchronously, to decide whether
  // to stand down for the worker. Between the two of them there must be
  // exactly one notification, and never zero.

  it("is the worker once this device has subscribed", async () => {
    browser();
    fetching();
    expect(pushHandlesTheBell()).toBe(false);

    await enableNotifications();

    expect(pushHandlesTheBell()).toBe(true);
  });

  it("is not the worker when the server was never told", async () => {
    const { manager } = browser({ permission: "granted" });
    manager.subscribe.mockRejectedValueOnce(new Error("no push service"));
    fetching();

    await enableNotifications();

    // Nothing is going to be pushed here, so the tab must keep announcing it.
    expect(pushHandlesTheBell()).toBe(false);
  });

  it("is the worker on a device that subscribed on an earlier visit", async () => {
    browser({
      permission: "granted",
      existing: subscription("https://push.example/known"),
    });

    // Read back at boot, long before any bell, so the answer is settled by the
    // time an alarm asks for it.
    await registerWorker();

    expect(pushHandlesTheBell()).toBe(true);
  });
});

describe("the service worker", () => {
  it("is registered at the root, so its scope is the whole app", async () => {
    const { register } = browser();

    await registerWorker();

    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("is not registered where it cannot be", async () => {
    const { register } = browser({ canPush: false });

    await expect(registerWorker()).resolves.toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });
});

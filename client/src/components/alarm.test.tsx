import { fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Alarm } from "@/components/alarm";
import { AuthProvider, type AuthValue } from "@/lib/auth";
import { copy } from "@/lib/copy";
import { faClock, faElapsed } from "@/lib/format";
import { noteServerTime } from "@/lib/server-clock";
import { SessionProvider, type Session } from "@/lib/session";
import { holding, SIGNED_IN, workSession } from "@/test/render";

// The noise itself is WebAudio, which jsdom does not implement and which a
// test could not hear anyway. What is worth asserting is that the alarm is
// asked to start and asked to stop at the right moments.
const sound = vi.hoisted(() => ({
  startAlarm: vi.fn(),
  stopAlarm: vi.fn(),
  unlockAudio: vi.fn(),
}));
vi.mock("@/lib/sound", () => sound);

const NOW = 1_800_000_000_000;

/** A session still counting down. */
const running = () => workSession(NOW + 25 * 60_000);

/** A session whose nominal end was `ago` milliseconds back: ringing. */
const ringing = (ago = 1000) => workSession(NOW - ago);

const auth: AuthValue = { ...SIGNED_IN, refresh: async () => {} };

function Mounted({
  session,
  confirm,
}: {
  session: Session | null;
  confirm?: () => Promise<void>;
}) {
  const value = { ...holding(session), confirm: confirm ?? (async () => {}) };
  return (
    <AuthProvider value={auth}>
      <SessionProvider value={value}>
        <Alarm />
      </SessionProvider>
    </AuthProvider>
  );
}

/** A notification permission the browser has granted, and a spy on the class. */
function allowNotifications(permission: NotificationPermission = "granted") {
  const created = vi.fn();
  class FakeNotification {
    static permission = permission;
    static requestPermission = async () => permission;
    constructor(title: string, options?: NotificationOptions) {
      created(title, options);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  return created;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  sound.startAlarm.mockClear();
  sound.stopAlarm.mockClear();
  noteServerTime(NOW, performance.now());
});

describe("the alarm", () => {
  it("sounds while a session is ringing", () => {
    render(<Mounted session={ringing()} />);

    expect(sound.startAlarm).toHaveBeenCalled();
  });

  it("stays silent while a session is still running", () => {
    render(<Mounted session={running()} />);

    expect(sound.startAlarm).not.toHaveBeenCalled();
  });

  it("stops the moment the ring is acknowledged", () => {
    const { rerender } = render(<Mounted session={ringing()} />);
    // Confirming leaves no live session, which is the only thing that ends a
    // ring — a tab regaining focus would not have.
    rerender(<Mounted session={null} />);

    expect(sound.stopAlarm).toHaveBeenCalled();
  });

  it("keeps ringing across ticks, without restarting on each one", async () => {
    render(<Mounted session={ringing()} />);

    // The clock ticks several times a second; the alarm is one run, not one
    // per frame. `startAlarm` is idempotent, but calling it per tick would
    // still say the ring was being rediscovered.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(sound.startAlarm).toHaveBeenCalledTimes(1);
  });
});

describe("the notification", () => {
  it("fires exactly once per ring", async () => {
    const created = allowNotifications();
    render(<Mounted session={ringing()} />);

    // Not one per ding: re-alerting on the ding cadence is intolerable on
    // most platforms, so a re-render or a tick must not fire another.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0]?.[0]).toBe(copy.notifications.workDoneTitle);
    // And it stays on screen rather than fading after a few seconds.
    expect(created.mock.calls[0]?.[1]).toMatchObject({ requireInteraction: true });
  });

  it("fires once even under the double-invoked effects of StrictMode", () => {
    const created = allowNotifications();
    render(
      <StrictMode>
        <Mounted session={ringing()} />
      </StrictMode>,
    );

    // React mounts, unmounts and remounts every effect in development. A ring
    // announced twice is two alerts for one bell.
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("says nothing when permission was never granted", () => {
    const created = allowNotifications("default");
    render(<Mounted session={ringing()} />);

    expect(created).not.toHaveBeenCalled();
  });

  it("does not fire for a session that is merely running", () => {
    const created = allowNotifications();
    render(<Mounted session={running()} />);

    expect(created).not.toHaveBeenCalled();
  });
});

describe("what does not confirm a ring", () => {
  it("keeps ringing through focus, keys, pointers and a page becoming visible", () => {
    const confirm = vi.fn(async () => {});
    render(<Mounted session={ringing()} confirm={confirm} />);

    // The listeners the alarm does add exist to unlock audio after a reload,
    // and must never grow into an acknowledgement: only a deliberate tap on
    // the ring screen ends a ring.
    fireEvent.focus(window);
    fireEvent.keyDown(document.body, { key: "Enter" });
    fireEvent.pointerDown(document.body);
    fireEvent(document, new Event("visibilitychange"));

    expect(confirm).not.toHaveBeenCalled();
    expect(sound.stopAlarm).not.toHaveBeenCalled();
  });
});

describe("the tab title", () => {
  it("carries the countdown while a session runs", async () => {
    render(<Mounted session={running()} />);

    await waitFor(() => expect(document.title).toBe(faClock(25 * 60_000)));
  });

  it("carries the ring time once the bell has gone", async () => {
    render(<Mounted session={ringing(65_000)} />);

    await waitFor(() =>
      expect(document.title).toBe(`${faElapsed(65_000)} — ${copy.app.name}`),
    );
  });

  it("is the app's own name when nothing is live", async () => {
    render(<Mounted session={null} />);

    await waitFor(() => expect(document.title).toBe(copy.app.name));
  });
});

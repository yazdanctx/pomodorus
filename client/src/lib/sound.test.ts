import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A WebAudio context that records when tones were scheduled.
 *
 * jsdom implements none of this, and the point of the alarm is not the tone
 * anyway: it is *when* the tones are put on the audio clock. That clock runs
 * on the audio thread and is not throttled, which is the whole reason the
 * dings are scheduled ahead rather than fired from a timer.
 */
class FakeAudioContext {
  state = "running";
  currentTime = 0;
  /** Every `osc.start(at)` this context has seen. */
  starts: number[] = [];

  createGain() {
    return {
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
      disconnect: () => {},
    };
  }

  createOscillator() {
    return {
      type: "sine",
      frequency: { value: 0 },
      connect: () => {},
      start: (at: number) => this.starts.push(at),
      stop: () => {},
    };
  }

  get destination() {
    return {};
  }

  async resume() {
    this.state = "running";
  }
}

let audio: FakeAudioContext;

/** The module holds one context for the life of a page, so each test gets a
 * fresh copy of it rather than the previous test's schedule. */
async function alarm() {
  vi.resetModules();
  audio = new FakeAudioContext();
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        return audio as unknown as AudioContext;
      }
    },
  );
  return import("@/lib/sound");
}

/** The instants the dings themselves were scheduled at, in order. */
const dings = () => audio.starts.filter(Number.isInteger).sort((a, b) => a - b);

beforeEach(() => vi.unstubAllGlobals());

describe("the alarm", () => {
  it("schedules far enough ahead to survive a throttled tab", async () => {
    const { startAlarm, stopAlarm } = await alarm();
    startAlarm();

    // Hidden tabs are clamped to roughly one timer callback a minute — which
    // is exactly the case the alarm exists for. So the schedule is more than
    // a minute deep the moment it starts: the top-up interval can be starved
    // for a full minute without the alarm missing a beat.
    const scheduled = dings();
    expect(scheduled.at(-1)).toBeGreaterThan(60);
    // Every three seconds, all the way there.
    expect(scheduled.slice(0, 3)).toEqual([0, 3, 6]);
    expect(scheduled.length).toBeGreaterThan(20);

    stopAlarm();
  });

  it("is idempotent, so it can be driven straight from render state", async () => {
    const { startAlarm, stopAlarm } = await alarm();
    startAlarm();
    const scheduled = audio.starts.length;
    startAlarm();

    expect(audio.starts.length).toBe(scheduled);
    stopAlarm();
  });

  it("stops without giving up the context a gesture unlocked", async () => {
    const { startAlarm, stopAlarm } = await alarm();
    startAlarm();
    stopAlarm();
    const afterStop = audio.starts.length;

    // Dings already on the audio clock cannot be unscheduled — the bus is cut
    // instead, so they play into nothing. What must not happen is the context
    // being torn down: rebuilding one needs a fresh user gesture, and the next
    // ring would be mute.
    startAlarm();
    expect(audio.starts.length).toBeGreaterThan(afterStop);
    stopAlarm();
  });
});

/**
 * The alarm, via WebAudio — no audio asset to ship or fail to load.
 *
 * A ringing session alarms every few seconds until it is confirmed, and it has
 * to keep doing so from a background tab. `setInterval` cannot be trusted for
 * that: hidden pages are clamped to about one callback a minute, which is
 * exactly the case the alarm exists for. So the dings are scheduled ahead **on
 * the audio clock**, which runs on the audio thread and is not throttled — the
 * interval below only tops the schedule up, and can be starved for a full
 * minute without the alarm missing a beat.
 *
 * Browsers only allow audio after a user gesture, so `unlockAudio` must be
 * called from an event handler before any of this can be heard.
 */

const DING_MS = 3_000;
/** How far ahead dings are scheduled. Must exceed the worst-case throttle. */
const LOOKAHEAD_MS = 120_000;
/** How often the schedule is topped up. Throttling stretches this, not the alarm. */
const TOPUP_MS = 30_000;

// The context outlives any one alarm, because closing it would throw away the
// gesture that unlocked it — and the next ring would then be mute despite the
// user having been interacting all along.
let ctx: AudioContext | null = null;
// One bus per alarm run. Disconnecting it silences everything routed through
// it at once, including a tone already sounding, which is the only way to stop
// mid-ding without discarding the context.
let bus: GainNode | null = null;
let topup: ReturnType<typeof setInterval> | null = null;
/** Audio-clock time up to which dings are already scheduled. */
let scheduledUntil = 0;

// jsdom has no WebAudio, and neither has a browser old enough to matter. The
// alarm is then simply silent: everything else about a ring still works.
function context(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  ctx ??= new AudioContext();
  return ctx;
}

/**
 * Resume audio from a user gesture. Called when a session starts, and again
 * opportunistically on the first interaction after a reload — a reload
 * destroys the AudioContext, so an alarm that is already ringing is silent
 * until the user touches the page.
 *
 * If an alarm is waiting on exactly this, it starts sounding immediately
 * rather than at the next top-up.
 */
export function unlockAudio() {
  const audio = context();
  if (!audio || audio.state === "running") return;
  void audio.resume().then(() => {
    if (topup !== null) fill();
  });
}

/** Schedule one two-tone ding at `at` on the audio clock. */
function ding(audio: AudioContext, at: number, dest: AudioNode) {
  [880, 1320].forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = at + i * 0.18;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(start);
    osc.stop(start + 0.55);
  });
}

function fill() {
  const audio = context();
  if (!audio || bus === null) return;
  if (audio.state !== "running") {
    // A suspended context's clock is frozen, so anything scheduled while it
    // was asleep would all come due at once on resume. Schedule nothing, and
    // start again from `currentTime` once it is awake.
    scheduledUntil = 0;
    void audio.resume();
    return;
  }
  const step = DING_MS / 1000;
  let next = scheduledUntil === 0 ? audio.currentTime : scheduledUntil + step;
  const until = audio.currentTime + LOOKAHEAD_MS / 1000;
  while (next <= until) {
    ding(audio, next, bus);
    scheduledUntil = next;
    next += step;
  }
}

/**
 * Start alarming, and keep alarming until `stopAlarm`. Idempotent: calling it
 * again while it is already running does nothing, so it is safe to drive
 * straight from render state.
 */
export function startAlarm() {
  if (topup !== null) return;
  const audio = context();
  if (!audio) return;
  bus = audio.createGain();
  bus.connect(audio.destination);
  scheduledUntil = 0;
  fill();
  topup = setInterval(fill, TOPUP_MS);
}

/** Stop alarming, instantly, without giving up the context's unlock. */
export function stopAlarm() {
  if (topup !== null) {
    clearInterval(topup);
    topup = null;
  }
  scheduledUntil = 0;
  if (bus !== null) {
    // Dings already on the audio clock cannot be unscheduled; cutting the bus
    // leaves them playing into nothing.
    bus.disconnect();
    bus = null;
  }
}

import { useEffect, useState } from "react";

/**
 * What time it is, according to the server.
 *
 * The device's clock is trusted to measure elapsed time and never to say what
 * time it is. So this keeps an anchor — a server instant paired with a reading
 * of the monotonic clock — and adds elapsed monotonic time to it. `Date.now()`
 * is deliberately not used after the first paint: it jumps when the user or
 * the OS corrects the clock, and a countdown that jumps with it would be a
 * countdown nobody could trust.
 *
 * This is what makes a dropped connection invisible. The countdown is computed
 * from the session's start and length, not streamed, so a tunnel costs nothing
 * — and the anchor re-corrects on the next response that arrives.
 */
let anchorMonotonic = performance.now();
let anchorServer = Date.now();
let corrected = false;

/**
 * Fold a response's `serverNow` into the anchor.
 *
 * The round trip is split in half, which assumes the two legs took the same
 * time. They will not have exactly, and it does not matter: the error is a
 * fraction of a second against a countdown measured in minutes, and it shrinks
 * on every subsequent response.
 */
export function noteServerTime(serverNow: number, sentAtMonotonic: number) {
  const now = performance.now();
  anchorMonotonic = now;
  anchorServer = serverNow + (now - sentAtMonotonic) / 2;
  corrected = true;
}

/** The server's clock, in epoch milliseconds. */
export function serverNow(): number {
  return anchorServer + (performance.now() - anchorMonotonic);
}

/** Whether any response has arrived yet to correct against. */
export function isCorrected(): boolean {
  return corrected;
}

/**
 * Re-render on an interval, so a countdown ticks.
 *
 * The interval is the only thing repeating here — nothing is scheduled against
 * the session's end, because the end is derived from `endsAt` and this clock
 * every time it is read. A tick that is late, or that never fires because the
 * tab was asleep, therefore costs a stale frame and never a wrong state.
 */
export function useTick(everyMs = 250): number {
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);

  return now;
}

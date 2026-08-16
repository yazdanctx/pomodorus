/**
 * The start screen, the running clock, the ring and the break arrive across
 * #14 to #17. This ticket owns the page inset the timer sits in — `p-4 sm:p-6`
 * rather than the standard `p-6`, because the −/clock/+ row is what sets the
 * horizontal budget on a phone.
 */
export function TimerRoute() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-4 sm:p-6" />
  );
}

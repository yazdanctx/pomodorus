/**
 * Elapsed share, under the clock, so you can see how far in you are without
 * reading digits.
 *
 * It inherits RTL and so fills from the right. The width is clamped to
 * [0, 100] because a negative percentage is invalid CSS: the declaration would
 * be dropped, `width` would fall back to `auto`, and the bar would flash full
 * white at exactly the moment a session ends.
 *
 * Measured against the real end rather than the nominal duration — under fast
 * sessions those differ, and the bar has to track the clock somebody is
 * actually watching.
 */
export function ProgressBar({
  startedAt,
  endsAt,
  now,
}: {
  startedAt: number;
  endsAt: number;
  now: number;
}) {
  const span = Math.max(1, endsAt - startedAt);
  const elapsed = ((now - startedAt) / span) * 100;
  const percent = Math.min(100, Math.max(0, elapsed));

  return (
    <div className="h-1 w-full max-w-xs bg-muted">
      <div
        className="h-full bg-foreground transition-[width] duration-500 ease-linear"
        style={{ width: `${percent}%` }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      />
    </div>
  );
}

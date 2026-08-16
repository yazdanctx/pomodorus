import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { copy, t } from "@/lib/copy";
import { faDigits } from "@/lib/format";

/**
 * The band a pomodoro may be drawn from, and the step it moves in. The server
 * refuses anything outside this, because a client that could ask for any
 * length could mint focus time.
 */
export const MIN_MINUTES = 15;
export const MAX_MINUTES = 60;
export const STEP_MINUTES = 5;

export const DEFAULT_MINUTES = 25;

export const isWorkMinutes = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MIN_MINUTES &&
  value <= MAX_MINUTES &&
  value % STEP_MINUTES === 0;

/**
 * − / clock / + . The button for a limit you have reached is disabled rather
 * than silently doing nothing, so the range is visible instead of being
 * something you discover by pressing.
 *
 * `dir="ltr"` on the row: minus belongs on the left of the clock whatever the
 * document direction, because that is where a number line puts it.
 */
export function Stepper({
  minutes,
  onChange,
}: {
  minutes: number;
  onChange: (minutes: number) => void;
}) {
  const atMin = minutes <= MIN_MINUTES;
  const atMax = minutes >= MAX_MINUTES;

  return (
    <div className="flex items-center gap-2 sm:gap-4" dir="ltr">
      <Button
        variant="outline"
        size="icon-lg"
        disabled={atMin}
        aria-label={t(copy.timer.minutes, { m: faDigits(minutes - STEP_MINUTES) })}
        onClick={() => onChange(minutes - STEP_MINUTES)}
      >
        <Minus />
      </Button>

      <span className="font-mono text-5xl font-bold tracking-tight tabular-nums sm:text-7xl">
        {faDigits(minutes)}
      </span>

      <Button
        variant="outline"
        size="icon-lg"
        disabled={atMax}
        aria-label={t(copy.timer.minutes, { m: faDigits(minutes + STEP_MINUTES) })}
        onClick={() => onChange(minutes + STEP_MINUTES)}
      >
        <Plus />
      </Button>
    </div>
  );
}

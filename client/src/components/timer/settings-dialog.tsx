import { Minus, Plus, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { Failure } from "@/components/failure";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { messageFor } from "@/lib/api";
import { copy, t } from "@/lib/copy";
import { faDigits } from "@/lib/format";
import { shown, step, type IntervalKey, type Intervals } from "@/lib/intervals";

/**
 * One interval, as the same − / + pair the start screen uses for the pomodoro
 * length. The button for an end of the band is disabled rather than silently
 * doing nothing, so the range is visible instead of being something you
 * discover by pressing.
 *
 * `dir="ltr"` on the control: minus belongs to the left of the value whatever
 * the document direction, because that is where a number line puts it.
 */
function IntervalRow({
  label,
  value,
  down,
  up,
  busy,
  onChange,
}: {
  label: string;
  value: string;
  /** The next stop each way, or null at the end of the band. */
  down: Intervals | null;
  up: Intervals | null;
  /** Whether an edit is in flight, and the value on screen therefore not settled. */
  busy: boolean;
  onChange: (next: Intervals) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2" dir="ltr">
        <Button
          variant="outline"
          size="icon"
          aria-label={`${label} −`}
          disabled={busy || down === null}
          onClick={() => down && onChange(down)}
        >
          <Minus />
        </Button>
        {/* Fixed width and tabular figures, so «۵ دقیقه» and «۲۰ دقیقه» do not
            shift the buttons and all three rows line up as one column. */}
        <span className="w-24 text-center tabular-nums">{value}</span>
        <Button
          variant="outline"
          size="icon"
          aria-label={`${label} +`}
          disabled={busy || up === null}
          onClick={() => up && onChange(up)}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

/**
 * The break lengths and the cycle, opened from the start screen.
 *
 * They are settings rather than start-screen controls because you do not choose
 * them per session — they are a policy. The pomodoro's own length stays outside,
 * where it genuinely is a per-session decision.
 *
 * They live on the account (#17): the server owns the timer, so a phone and a
 * laptop cannot be allowed to disagree about how long a rest is. Every tap is
 * therefore a request, and the value on screen is the server's answer rather
 * than anything this dialog holds — which is what makes a failed tap visibly
 * fail instead of leaving a number that only exists here.
 */
export function SettingsDialog({
  intervals,
  onSave,
}: {
  intervals: Intervals;
  onSave: (next: Intervals) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  // The value on screen is the server's answer, never a number this device is
  // holding — the same rule the task list follows, and the reason a write that
  // has not landed has not happened. So while one is in flight the row goes
  // briefly inert, rather than counting a second tap off a value that is about
  // to move and silently dropping it.
  const [pending, setPending] = useState(false);

  async function save(next: Intervals) {
    setError(null);
    setPending(true);
    try {
      await onSave(next);
    } catch (failure) {
      setError(messageFor(failure));
    } finally {
      setPending(false);
    }
  }

  const row = (key: IntervalKey, label: string, format: (n: number) => string) => (
    <IntervalRow
      label={label}
      value={format(shown(intervals, key))}
      down={step(intervals, key, -1)}
      up={step(intervals, key, 1)}
      busy={pending}
      onChange={(next) => void save(next)}
    />
  );

  const minutes = (n: number) => t(copy.timer.minutes, { m: faDigits(n) });
  const count = (n: number) => t(copy.timer.count, { n: faDigits(n) });

  return (
    <Dialog onOpenChange={() => setError(null)}>
      {/* Quiet on purpose: a monochrome, flat theme has no colour or elevation
          to demote anything with, so size and placement are the only tools. */}
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <SlidersHorizontal />
          {copy.timer.settings}
        </Button>
      </DialogTrigger>

      <DialogContent>
        {/* Read by the screen reader, not by the eye: v1's dialog is three
            rows and a close button, and a heading over them would be the one
            thing on this screen saying what is already obvious. */}
        <DialogHeader className="sr-only">
          <DialogTitle>{copy.timer.settingsTitle}</DialogTitle>
          <DialogDescription>{copy.timer.settingsNote}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          {row("shortBreakMs", copy.timer.settingsShortBreak, minutes)}
          {row("longBreakMs", copy.timer.settingsLongBreak, minutes)}
          {row("perCycle", copy.timer.settingsPerCycle, count)}
          <Failure message={error} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

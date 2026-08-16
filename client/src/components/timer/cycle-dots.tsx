import { copy, t } from "@/lib/copy";
import { faDigits } from "@/lib/format";

/**
 * How far into the cycle you are, as one dot per pomodoro.
 *
 * Clamped rather than grown: somebody who keeps declining the long break is
 * owed one every time and their count runs past the cycle's length, but the
 * row of dots is a shape you read at a glance and a fifth dot appearing in it
 * would say something the technique does not.
 *
 * The whole of it is a title rather than visible text — the dots are ambient,
 * and the screen already has one number set large on it.
 *
 * How many dots there are is the account's setting rather than anything the
 * cycle carries, so shortening a cycle is visible on the very next render.
 */
export function CycleDots({ count, perCycle }: { count: number; perCycle: number }) {
  return (
    <div
      className="flex gap-2"
      title={t(copy.timer.cycleTitle, {
        n: faDigits(Math.min(count, perCycle)),
        total: faDigits(perCycle),
      })}
    >
      {Array.from({ length: perCycle }, (_, i) => (
        <span
          key={i}
          // rounded-none is spelled out rather than inherited from the radius
          // token: a stray shadcn default is otherwise one upgrade away from
          // rounding these into pills.
          className={`h-2 w-2 rounded-none ${i < count ? "bg-foreground" : "bg-muted"}`}
        />
      ))}
    </div>
  );
}

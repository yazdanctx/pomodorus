import { BellRing, Play, SkipForward } from "lucide-react";
import { useState } from "react";

import { CategoryPicker } from "@/components/category-picker";
import { Failure } from "@/components/failure";
import { CycleDots } from "@/components/timer/cycle-dots";
import { ProgressBar } from "@/components/timer/progress-bar";
import { SettingsDialog } from "@/components/timer/settings-dialog";
import {
  DEFAULT_MINUTES,
  isWorkMinutes,
  Stepper,
} from "@/components/timer/stepper";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { messageFor } from "@/lib/api";
import { useCategories } from "@/lib/categories";
import { copy, t } from "@/lib/copy";
import { faClock, faDigits, faDuration, faElapsed } from "@/lib/format";
import type { Intervals } from "@/lib/intervals";
import { usePersisted } from "@/lib/persisted";
import { enableNotifications } from "@/lib/push";
import { useTick } from "@/lib/server-clock";
import {
  breakSurvives,
  isBreak,
  isRinging,
  useSession,
  type Cycle,
  type Session,
  type Today,
} from "@/lib/session";
import { unlockAudio } from "@/lib/sound";

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * A user gesture is the only moment a browser will unlock audio or show the
 * permission prompt, and both are for a bell that is still 25 minutes away.
 * Asked for whenever something is started, or the ring arrives in silence.
 *
 * The permission is asked for once and then used by both carriers of the ring:
 * the tab's own notification, and — for the tab that is closed by the time the
 * bell goes — the push subscription this also registers.
 */
function primeAlerts() {
  unlockAudio();
  void enableNotifications();
}

/** What to call a session: the task it is on, or the kind of rest it is. */
function sessionLabel(session: Session): string {
  switch (session.kind) {
    case "shortBreak":
      return copy.timer.kindShortBreak;
    case "longBreak":
      return copy.timer.kindLongBreak;
    default:
      return session.categoryName ?? copy.timer.privateTask;
  }
}

/**
 * The timer.
 *
 * The screen it shows is derived from one question — is there a live session,
 * and has its bell gone? — and never from anything this component remembers.
 * That is what makes a second device open into the running timer rather than
 * offering a start button, and what makes the answer the same on both.
 *
 * The picked task and the picked length live here rather than on the start
 * screen, because the ring screen needs them too: "another one" means the same
 * task at the same length, and it is offered from the far side of a break —
 * where the break itself is the better authority on what that was, and this
 * device's picks are only the fallback.
 *
 * The page inset is `p-4 sm:p-6` rather than the standard `p-6`: the
 * −/clock/+ row is what sets the horizontal budget on a phone.
 */
export function TimerRoute() {
  const { session, cycle, intervals, today, start, cancel, confirm, save } = useSession();
  // The screens are one question asked of the clock, not states anything
  // stores: before its end a session is running, after its end and
  // unacknowledged it is ringing.
  const now = useTick();
  const { categories, create, update, remove } = useCategories();

  // Which task and which length were last chosen is a per-device preference
  // the server has no opinion about, so a reload finds them where they were.
  const [selected, setSelected] = usePersisted<string | null>(
    "pomodorus.category",
    null,
    isNullableString,
  );
  const [minutes, setMinutes] = usePersisted<number>(
    "pomodorus.minutes",
    DEFAULT_MINUTES,
    isWorkMinutes,
  );

  // A task that has been deleted since it was picked is not a task to start
  // on, and the server would refuse it. The list is the truth; a remembered
  // id — this device's, or the one a break came back with — is only a claim.
  const known = (id: string | null) =>
    id !== null && categories?.some((c) => c.id === id) ? id : null;
  const picked = known(selected);

  // A continue that fails has nowhere to report: acknowledging the break
  // already dropped this screen for the start screen. The reason is carried
  // across rather than swallowed, because a button that appears to do nothing
  // is the thing this app keeps promising not to be.
  const [handover, setHandover] = useState<string | null>(null);

  /** Begin a pomodoro on a task, at a length. Throws. */
  async function beginWork(categoryId: string | null, durationMs: number) {
    if (categoryId === null) return;
    setHandover(null);
    primeAlerts();
    // Left where the timer now is, so the start screen behind this agrees with
    // what is running — including on a device that picked neither.
    setSelected(categoryId);
    setMinutes(durationMs / 60_000);
    await start(categoryId, durationMs);
  }

  /** What "another one" means from this break, and whether it is offered. */
  const resume = (rest: Session) => ({
    categoryId: known(rest.resumeCategoryId) ?? picked,
    durationMs: rest.resumeDurationMs ?? minutes * 60_000,
  });

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-4 sm:p-6">
      {session === undefined ? (
        // Reserved rather than guessed: flashing a start button at somebody
        // who is mid-pomodoro is the shift this exists to prevent.
        <Skeleton className="h-64 w-full" />
      ) : session === null ? (
        <StartScreen
          categories={categories}
          picked={picked}
          onSelect={setSelected}
          actions={{ create, update, remove }}
          minutes={minutes}
          onMinutes={setMinutes}
          intervals={intervals}
          onIntervals={save}
          notice={handover}
          today={today}
          onStart={() => beginWork(picked, minutes * 60_000)}
        />
      ) : isRinging(session, now) ? (
        <Ringing
          session={session}
          cycle={cycle}
          perCycle={intervals.perCycle}
          now={now}
          canContinue={resume(session).categoryId !== null}
          onConfirm={confirm}
          onContinue={async () => {
            const { categoryId, durationMs } = resume(session);
            try {
              await beginWork(categoryId, durationMs);
            } catch (failure) {
              setHandover(messageFor(failure));
            }
          }}
        />
      ) : (
        <Running
          session={session}
          cycle={cycle}
          perCycle={intervals.perCycle}
          now={now}
          onEnd={cancel}
        />
      )}
    </main>
  );
}

function StartScreen({
  categories,
  picked,
  onSelect,
  actions,
  minutes,
  onMinutes,
  intervals,
  onIntervals,
  notice,
  today,
  onStart,
}: {
  categories: ReturnType<typeof useCategories>["categories"];
  picked: string | null;
  onSelect: (id: string | null) => void;
  actions: Pick<ReturnType<typeof useCategories>, "create" | "update" | "remove">;
  minutes: number;
  onMinutes: (minutes: number) => void;
  /** The account's breaks and cycle, edited in the dialog below the button. */
  intervals: Intervals;
  onIntervals: (next: Intervals) => Promise<void>;
  /** Why the last "another one" never became a pomodoro, if it didn't. */
  notice: string | null;
  /** How the day has gone so far, or unknown while the server has not said. */
  today: Today | undefined;
  onStart: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function begin() {
    setError(null);
    setPending(true);
    try {
      await onStart();
    } catch (failure) {
      setError(messageFor(failure));
      setPending(false);
    }
  }

  return (
    <div className="grid w-full min-w-0 gap-0">
      {categories === null ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <CategoryPicker
          categories={categories}
          selected={picked}
          onSelect={onSelect}
          actions={actions}
        />
      )}

      {/* border-t-0 because the picker above supplies that edge. px-3 on
          phones is what the −/clock/+ row imposes, not a type decision. */}
      <div className="flex w-full min-w-0 flex-col items-center gap-6 border border-t-0 px-3 py-12 sm:px-10 sm:py-20">
        <Stepper minutes={minutes} onChange={onMinutes} />

        <Failure message={error ?? notice} />

        <Button
          className="w-40"
          disabled={picked === null || pending}
          onClick={() => void begin()}
        >
          {copy.timer.start}
        </Button>

        {/* The other three intervals, one step quieter than the button above
            them: they are a policy you set once, not a per-session choice. */}
        <SettingsDialog intervals={intervals} onSave={onIntervals} />
      </div>

      <TodayLine today={today} />
    </div>
  );
}

/**
 * How the day has gone so far, under the panel and a step quieter than
 * anything in it: it is the only thing on this screen that is not a control.
 *
 * The row holds its height whatever it knows, which is what stops the panel
 * above it moving when the answer lands. And it says the day is empty only
 * once the server has said so — before that it says nothing at all, because
 * «امروز تمرکز نکردی کلا» flashed at somebody who has done four pomodoros is a
 * worse lie than a blank line.
 */
function TodayLine({ today }: { today: Today | undefined }) {
  return (
    // Margin rather than padding: `pt-6` inside `h-5` is padding larger than
    // the box it is in, so the row was never the height it claimed.
    <p className="mt-6 flex h-5 items-center justify-center text-xs text-muted-foreground">
      {today === undefined
        ? null
        : today.count === 0
          ? copy.timer.todayEmpty
          : t(copy.timer.todaySummary, {
              count: faDigits(today.count),
              duration: faDuration(today.totalMs),
            })}
    </p>
  );
}

/**
 * A session counting down: a pomodoro, or the rest that followed one.
 *
 * A break's countdown is shorter than its nominal length whenever the bell
 * before it was left ringing, and its progress bar starts part-filled — both
 * fall out of the same fact, that the break was anchored at the pomodoro's
 * nominal end rather than at the tap that acknowledged it. Nothing here has to
 * know a ring happened.
 */
function Running({
  session,
  cycle,
  perCycle,
  now,
  onEnd,
}: {
  session: Session;
  cycle: Cycle;
  /** How long a cycle is, which is the account's setting rather than the cycle's. */
  perCycle: number;
  now: number;
  onEnd: (id: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  const remaining = Math.max(0, session.endsAt - now);
  const resting = isBreak(session);

  async function abandon() {
    setError(null);
    try {
      await onEnd(session.id);
    } catch (failure) {
      setError(messageFor(failure));
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <p className="max-w-full truncate text-center text-muted-foreground">
        {sessionLabel(session)}
      </p>

      {/* dir="ltr" and tabular: Persian digits in a right-to-left document
          still count left to right, and without tabular figures the digits
          jitter on every tick. */}
      <p
        className="font-mono text-6xl font-bold tracking-tight tabular-nums sm:text-7xl"
        dir="ltr"
      >
        {faClock(remaining)}
      </p>

      {/* Keyed by the session, so a new one mounts at 0% rather than
          transitioning down from the last one's finished fill. */}
      <ProgressBar
        key={session.id}
        startedAt={session.startedAt}
        endsAt={session.endsAt}
        now={now}
      />

      <CycleDots count={cycle.count} perCycle={perCycle} />

      <Failure message={error} />

      {/* One request behind both: abandoning a pomodoro and skipping a break
          are the same fact — this session is over and was not seen through.
          What they mean is not the same, which is why they do not read the
          same: giving up is quiet and outlined, going back to work early is
          filled and carries the skip arrow. Both are in v1's screenshots. */}
      {resting ? (
        <Button variant="secondary" onClick={() => void abandon()}>
          <SkipForward />
          {copy.timer.skipBreak}
        </Button>
      ) : (
        <Button variant="outline" onClick={() => void abandon()}>
          {copy.timer.cancelWork}
        </Button>
      )}
    </div>
  );
}

/**
 * A session that has reached its end and is waiting to be acknowledged.
 *
 * A pomodoro here is already credited, at its exact nominal end and its full
 * nominal length, so nothing on this screen changes the record — which is why
 * there is deliberately no cancel. A ringing pomodoro is complete.
 *
 * What the ring does spend is the break. It was anchored at the nominal end,
 * so the time spent here comes out of it, and the button says which of the two
 * things confirming will do *before* it is pressed: start the rest that is
 * left, or drop back to the start screen because there is none.
 *
 * A ringing break asks the technique's own question instead — another one, or
 * stop — because after a rest that genuinely is a decision, not friction.
 *
 * The clock counts *up*, and it is the one hue the app allows itself: a clock
 * that has stopped meaning "time left" has to be unmistakable from across a
 * room.
 */
function Ringing({
  session,
  cycle,
  perCycle,
  now,
  canContinue,
  onConfirm,
  onContinue,
}: {
  session: Session;
  cycle: Cycle;
  /** How long a cycle is, which is the account's setting rather than the cycle's. */
  perCycle: number;
  now: number;
  canContinue: boolean;
  onConfirm: (id: string) => Promise<Session | null>;
  onContinue: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const resting = isBreak(session);

  /** Only a deliberate tap ends a ring — and this is the tap. */
  async function acknowledge(next?: () => Promise<void>) {
    // The tap is a gesture, which is the only thing that can bring audio back
    // after a reload — and the confirmation may fail, leaving it still ringing.
    // Audio only: a permission prompt belongs to starting something, not to
    // silencing something.
    unlockAudio();
    setError(null);
    setPending(true);
    try {
      await onConfirm(session.id);
      await next?.();
    } catch (failure) {
      setError(messageFor(failure));
      setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <p className="max-w-full truncate text-center text-muted-foreground">
        {sessionLabel(session)}
      </p>

      <div className="flex items-center gap-2">
        <BellRing className="size-8 animate-pulse" />
        <p className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {resting ? copy.timer.ringBreakTitle : copy.timer.ringWorkTitle}
        </p>
      </div>

      {/* Ring time, not a countdown, and never focus time. */}
      <p
        className="font-mono text-6xl font-bold tracking-tight text-rose-500 tabular-nums sm:text-7xl"
        dir="ltr"
      >
        {faElapsed(now - session.endsAt)}
      </p>

      <CycleDots count={cycle.count} perCycle={perCycle} />

      <Failure message={error} />

      {resting ? (
        // Continue over done: going round again is the likelier answer and the
        // one the technique is about, so it gets the weight.
        <div className="flex w-full max-w-xs flex-col gap-2">
          <Button
            size="lg"
            variant="outline"
            disabled={pending || !canContinue}
            onClick={() => void acknowledge(onContinue)}
          >
            <Play />
            {copy.timer.continueWork}
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => void acknowledge()}
          >
            {copy.timer.confirmBreak}
          </Button>
        </div>
      ) : (
        // Tab focus, a resume, a mouse moving and a notification being clicked
        // all leave the ring alone. The label is the promise this tap can
        // actually keep: once the ring has eaten the whole break there is no
        // chill to offer, and saying otherwise would be a lie told a second
        // before it is found out.
        <Button
          className="w-56"
          variant="outline"
          disabled={pending}
          onClick={() => void acknowledge()}
        >
          {breakSurvives(session, now)
            ? copy.timer.confirmWork
            : copy.timer.confirmWorkNoBreak}
        </Button>
      )}
    </div>
  );
}

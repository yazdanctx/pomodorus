import { BellRing } from "lucide-react";
import { useState } from "react";

import { CategoryPicker } from "@/components/category-picker";
import { Failure } from "@/components/failure";
import { ProgressBar } from "@/components/timer/progress-bar";
import {
  DEFAULT_MINUTES,
  isWorkMinutes,
  Stepper,
} from "@/components/timer/stepper";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { messageFor } from "@/lib/api";
import { useCategories } from "@/lib/categories";
import { copy } from "@/lib/copy";
import { faClock, faElapsed } from "@/lib/format";
import { usePersisted } from "@/lib/persisted";
import { useTick } from "@/lib/server-clock";
import { isRinging, useSession, type Session } from "@/lib/session";
import { unlockAudio } from "@/lib/sound";

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * The timer.
 *
 * The screen it shows is derived from one question — is there a live session?
 * — and never from anything this component remembers. That is what makes a
 * second device open into the running timer rather than offering a start
 * button, and what makes the answer the same on both.
 *
 * The page inset is `p-4 sm:p-6` rather than the standard `p-6`: the
 * −/clock/+ row is what sets the horizontal budget on a phone.
 */
export function TimerRoute() {
  const { session, start, cancel, confirm } = useSession();
  // The three screens are one question asked of the clock, not three states
  // anything stores: before its end a session is running, after its end and
  // unacknowledged it is ringing.
  const now = useTick();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-4 sm:p-6">
      {session === undefined ? (
        // Reserved rather than guessed: flashing a start button at somebody
        // who is mid-pomodoro is the shift this exists to prevent.
        <Skeleton className="h-64 w-full" />
      ) : session === null ? (
        <StartScreen onStart={start} />
      ) : isRinging(session, now) ? (
        <Ringing session={session} now={now} onConfirm={confirm} />
      ) : (
        <Running session={session} now={now} onCancel={cancel} />
      )}
    </main>
  );
}

function StartScreen({
  onStart,
}: {
  onStart: (categoryId: string, durationMs: number) => Promise<Session | null>;
}) {
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

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A task that has been deleted since it was picked is not a task to start
  // on, and the server would refuse it.
  const picked =
    selected !== null && categories?.some((c) => c.id === selected)
      ? selected
      : null;

  async function begin() {
    if (picked === null) return;
    // A user gesture is the only moment a browser will unlock audio or show
    // the permission prompt, and both are for a bell that is still 25 minutes
    // away. Asked for here or the ring is silent when it arrives.
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    setError(null);
    setPending(true);
    try {
      await onStart(picked, minutes * 60_000);
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
          onSelect={setSelected}
          actions={{ create, update, remove }}
        />
      )}

      {/* border-t-0 because the picker above supplies that edge. px-3 on
          phones is what the −/clock/+ row imposes, not a type decision. */}
      <div className="flex w-full min-w-0 flex-col items-center gap-6 border border-t-0 px-3 py-12 sm:px-10 sm:py-20">
        <Stepper minutes={minutes} onChange={setMinutes} />

        <Failure message={error} />

        <Button
          className="w-40"
          disabled={picked === null || pending}
          onClick={() => void begin()}
        >
          {copy.timer.start}
        </Button>
      </div>
    </div>
  );
}

function Running({
  session,
  now,
  onCancel,
}: {
  session: Session;
  now: number;
  onCancel: (id: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  const remaining = Math.max(0, session.endsAt - now);

  async function abandon() {
    setError(null);
    try {
      await onCancel(session.id);
    } catch (failure) {
      setError(messageFor(failure));
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <p className="max-w-full truncate text-center text-muted-foreground">
        {session.categoryName ?? copy.timer.privateTask}
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

      <Failure message={error} />

      <Button variant="outline" onClick={() => void abandon()}>
        {copy.timer.cancelWork}
      </Button>
    </div>
  );
}

/**
 * A session that has reached its end and is waiting to be acknowledged.
 *
 * The work is already credited, at its exact nominal end and its full nominal
 * length, so nothing on this screen changes the record — which is why there is
 * deliberately no cancel here. A ringing pomodoro is complete.
 *
 * The clock counts *up*, and it is the one hue the app allows itself: a clock
 * that has stopped meaning "time left" has to be unmistakable from across a
 * room.
 */
function Ringing({
  session,
  now,
  onConfirm,
}: {
  session: Session;
  now: number;
  onConfirm: (id: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function acknowledge() {
    // The tap is a gesture, which is the only thing that can bring audio back
    // after a reload — and the confirmation may fail, leaving it still ringing.
    unlockAudio();
    setError(null);
    setPending(true);
    try {
      await onConfirm(session.id);
    } catch (failure) {
      setError(messageFor(failure));
      setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <p className="max-w-full truncate text-center text-muted-foreground">
        {session.categoryName ?? copy.timer.privateTask}
      </p>

      <div className="flex items-center gap-2">
        <BellRing className="size-8 animate-pulse" />
        <p className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {copy.timer.ringWorkTitle}
        </p>
      </div>

      {/* Ring time, not a countdown, and never focus time. */}
      <p
        className="font-mono text-6xl font-bold tracking-tight text-rose-500 tabular-nums sm:text-7xl"
        dir="ltr"
      >
        {faElapsed(now - session.endsAt)}
      </p>

      <Failure message={error} />

      {/* Only a deliberate tap ends a ring. Tab focus, a resume, a mouse
          moving and a notification being clicked all leave it alone.

          The label is the no-break one: there are no breaks yet, so promising
          a chill this tap cannot deliver would be a lie. Breaks bring the
          other label back with the break that earns it. */}
      <Button
        className="w-56"
        variant="outline"
        disabled={pending}
        onClick={() => void acknowledge()}
      >
        {copy.timer.confirmWorkNoBreak}
      </Button>
    </div>
  );
}

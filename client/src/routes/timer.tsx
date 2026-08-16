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
import { faClock } from "@/lib/format";
import { usePersisted } from "@/lib/persisted";
import { useTick } from "@/lib/server-clock";
import { useLiveSession, type Session } from "@/lib/session";

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
  const { session, start, cancel } = useLiveSession();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-4 sm:p-6">
      {session === undefined ? (
        // Reserved rather than guessed: flashing a start button at somebody
        // who is mid-pomodoro is the shift this exists to prevent.
        <Skeleton className="h-64 w-full" />
      ) : session === null ? (
        <StartScreen onStart={start} />
      ) : (
        <Running session={session} onCancel={cancel} />
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
  onCancel,
}: {
  session: Session;
  onCancel: (id: string) => Promise<void>;
}) {
  const now = useTick();
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

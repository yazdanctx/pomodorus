"use client";

import { useConvexAuth } from "convex/react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { copy, t } from "@/lib/copy";
import { faClock, faDigits } from "@/lib/format";
import { unlockAudio } from "@/lib/sound";
import { CategoryPicker } from "@/components/category-picker";
import { OfflineIndicator } from "@/components/offline-indicator";
import { SettingsDialog } from "@/components/settings-dialog";
import { BellRing, Minus, Play, Pause, Plus, SkipForward, X } from "lucide-react";
import {
  useLocalIdentity,
  useLocalState,
  useTimerNow,
  isPaused,
  remainingMs,
} from "@/lib/local/hooks";
import { breakAfterRing, effectiveCategories } from "@/lib/local/device";
import {
  cancelWork,
  confirm,
  continueWork,
  pauseWork,
  resumeWork,
  selectCategory,
  setSetting,
  skipBreak,
  startWork,
} from "@/lib/local/store";
import {
  type LocalState,
  type SessionKind,
  endAt,
  stepValue,
} from "@/lib/local/types";

const KIND_LABEL: Record<SessionKind, string> = {
  work: copy.timer.kindWork,
  shortBreak: copy.timer.kindShortBreak,
  longBreak: copy.timer.kindLongBreak,
};

/**
 * Dev fast mode: when on, every session ends after FAST_MS (3s) so the full
 * cycle can be exercised quickly. Controlled by NEXT_PUBLIC_DEV_FAST.
 *
 * Default OFF so you can test real durations and the pause/resume feature.
 * Set NEXT_PUBLIC_DEV_FAST=true in .env.local for quick 3-second cycles.
 */
const FAST =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_DEV_FAST === "true";

/** The name to show for a work session's task, or the private-task stand-in. */
function taskName(state: LocalState, categoryClientId: string | null): string {
  return (
    effectiveCategories(state).find((c) => c.clientId === categoryClientId)?.name ??
    copy.timer.privateTask
  );
}

/** The four-dot cycle indicator, clamped to the configured cycle length. */
function CycleDots({ count, perCycle }: { count: number; perCycle: number }) {
  return (
    <div
      className="flex gap-2"
      title={t(copy.timer.cycleTitle, {
        n: faDigits(count),
        total: faDigits(perCycle),
      })}
    >
      {Array.from({ length: perCycle }, (_, i) => (
        <span
          key={i}
          className={`h-2 w-2 rounded-none ${i < Math.min(count, perCycle) ? "bg-foreground" : "bg-muted"}`}
        />
      ))}
    </div>
  );
}

/**
 * A session that has ended and is waiting to be acknowledged
 * (docs/adr/0004-confirmed-transitions.md).
 *
 * The session is already over and, if it was work, already credited — nothing
 * on this screen changes the record. What it changes is the break: the counter
 * is ring time, and ring time comes out of the break, so a confirmation forty
 * minutes late buys you nothing but silence.
 *
 * There is deliberately no cancel. A ringing pomodoro is complete, indivisible
 * and quite possibly already synced.
 */
function RingScreen({ state, now }: { state: LocalState; now: number }) {
  const ring = state.ringing;
  if (!ring) return null;
  const isWork = ring.kind === "work";
  const breakLeft = breakAfterRing(ring, now);

  return (
    <section className="flex w-full flex-col items-center gap-6">
      <p className="max-w-full truncate text-center text-muted-foreground">
        {isWork ? taskName(state, ring.categoryClientId) : KIND_LABEL[ring.kind]}
      </p>
      <div className="flex items-center gap-2">
        <BellRing className="size-8 animate-pulse" />
        <p className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {isWork ? copy.timer.ringWorkTitle : copy.timer.ringBreakTitle}
        </p>
      </div>
      {/* Ring time, not a countdown: it counts up, and it is never focus.
          Red is the one hue the app allows itself, and this is what it is
          for — a clock that has stopped meaning "time left" has to be
          unmistakable from across a room. */}
      <p
        className="font-mono text-6xl font-bold tabular-nums tracking-tight text-rose-500 sm:text-7xl"
        dir="ltr"
      >
        +{faClock(now - ring.endedAt)}
      </p>
      <CycleDots count={state.cycleCount} perCycle={state.settings.perCycle} />
      {isWork ? (
        <Button
          size="lg"
          variant="outline"
          className="w-56"
          onClick={() => {
            unlockAudio();
            confirm();
          }}
        >
          {breakLeft > 0 ? copy.timer.confirmWork : copy.timer.confirmWorkNoBreak}
        </Button>
      ) : (
        // Continue / done: after a break the decision really is "another one,
        // or stop" — that is the technique's own fork, not friction.
        <div className="flex w-full max-w-xs flex-col gap-2">
          <Button
            size="lg"
            variant="outline"
            disabled={state.selectedCategoryId === null}
            onClick={() => {
              unlockAudio();
              continueWork(FAST);
            }}
          >
            <Play />
            {copy.timer.continueWork}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              unlockAudio();
              confirm();
            }}
          >
            {copy.timer.confirmBreak}
          </Button>
        </div>
      )}
    </section>
  );
}

export function TimerApp() {
  // The timer is local-first: everything below renders from the local
  // store; the server is only involved via the SyncEngine in the layout.
  const identity = useLocalIdentity();
  const state = useLocalState();
  const { isAuthenticated } = useConvexAuth();
  const now = useTimerNow();

  // Ask for notification permission once, right after login.
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  const running = state.running;
  const ringing = state.ringing;
  const paused = isPaused(running);
  const remainingTimeMs = remainingMs(running, now);

  // Live countdown in the tab title, and ring time once the bell has gone —
    // a muted tab still says what is happening.
    useEffect(() => {
      document.title = ringing
        ? `+${faClock(Date.now() - ringing.endedAt)} — ${copy.app.name}`
        : running && remainingTimeMs !== null
          ? faClock(remainingTimeMs)
          : copy.app.name;
      return () => {
        document.title = copy.app.name;
      };
    }, [running, remainingTimeMs, ringing]);

  // No cached identity: either the first online visit is still loading the
  // username, or this device has never signed in and is offline.
  if (identity === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {isAuthenticated ? "…" : copy.offline.needInternet}
      </div>
    );
  }

  const { workMinutes } = state.settings;
    const down = stepValue("work", workMinutes, -1);
    const up = stepValue("work", workMinutes, 1);
    const remaining = getRemaining();

    function getRemaining(): number | null {
      if (!running) return null;
      return Math.max(0, remainingMs(running, now) ?? 0);
    }

    function getProgressBarWidth(): number | undefined {
      if (!running) return undefined;
      // Active elapsed excludes all paused time, so the bar freezes while paused.
      const ref = running.pausedAt ?? now;
      const inProgressPause = running.pausedAt != null ? ref - running.pausedAt : 0;
      const totalPause = (running.pausedDurationMs ?? 0) + inProgressPause;
      const activeElapsed = Math.max(0, (ref - running.startedAt) - totalPause);
      const progress = Math.min(1, activeElapsed / running.durationMs);
      return Math.max(0, 1 - progress);
    }

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-4 sm:p-6">
      {ringing ? (
              <RingScreen state={state} now={now} />
            ) : running && remainingTimeMs !== null ? (
              <section className="flex w-full flex-col items-center gap-6">
                {/* A 40-character category name has no spaces to break on, so it is
                    clipped rather than allowed to widen the column. */}
                <p className="max-w-full truncate text-center text-muted-foreground">
                  {running.kind === "work"
                    ? taskName(state, running.categoryClientId)
                    : KIND_LABEL[running.kind]}
                </p>
                <p
                  className="font-mono text-6xl font-bold tabular-nums tracking-tight sm:text-7xl"
                  dir="ltr"
                >
                  {faClock(remainingTimeMs ?? 0)}
                </p>
                {/* Elapsed share of the session. Measured against the real end time,
                    so a dev fast session fills over its three seconds rather than
                    creeping along its nominal 25 minutes. Fills from the right,
                    inheriting the page's RTL direction. Keyed by session id so a new
                    session mounts at 0% (full gray) instead of transitioning from the
                    previous session's finished fill. The 2Hz clock can lag a beat
                    behind a just-started session, making the share negative; a
                    negative percentage width is invalid CSS, so the fill would fall
                    back to width:auto — a full-white flash until the next tick. The
                    clamp keeps the width in [0, 100] so it is always a valid bar. */}
                <div className="h-1 w-full max-w-xs bg-muted" aria-hidden>
                  <div
                    key={running.id}
                    className="h-full bg-foreground transition-[width] duration-500 ease-linear"
                    style={{
                                          width: `${((getProgressBarWidth() ?? 0) * 100)}%`,
                                        }}
                  />
                </div>
                <CycleDots count={state.cycleCount} perCycle={state.settings.perCycle} />
                {running.kind === "work" ? (
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={cancelWork}>
                      <div className="flex items-center gap-1">
                        <X size={10} />
                        {copy.timer.cancelWork}
                      </div>
                    </Button>
                    {paused ? (
                      <Button
                        variant="outline"
                        size="lg"
                        className="w-20"
                        onClick={resumeWork}
                      >
                        <Play size={20} />
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="lg"
                        className="w-20"
                        onClick={pauseWork}
                      >
                        <Pause size={20} />
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button variant="outline" onClick={skipBreak}>
                    <SkipForward />
                    {copy.timer.skipBreak}
                  </Button>
                )}
              </section>
            ) : (
        <div className="grid w-full min-w-0">
          {/* Both the picked task and the chosen length live in the persisted
              local state, not in React — a reload must not lose your place. */}
          <CategoryPicker
            selected={state.selectedCategoryId}
            onSelect={selectCategory}
          />

          {/* The padding is the phone constraint here, not the type: at the
              desktop px-10 the ±/clock row alone is wider than a 360px frame. */}
          <section className="flex w-full min-w-0 flex-col items-center gap-6 border border-t-0 px-3 py-12 sm:px-10 sm:py-20">
            {/* The clock is the control: ± walks the pomodoro length along its
                range, and the button for an end you have reached is disabled. */}
            <div className="flex items-center gap-2 sm:gap-4" dir="ltr">
              <Button
                variant="outline"
                size="icon"
                aria-label={t(copy.timer.minutes, { m: faDigits(down ?? workMinutes) })}
                disabled={down === null}
                onClick={() => down !== null && setSetting("work", down)}
              >
                <Minus className="size-4" />
              </Button>
              <p className="font-mono text-5xl font-bold tabular-nums tracking-tight sm:text-7xl">
                {faClock(workMinutes * 60_000)}
              </p>
              <Button
                variant="outline"
                size="icon"
                aria-label={t(copy.timer.minutes, { m: faDigits(up ?? workMinutes) })}
                disabled={up === null}
                onClick={() => up !== null && setSetting("work", up)}
              >
                <Plus className="size-4" />
              </Button>
            </div>
            <Button
              size="lg"
              className="w-40"
              disabled={state.selectedCategoryId === null}
              onClick={() => {
                // User gesture: the only moment browsers reliably allow the
                // permission prompt and unlocking audio playback.
                unlockAudio();
                if (
                  "Notification" in window &&
                  Notification.permission === "default"
                ) {
                  Notification.requestPermission();
                }
                startWork(FAST);
              }}
            >
              <Play />
              {copy.timer.start}
            </Button>
            <SettingsDialog />
          </section>
        </div>
      )}
      <OfflineIndicator />
    </div>
  );
}

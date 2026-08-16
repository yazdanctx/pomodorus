import { useEffect, useRef } from "react";

import { copy } from "@/lib/copy";
import { faClock, faElapsed } from "@/lib/format";
import { useTick } from "@/lib/server-clock";
import { isRinging, useSession } from "@/lib/session";
import { startAlarm, stopAlarm, unlockAudio } from "@/lib/sound";

/**
 * The ringing alarm and the tab title, mounted once above the router.
 *
 * It lives above the route on purpose: a session that ends while you are
 * reading someone's profile — or the landing page — has to be able to reach
 * you, or the app has silently swallowed the one thing it promised not to.
 *
 * Headless. The ring's *screen* is the timer route; this is the noise, the
 * notification, and what the tab says while you are not looking at it.
 */
export function Alarm() {
  const { session } = useSession();
  // The tick is what turns a stored `endsAt` into a bell without anything
  // being scheduled or pushed. A tick that is late costs a stale frame; it
  // cannot cost a missed ring, because the state is recomputed from the clock
  // every time it is read.
  const now = useTick();
  const ringing =
    session != null && isRinging(session, now) ? session : null;
  const id = ringing?.id ?? null;
  const kind = ringing?.kind;

  useEffect(() => {
    if (id === null) return;
    startAlarm();
    return stopAlarm;
  }, [id]);

  // A reload destroys the AudioContext, and browsers will not rebuild one
  // without a gesture — so an alarm that was already ringing comes back mute.
  // Any interaction anywhere in the app is enough to bring it back.
  useEffect(() => {
    if (id === null) return;
    const wake = () => unlockAudio();
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [id]);

  // One notification per ring, not one per ding: re-firing on the ding cadence
  // re-alerts on most platforms and is intolerable. `requireInteraction` is the
  // notification-shaped version of nagging — it stays on screen until dismissed
  // instead of fading after a few seconds. Clicking it does not confirm:
  // only a deliberate tap in the app ends a ring.
  // Which ring has already been announced. A ref rather than the effect's own
  // deps: React remounts effects in StrictMode, and a second notification for
  // one bell is exactly what "exactly one per ring" rules out.
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (id === null || announced.current === id) return;
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }
    announced.current = id;
    const work = kind === "work";
    new Notification(
      work ? copy.notifications.workDoneTitle : copy.notifications.breakDoneTitle,
      {
        body: work
          ? copy.notifications.workDoneBody
          : copy.notifications.breakDoneBody,
        tag: "pomodorus",
        requireInteraction: true,
      },
    );
    // Deliberately keyed by the ring alone: a re-render, a reconnect or a
    // clock correction must not fire a second one.
  }, [id, kind]);

  // Live countdown in the tab title, and ring time once the bell has gone — a
  // muted tab still says what is happening. The ring carries the app's name
  // and the countdown does not: «۲۴:۵۹» in a tab strip can only be a timer,
  // where «+۰۰:۱۲» on its own says nothing at all.
  useEffect(() => {
    document.title =
      ringing !== null
        ? `${faElapsed(now - ringing.endsAt)} — ${copy.app.name}`
        : session != null
          ? faClock(session.endsAt - now)
          : copy.app.name;
    return () => {
      document.title = copy.app.name;
    };
  }, [session, ringing, now]);

  return null;
}

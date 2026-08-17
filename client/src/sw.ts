/**
 * The service worker, which exists for one reason: the bell reaching you with
 * the app fully closed.
 *
 * It caches nothing. Offline is out of scope for this app — see AGENTS.md —
 * and a worker that quietly serves yesterday's bundle is a class of bug that
 * costs more than it ever saves here. Push, and the tap on the notification
 * that follows it, is the whole of the job.
 *
 * It is bundled separately from the app and served at `/sw.js`, because a
 * worker's scope is the directory it is served from and this one has to see
 * the whole origin. The one thing it shares with the app is copy.json: the
 * words in a notification are the same words the in-tab one uses, and copy has
 * one home. It is imported by name rather than whole so that the bundler drops
 * the rest of the app's copy — the worker needs four strings out of it.
 *
 * Imported relatively rather than through the `@` alias, as the manifest is:
 * this module is bundled outside the app's own module graph, where that alias
 * does not resolve.
 */
import { notifications } from "./copy.json";

// `self` is typed as a plain worker scope by the lib; this is the same object,
// seen as what it actually is.
const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * One tag for every bell, so the platform replaces rather than stacks.
 *
 * It is deliberately the same string the in-tab notification uses. Whichever
 * of the two fires — and in one narrow case, a tab that is open but hidden,
 * both do — there is exactly one notification on screen.
 */
const TAG = "pomodorus";

/** Where a tap on the notification lands. The timer, and never a confirmation. */
const HOME = "/app";

/** What the server sends. No words: those are here, from copy.json. */
type Bell = {
  /** Which ring this was. Carried for tracing; nothing below reads it. */
  sessionId: string;
  kind: string;
};

// A new worker takes over immediately rather than waiting for every tab to
// close. There is no cache for the old one to be serving, so there is nothing
// a graceful handover would protect.
sw.addEventListener("install", () => {
  void sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener("push", (event) => {
  event.waitUntil(announce(read(event.data)));
});

/**
 * Reads the payload, tolerating anything.
 *
 * A push that cannot be parsed still has to end in a notification — a browser
 * that is woken and shown nothing eventually shows its own "this site was
 * updated in the background", and repeats it. So an unreadable payload becomes
 * a pomodoro's bell, which is what the overwhelming majority of them are.
 */
function read(data: PushMessageData | null): Bell | null {
  if (!data) return null;
  try {
    return data.json() as Bell;
  } catch {
    return null;
  }
}

async function announce(bell: Bell | null) {
  // A tab that is on screen is already ringing — the alarm sounds, the title
  // counts up, and the tab posts its own notification. A second one from here
  // would be the same bell twice.
  //
  // Skipping is only allowed because something visible is showing the ring;
  // that is exactly the case the platforms carve out of "a push must be
  // user-visible", and it is why the check is for a *visible* client rather
  // than for any client at all.
  if (await isOnScreen()) return;

  const work = bell === null || bell.kind === "work";
  await sw.registration.showNotification(
    work ? notifications.workDoneTitle : notifications.breakDoneTitle,
    {
      body: work ? notifications.workDoneBody : notifications.breakDoneBody,
      tag: TAG,
      // The notification-shaped version of a bell that will not be ignored: it
      // stays until it is dismissed rather than fading after a few seconds.
      requireInteraction: true,
      icon: "/icon-192.png",
      lang: "fa",
      dir: "rtl",
    },
  );
}

async function isOnScreen(): Promise<boolean> {
  const windows = await sw.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return windows.some((client) => client.visibilityState === "visible");
}

// Tapping brings the app forward. It does not confirm: ending a ring is a
// deliberate tap inside the app, and a notification dismissed by a sleeve in a
// pocket is not that.
sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(open());
});

async function open() {
  const windows = await sw.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const existing = windows[0];
  if (existing) {
    await existing.focus();
    return;
  }
  await sw.clients.openWindow(HOME);
}

/**
 * Web Push: the bell reaching you with the app fully closed.
 *
 * Everything here is best-effort and silent. A browser that does not support
 * it, a permission that was refused, a deployment with no keypair, a push
 * service that cannot be reached — all of them end the same way, with the app
 * working exactly as it did before and one fewer way of being told. Nothing in
 * this file may throw at a caller, and nothing in it may put a sentence on
 * screen: the ring is not something push is responsible for, it is something
 * push is one of two carriers of.
 *
 * The other carrier is the tab itself, in components/alarm.tsx. The service
 * worker stands down whenever a tab is on screen, so the two never double up.
 */

import { get, post } from "@/lib/api";

/** Where the worker is served from. The root, so its scope is the whole app. */
const WORKER = "/sw.js";

/**
 * Whether the service worker on this device will announce the bell itself.
 *
 * Read by the in-tab alarm, synchronously, at the moment it rings: the two
 * carriers have to divide the job between them, and the rule they share is the
 * tab's visibility. The worker stands down while a tab is on screen; the tab
 * stands down while it is hidden *and* this is true. So there is exactly one
 * notification in every case, and none of the cases is "neither" — a device
 * with no subscription keeps posting its own, hidden or not.
 *
 * A boolean rather than a promise because a ring cannot wait: it is settled
 * long before, either at boot or by the start that subscribed.
 */
let subscribed = false;

export function pushHandlesTheBell(): boolean {
  return subscribed;
}

/**
 * Whether this browser can be told at all.
 *
 * On iOS this is only true once the app has been added to the home screen —
 * which is the whole reason the app is installable, and why the answer is a
 * question about the browser rather than a setting.
 */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Registers the service worker, once, at boot.
 *
 * Separate from subscribing because it is not a decision: the worker is how a
 * push is received at all, and registering it asks the user nothing. What asks
 * is `enableNotifications`, at the moment somebody starts a session.
 */
export async function registerWorker(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.register(WORKER);
    // A device that subscribed on an earlier visit still has its subscription,
    // and the worker will still be pushed on it. Reading that back at boot is
    // what lets the in-tab alarm know, at the bell, which of the two of them
    // is announcing it.
    subscribed = (await registration.pushManager.getSubscription()) !== null;
  } catch {
    // A worker that will not register costs notifications and nothing else.
  }
}

/**
 * Asks for permission to notify, and — where the browser can — subscribes
 * this device so the bell arrives with no tab open.
 *
 * Called from a user's own gesture — starting a session — because that is both
 * when a browser will show the prompt and when the reason for it is obvious:
 * the thing being asked about is twenty-five minutes away and was just set
 * running. Asking on load, before there is any bell to miss, is how a person
 * learns to press "block".
 *
 * The permission request comes first and is not preceded by an `await`. A
 * prompt is only allowed while the gesture that led to it is still being
 * handled, and a round trip to the server before it is exactly the thing that
 * quietly disqualifies it.
 */
export async function enableNotifications(): Promise<void> {
  if (typeof Notification === "undefined") return;

  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (Notification.permission !== "granted") return;

  // The permission alone is what the tab's own notification needs, and it has
  // just been granted. Everything past here is the closed-tab case, which not
  // every browser can do — a desktop Safari that cannot be pushed still rings
  // perfectly well with a tab open.
  if (!pushSupported()) return;

  try {
    await subscribe();
  } catch {
    // Best effort, always. The session is running either way.
  }
}

/**
 * Registers this device with its push service and hands the address to the
 * server.
 *
 * A browser that rotates an endpoint — rare, and entirely its own decision —
 * is not handled here, and deliberately: the old row is deleted at the next
 * bell, when the push service reports it gone, and this runs again at the next
 * session start, which is the only moment a bell could be missed for. Watching
 * for it would mean a `pushsubscriptionchange` handler in the worker, which is
 * a code path no test in this repo can reach and that would buy one earlier
 * repair of a row that repairs itself.
 */
async function subscribe(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;

  // An existing subscription is reused rather than replaced: it is this
  // device's name to its push service, and it does not go stale. Re-posting it
  // is free — the server keys on the endpoint — and it is what repairs the row
  // for somebody who subscribed on a device, signed out, and came back.
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    const { publicKey } = await get<{ publicKey: string }>("/api/push/key");
    // A deployment with no keypair cannot send anything, and subscribing
    // against no key is not possible anyway.
    if (!publicKey) return;
    subscription = await registration.pushManager.subscribe({
      // Every push this app sends ends in a notification, which is what the
      // browsers require in exchange for waking a closed app at all.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    });
  }

  const keys = subscription.toJSON().keys;
  if (!keys?.p256dh || !keys.auth) return;

  await post("/api/push/subscribe", {
    endpoint: subscription.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  });

  // Only once the server has the address. Until then the worker would not be
  // pushed, and a tab that had already stood down would leave the bell silent.
  subscribed = true;
}

/**
 * The VAPID public key, from the base64url the server sends to the bytes
 * `applicationServerKey` wants. There is no browser API for this, which is why
 * every web push implementation carries the same eight lines.
 */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url
    .padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), "=")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

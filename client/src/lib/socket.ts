/**
 * The socket, and the only place `WebSocket` is constructed.
 *
 * It receives and never sends. Every mutation is an ordinary POST with a
 * client-minted id, so there is nothing to correlate, nothing to time out and
 * no error to report up this wire — what arrives is a fact, already true.
 *
 * There is exactly one connection per page however many things are listening.
 * The server pushes two kinds of fact down it — your own timer, and the feed
 * everybody shares — and a second connection would mean a second upgrade, a
 * second keepalive and two answers that could disagree. So the socket is a
 * module-level singleton held open by reference count: it opens when the first
 * listener arrives and closes when the last one leaves.
 *
 * Losing it costs nothing but promptness. Countdowns are computed from the
 * instants each fact carries, against the skew-corrected clock, so a tunnel, a
 * sleeping laptop or a proxy that hung up are all invisible: the digits keep
 * falling, and the first frames after reconnecting are the whole current
 * answer.
 */

import { useEffect, useRef } from "react";

/** One pushed fact, named. */
export type Frame = { type: string; timer?: unknown; feed?: unknown };

/** A frame carrying whole timer state, narrowed so its payload is known present. */
export type TimerFrame = Frame & { type: "timer"; timer: unknown };

/** A frame carrying the whole feed. */
export type FeedFrame = Frame & { type: "feed"; feed: unknown };

/**
 * Whether a frame is the timer's.
 *
 * The shape checks live here, with the rest of what this app knows about the
 * wire, rather than at the places a caller happens to read them.
 */
export function isTimerFrame(frame: Frame): frame is TimerFrame {
  return frame.type === "timer" && frame.timer !== undefined && frame.timer !== null;
}

export function isFeedFrame(frame: Frame): frame is FeedFrame {
  return frame.type === "feed" && frame.feed !== undefined && frame.feed !== null;
}

/** The first wait before reconnecting, doubling up to {@link MAX_BACKOFF}. */
const FIRST_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;

type Listener = (frame: Frame) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
/** How many listeners want the connection. It lives while this is above zero. */
let wanted = 0;

function open() {
  const mine = new WebSocket(socketURL());
  socket = mine;

  mine.onopen = () => {
    // Reaching the server resets the backoff, so an hour of tunnel followed by
    // a reconnection does not leave the next drop waiting half a minute.
    attempt = 0;
  };

  mine.onmessage = (event: MessageEvent) => {
    let frame: unknown;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      // A frame this build cannot read is a frame from another build. It is
      // dropped rather than shown, and the next one may well be fine.
      return;
    }
    if (!frame || typeof frame !== "object" || typeof (frame as Frame).type !== "string") {
      return;
    }
    // Copied before iterating, because a listener that unsubscribes while
    // being notified would otherwise mutate the set mid-loop.
    for (const listener of [...listeners]) listener(frame as Frame);
  };

  // An error is always followed by a close, so there is exactly one place that
  // decides to try again.
  mine.onerror = () => {};
  mine.onclose = () => {
    // Nobody is left to hear it, and this close is the one we asked for.
    if (wanted === 0) return;
    // Nor is this the connection in play any more. A close is delivered a turn
    // after `close()` returns, and in that turn a listener can have arrived and
    // opened a fresh socket — which is every mount under React's StrictMode,
    // and every quick route change. Without this the socket we just discarded
    // would decide it had dropped, reconnect on its own, and leave two live
    // connections feeding one set of listeners.
    if (socket !== mine) return;
    // Every close is retried, including a refused upgrade, because the browser
    // does not hand the status of a failed upgrade to script — there is no way
    // from here to tell a 401 from a tunnel. The cap is what makes that
    // harmless, and the socket is open to visitors anyway.
    //
    // Backing off, and jittered: an outage ends for everybody at once, and a
    // fixed delay would have every open tab arrive in the same millisecond.
    const wait = Math.min(MAX_BACKOFF, FIRST_BACKOFF * 2 ** attempt++);
    retry = setTimeout(open, wait * (0.5 + Math.random() / 2));
  };
}

/** Take a share of the connection, and hand it back. */
function acquire(): () => void {
  wanted++;
  if (wanted === 1) open();
  return () => {
    wanted--;
    if (wanted > 0) return;
    clearTimeout(retry);
    retry = undefined;
    attempt = 0;
    const closing = socket;
    socket = undefined;
    closing?.close();
  };
}

/**
 * Listen to the socket for as long as `enabled`, holding it open meanwhile.
 *
 * `onFrame` is read through a ref, so a handler that is a new function on every
 * render — which it will be — does not tear the connection down and build it
 * again.
 */
export function useSocket(enabled: boolean, onFrame: Listener) {
  const handler = useRef(onFrame);
  useEffect(() => {
    handler.current = onFrame;
  });

  useEffect(() => {
    // jsdom in a test that has not stubbed it, and any environment without
    // one: no socket is a supported state, because everything it carries can
    // also be asked for over HTTP.
    if (!enabled || typeof WebSocket === "undefined") return;

    const listener: Listener = (frame) => handler.current(frame);
    listeners.add(listener);
    const release = acquire();

    return () => {
      listeners.delete(listener);
      release();
    };
  }, [enabled]);
}

/**
 * The socket lives on the same origin as the API, because the credential is an
 * httpOnly cookie the browser attaches to the upgrade by itself — there is no
 * token in this URL and there is not meant to be one. A visitor sends no
 * cookie and is welcome anyway; they receive the feed and nothing else.
 */
function socketURL(): string {
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

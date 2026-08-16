/**
 * The socket, and the only place `WebSocket` is constructed.
 *
 * It receives and never sends. Every mutation is an ordinary POST with a
 * client-minted id, so there is nothing to correlate, nothing to time out and
 * no error to report up this wire — what arrives is a fact, already true.
 *
 * Losing it costs nothing but promptness. The countdown is computed from the
 * session's own instants against the skew-corrected clock, so a tunnel, a
 * sleeping laptop or a proxy that hung up are all invisible: the digits keep
 * falling, and the first frame after reconnecting is the whole current answer.
 */

import { useEffect, useRef } from "react";

/** One pushed fact, named. `timer` is the only kind so far. */
export type Frame = { type: string; timer?: unknown };

/** A frame carrying whole timer state, narrowed so its payload is known present. */
export type TimerFrame = Frame & { type: "timer"; timer: unknown };

/**
 * Whether a frame is the timer's.
 *
 * The shape check lives here, with the rest of what this app knows about the
 * wire, rather than at the one place a caller happens to read it — a second
 * kind of frame arriving later should not mean a second place that guesses.
 */
export function isTimerFrame(frame: Frame): frame is TimerFrame {
  return frame.type === "timer" && frame.timer !== undefined && frame.timer !== null;
}

/** The first wait before reconnecting, doubling up to {@link MAX_BACKOFF}. */
const FIRST_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;

/**
 * Hold a socket open for as long as `enabled`, applying every frame.
 *
 * `onFrame` is read through a ref, so a handler that is a new function on
 * every render — which it will be — does not tear the connection down and
 * build it again.
 */
export function useSocket(enabled: boolean, onFrame: (frame: Frame) => void) {
  const handler = useRef(onFrame);
  useEffect(() => {
    handler.current = onFrame;
  });

  useEffect(() => {
    // jsdom in a test that has not stubbed it, and any environment without
    // one: no socket is a supported state, because everything it carries can
    // also be asked for.
    if (!enabled || typeof WebSocket === "undefined") return;

    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // Set by the cleanup, so a close caused by unmounting is not mistaken for
    // a connection that dropped and should be chased.
    let done = false;

    const open = () => {
      socket = new WebSocket(socketURL());

      socket.onopen = () => {
        // Reaching the server resets the backoff, so an hour of tunnel
        // followed by a reconnection does not leave the next drop waiting
        // half a minute.
        attempt = 0;
      };

      socket.onmessage = (event: MessageEvent) => {
        let frame: unknown;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          // A frame this build cannot read is a frame from another build. It
          // is dropped rather than shown, and the next one may well be fine.
          return;
        }
        if (frame && typeof frame === "object" && typeof (frame as Frame).type === "string") {
          handler.current(frame as Frame);
        }
      };

      // An error is always followed by a close, so there is exactly one place
      // that decides to try again.
      socket.onerror = () => {};
      socket.onclose = () => {
        if (done) return;
        // Every close is retried, including a refused upgrade, because the
        // browser does not hand the status of a failed upgrade to script —
        // there is no way from here to tell a 401 from a tunnel. The cap is
        // what makes that harmless: a session that really has expired is
        // noticed by the next ordinary request, which flips this off.
        //
        // Backing off, and jittered: an outage ends for everybody at once, and
        // a fixed delay would have every open tab arrive in the same
        // millisecond.
        const wait = Math.min(MAX_BACKOFF, FIRST_BACKOFF * 2 ** attempt++);
        retry = setTimeout(open, wait * (0.5 + Math.random() / 2));
      };
    };

    open();

    return () => {
      done = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [enabled]);
}

/**
 * The socket lives on the same origin as the API, because the credential is an
 * httpOnly cookie the browser attaches to the upgrade by itself — there is no
 * token in this URL and there is not meant to be one.
 */
function socketURL(): string {
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

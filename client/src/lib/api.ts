/**
 * The transport, and the only place `fetch` is called.
 *
 * Every mutation is an ordinary POST with a real status code; the WebSocket
 * only ever pushes facts. So errors have HTTP semantics here and nowhere else,
 * and a route never has to reason about a status.
 *
 * The server answers with a machine-readable code, never a sentence — every
 * word of Persian in the product lives in copy.json, and a message from the
 * server would be a second place for it to live.
 */

import { copy } from "@/lib/copy";
import { noteServerTime } from "@/lib/server-clock";

/** Every response carries the server's clock, so the client can correct skew. */
export type ServerTimed = { serverNow: number };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

/** The code a request that never arrived reports as. */
export const OFFLINE = "offline";

export async function get<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  // Read before the request leaves, so the round trip can be measured and the
  // server's clock corrected for it.
  const sentAt = performance.now();

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A request that never left the device says nothing about the server.
    throw new ApiError(OFFLINE, 0);
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  // Every response carries the server's clock, including the failures — a
  // rate-limited request is still a fresh reading of what time it is.
  if (payload && typeof payload === "object" && "serverNow" in payload) {
    const serverNow = Number(payload.serverNow);
    if (Number.isFinite(serverNow)) noteServerTime(serverNow, sentAt);
  }

  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : "server_error";
    throw new ApiError(code, response.status);
  }
  return payload as T;
}

/**
 * The sentence to put in front of the user for a failure.
 *
 * An unrecognised code falls back to the generic apology rather than being
 * shown raw: a version skew reading as a specific, wrong explanation is what
 * once sent everybody hunting for a password they had typed correctly.
 */
export function messageFor(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "server_error";
  switch (code) {
    case "invalid_email":
      return copy.login.invalidEmail;
    case "rate_limited":
      return copy.login.rateLimited;
    case "bad_code":
      return copy.login.badCode;
    // Three distinct reasons, because "taken", "not allowed" and "wrong
    // shape" are different problems and guessing which is which is exactly
    // what leaves somebody stuck.
    case "handle_invalid":
      return copy.errors.usernameInvalid;
    case "handle_taken":
      return copy.errors.usernameTaken;
    case "handle_profane":
      return copy.errors.usernameProfane;
    case "category_name_length":
      return copy.errors.categoryNameLength;
    case "category_name_profane":
      return copy.errors.categoryNameProfane;
    case "category_busy":
      return copy.errors.categoryBusy;
    case "category_not_found":
      return copy.errors.categoryNotFound;
    // The same sentence for the same problem, from the two places a number can
    // arrive out of its band: the start screen's stepper and the dialog's.
    case "bad_duration":
    case "bad_interval":
      return copy.errors.badDuration;
    case "not_cancellable":
      return copy.errors.notCancellable;
    case "nothing_ringing":
      return copy.errors.nothingRinging;
    case "session_not_found":
      return copy.errors.sessionNotFound;
    case OFFLINE:
      return copy.offline.needInternet;
    default:
      return copy.login.serverError;
  }
}

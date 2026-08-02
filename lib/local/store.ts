// The one adapter behind the local-first timer's rules: localStorage, the
// clock, and client-minted ids. Every rule itself lives in ./device — this file
// only decides where state comes from, where it goes, and who hears about it.
//
// One state blob per username so switching accounts on a device never mixes
// queues; the blob survives sign-out, which is what lets unsynced focus time
// outlive an expired auth token. Tabs stay consistent via the `storage` event.

import { apply, type Applied, type Command } from "./device";
import { type CategoryOp, type LocalState, type PendingSession, EMPTY_STATE } from "./types";

const IDENTITY_KEY = "pomodorus:user";
const stateKey = (username: string) => `pomodorus:v1:${username}`;

let cachedIdentity: string | null | undefined; // undefined = not loaded yet
let cachedState: LocalState = EMPTY_STATE;
let cachedStateKey: string | null = null;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function loadIdentity(): string | null {
  if (typeof window === "undefined") return null;
  if (cachedIdentity === undefined) {
    cachedIdentity = window.localStorage.getItem(IDENTITY_KEY);
  }
  return cachedIdentity;
}

function loadState(): LocalState {
  if (typeof window === "undefined") return EMPTY_STATE;
  const username = loadIdentity();
  const key = username === null ? null : stateKey(username);
  if (key === cachedStateKey) return cachedState;
  cachedStateKey = key;
  cachedState = EMPTY_STATE;
  if (key !== null) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) cachedState = { ...EMPTY_STATE, ...(JSON.parse(raw) as LocalState) };
    } catch {
      // Corrupt blob: start fresh rather than brick the app.
    }
  }
  return cachedState;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(e: StorageEvent) {
  if (e.key === IDENTITY_KEY) cachedIdentity = undefined;
  if (e.key === IDENTITY_KEY || e.key === cachedStateKey) {
    cachedStateKey = null; // force reload from storage
    emit();
  }
}

export function getIdentity(): string | null {
  return loadIdentity();
}

export function getState(): LocalState {
  return loadState();
}

export function setIdentity(username: string) {
  if (loadIdentity() === username) return;
  window.localStorage.setItem(IDENTITY_KEY, username);
  cachedIdentity = username;
  cachedStateKey = null;
  emit();
}

/**
 * Run a command against the stored state, persisting and announcing the result
 * only when it changed something. The clock and id minting enter the app here
 * and nowhere else.
 */
function dispatch(command: Command): Applied {
  const state = loadState();
  const result = apply(state, command, {
    now: Date.now(),
    newId: () => crypto.randomUUID(),
  });
  if (result.state !== state) {
    cachedState = result.state;
    if (cachedStateKey !== null) {
      window.localStorage.setItem(cachedStateKey, JSON.stringify(result.state));
    }
    emit();
  }
  return result;
}

// ---- The writers the UI calls: each one is a command and nothing more. ----

/** Settle now; called on a short interval while the app is open. */
export function tick() {
  dispatch({ type: "settle" });
}

export function startWork(categoryClientId: string, minutes: number, fast: boolean) {
  dispatch({ type: "startWork", categoryClientId, minutes, fast });
}

/** Cancel the running work session. It counts for nothing. */
export function cancelWork() {
  dispatch({ type: "cancelWork" });
}

/** Skip the running break and become idle immediately. */
export function skipBreak() {
  dispatch({ type: "skipBreak" });
}

/**
 * The refusal a name can meet — too long, already busy, or on the wordlist —
 * carrying the sentence to put in front of the user. The picker is the one
 * place a rejection is worth showing: a name is typed, so it can be wrong.
 */
export type Refused = { rejected: string };

/** The new category's clientId, or why it was refused. */
export function createCategory(
  name: string,
  isPublic: boolean,
): { clientId: string } | Refused {
  const { created, rejected } = dispatch({ type: "createCategory", name, isPublic });
  // `apply` always names its reason when it declines to create; the empty
  // fallback only exists so the type does not lie, and shows nothing.
  return created !== undefined ? { clientId: created } : { rejected: rejected ?? "" };
}

/** Null when the edit went through. */
export function updateCategory(
  clientId: string,
  name: string,
  isPublic: boolean,
): Refused | null {
  const { rejected } = dispatch({ type: "updateCategory", clientId, name, isPublic });
  return rejected === undefined ? null : { rejected };
}

export function deleteCategory(clientId: string) {
  dispatch({ type: "deleteCategory", clientId });
}

/** Refresh the cached server mirror (from the live categories query). */
export function setServerCategories(rows: readonly unknown[]) {
  dispatch({ type: "setServerCategories", rows });
}

/** Clear exactly what a successful sync.push delivered; later edits survive. */
export function markSynced(sessions: PendingSession[], ops: CategoryOp[]) {
  dispatch({ type: "markSynced", sessions, ops });
}

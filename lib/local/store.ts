// The one adapter behind the local-first timer's rules: localStorage, the
// clock, and client-minted ids. Every rule itself lives in ./device — this file
// only decides where state comes from, where it goes, and who hears about it.
//
// One state blob per username so switching accounts on a device never mixes
// queues; the blob survives sign-out, which is what lets unsynced focus time
// outlive an expired auth token. Tabs stay consistent via the `storage` event
// *and* by re-reading before every write, since each write replaces the blob.
//
// The rule this file is built around: focus time that has been earned is never
// dropped on the floor. Storage that refuses a write is retried, a blob written
// before the username arrived is claimed rather than abandoned, and the pending
// queues are cleared only against what the server said it stored.

import { apply, claimOrphaned, type Applied, type Command } from "./device";
import { type LocalState, type RangeKey, EMPTY_STATE } from "./types";

const IDENTITY_KEY = "pomodorus:user";
const stateKey = (username: string) => `pomodorus:v1:${username}`;

// Where a device writes before it knows whose device it is. The username
// arrives from a server query, so on a first load — or any load where that
// query never lands, which offline is exactly what happens — there is a window
// with no key to write under. Focus time earned in that window is still focus
// time, so it goes here and is claimed by the first account to sign in.
const ANON_KEY = stateKey("");

let cachedIdentity: string | null | undefined; // undefined = not loaded yet
let cachedState: LocalState = EMPTY_STATE;
let cachedStateKey: string | null = null;
// The exact text `cachedState` was parsed from, so a re-read can tell "nobody
// changed anything" from "another tab did" without reparsing or re-rendering.
let cachedRaw: string | null = null;
// Set when storage refused the last write, so the next tick tries again.
let unpersisted = false;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function loadIdentity(): string | null {
  if (typeof window === "undefined") return null;
  // Read through the guarded helper: this runs during render, so a browser
  // that refuses storage outright must cost us the cached username, not the
  // whole app.
  if (cachedIdentity === undefined) cachedIdentity = readRaw(IDENTITY_KEY);
  return cachedIdentity;
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage we aren't allowed to read
  }
}

function parseBlob(raw: string | null): LocalState | null {
  if (!raw) return null;
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as LocalState) };
  } catch {
    // Corrupt blob: start fresh rather than brick the app.
    return null;
  }
}

/** The blob at `key`, or null when there isn't a readable one. */
function readBlob(key: string): LocalState | null {
  return parseBlob(readRaw(key));
}

/**
 * Persist `state` at `key`, reporting whether it landed.
 *
 * Storage can refuse a write — quota, a locked-down browser, private mode —
 * and it must not take the app down with it: the in-memory state stays
 * authoritative and the next write tries again. What it must never do is pass
 * silently, because a queue that only exists in this tab is a queue that dies
 * with it.
 */
function writeBlob(key: string, state: LocalState): boolean {
  try {
    const raw = JSON.stringify(state);
    window.localStorage.setItem(key, raw);
    if (key === cachedStateKey) cachedRaw = raw;
    return true;
  } catch {
    return false;
  }
}

function loadState(): LocalState {
  if (typeof window === "undefined") return EMPTY_STATE;
  const username = loadIdentity();
  const key = username === null ? ANON_KEY : stateKey(username);
  if (key === cachedStateKey) return cachedState;
  cachedStateKey = key;
  cachedRaw = readRaw(key);
  cachedState = parseBlob(cachedRaw) ?? EMPTY_STATE;
  return cachedState;
}

/**
 * `loadState`, but having first taken in whatever other tabs have written.
 *
 * Every write here is a read-modify-write of one whole blob, so the read has
 * to be of what is actually on disk: the `storage` event that announces
 * another tab's write arrives *after* the fact, and a command applied in the
 * gap would write a pre-merge state back over a completed pomodoro. Reparsing
 * only when the text changed is what keeps the snapshot referentially stable,
 * so this can run on every tick without re-rendering the app twice a second.
 */
function freshState(): LocalState {
  const cached = loadState();
  if (cachedStateKey === null) return cached;
  const raw = readRaw(cachedStateKey);
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  cachedState = parseBlob(raw) ?? EMPTY_STATE;
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
  if (e.key === IDENTITY_KEY) {
    cachedIdentity = undefined;
    cachedStateKey = null; // a different account: reload under its own key
  } else if (e.key !== cachedStateKey) {
    return;
  }
  // Take the write in now rather than leaving a marker for the next read, so
  // `cachedStateKey` stays pointed at a real key and the *next* event from
  // another tab is still recognized as ours.
  freshState();
  emit();
}

export function getIdentity(): string | null {
  return loadIdentity();
}

export function getState(): LocalState {
  return loadState();
}

/**
 * Learn whose device this is, claiming anything earned before we knew.
 *
 * Only the anonymous blob is ever claimed, and only by the first account to
 * sign in on the device — one account's leftovers must never follow another
 * account onto its queue, which is the whole reason state is keyed by username.
 */
export function setIdentity(username: string) {
  const previous = loadIdentity();
  if (previous === username) return;
  const target = stateKey(username);
  if (previous === null) {
    const orphaned = readBlob(ANON_KEY);
    if (orphaned !== null) {
      const claimed = claimOrphaned(readBlob(target), orphaned);
      // Only forget the anonymous blob once its contents are rehoused; if
      // either step fails the work stays where it is, unclaimed but intact,
      // which is the failure this whole path exists to prefer.
      if (writeBlob(target, claimed)) {
        try {
          window.localStorage.removeItem(ANON_KEY);
        } catch {
          // Nothing reads it again once an identity is known; harmless.
        }
      }
    }
  }
  try {
    window.localStorage.setItem(IDENTITY_KEY, username);
  } catch {
    // Unwritable storage: this tab still works, it just re-learns the
    // username from the server on the next load.
  }
  cachedIdentity = username;
  cachedStateKey = null; // force a reload under the new key
  emit();
}

/**
 * Run a command against the stored state, persisting and announcing the result
 * only when it changed something. The clock and id minting enter the app here
 * and nowhere else.
 *
 * The read is of storage, not of this tab's cache, because the write that
 * follows replaces the whole blob — see `freshState`.
 */
function dispatch(command: Command): Applied {
  const state = freshState();
  const result = apply(state, command, {
    now: Date.now(),
    newId: () => crypto.randomUUID(),
  });
  const changed = result.state !== state;
  if (changed) cachedState = result.state;
  // A refused write leaves the tab holding the only copy, so keep trying: the
  // 2Hz tick turns "storage was full when your pomodoro ended" into a
  // half-second outage instead of a lost session.
  if ((changed || unpersisted) && cachedStateKey !== null) {
    unpersisted = !writeBlob(cachedStateKey, cachedState);
  }
  if (changed) emit();
  return result;
}

// ---- The writers the UI calls: each one is a command and nothing more. ----

/** Settle now; called on a short interval while the app is open. */
export function tick() {
  dispatch({ type: "settle" });
}

/** Start a work session on the selected task, at the configured length. */
export function startWork(fast: boolean) {
  dispatch({ type: "startWork", fast });
}

/** Pause the running work session. */
export function pauseWork() {
  dispatch({ type: "pauseWork" });
}

/** Resume the paused work session. */
export function resumeWork() {
  dispatch({ type: "resumeWork" });
}

/** Remember the picked task, so a reload doesn't lose it. */
export function selectCategory(clientId: string | null) {
  dispatch({ type: "selectCategory", clientId });
}

/** Move one interval to a new value on its range. */
export function setSetting(key: RangeKey, value: number) {
  dispatch({ type: "setSetting", key, value });
}

/**
 * Acknowledge the ringing session: silences the alarm, and starts whatever
 * break survived the ring.
 */
export function confirm() {
  dispatch({ type: "confirm" });
}

/** Acknowledge a ringing break and go straight back into work on the same task. */
export function continueWork(fast: boolean) {
  dispatch({ type: "continueWork", fast });
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

/** Clear exactly what sync.push acknowledged; the rest waits for another try. */
export function markSynced(sessionIds: readonly string[], opKeys: readonly string[]) {
  dispatch({ type: "markSynced", sessionIds, opKeys });
}

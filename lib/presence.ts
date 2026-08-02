// Presence: the best-effort advertisement that a user is in a session
// (docs/adr/0001-local-first-timer.md). It is advisory, not truth, which is
// exactly why the rules about it belong in one place — what a device claims,
// how long the claim stands, and what a viewer may see of it were previously
// re-decided by the sync engine, the feed query and the feed itself.

import { isProfane } from "./profanity";
import type { SessionKind } from "./local/types";

const MINUTE_MS = 60_000;
/** Nothing legitimately runs longer than a long break. */
const MAX_SESSION_MS = 60 * MINUTE_MS;
const CLOCK_SKEW_MS = 5 * MINUTE_MS;
const LABEL_MAX = 40;

/** How long an expired row is left alone before a sweep may delete it. */
export const SWEEP_GRACE_MS = MINUTE_MS;

export type PresenceKind = SessionKind;

/**
 * What a device advertises and the server stores. Absolute timestamps, so late
 * delivery is harmless and the row can expire without anyone being online.
 */
export type Presence = {
  kind: PresenceKind;
  /** The category name, for public work sessions only. Null = private task or break. */
  label: string | null;
  startedAt: number;
  durationMs: number;
};

/**
 * Is the advertisement still inside the session it describes? The one answer to
 * "is this live", used by the feed query, the feed itself, and — offset by
 * `SWEEP_GRACE_MS` — the cleanup of rows whose device never came back.
 */
export function isLive(
  row: { startedAt: number; durationMs: number },
  now: number,
): boolean {
  return row.startedAt + row.durationMs > now;
}

/**
 * What to advertise for a locally running session. A private category's name
 * never leaves the device, and a break has no name to give.
 */
export function advertisement(
  running: { kind: PresenceKind; startedAt: number; durationMs: number },
  category: { name: string; isPublic: boolean } | null,
): Presence {
  const isWork = running.kind === "work";
  return {
    kind: running.kind,
    label: isWork && category?.isPublic === true ? category.name : null,
    startedAt: running.startedAt,
    durationMs: running.durationMs,
  };
}

/**
 * Vet a received advertisement, returning the row to store or null to ignore
 * it. Rejects nonsense, anything claiming to run longer than a session can, and
 * anything claiming to have started in the future. Normalizing the label here
 * rather than at the call site means a caller cannot forget to.
 *
 * A profane label is refused outright rather than blanked: the feed drops the
 * whole item (`isShowable`), so storing the row would only put the word in the
 * database for nobody to read.
 */
export function accept(row: Presence, now: number): Presence | null {
  if (!Number.isFinite(row.startedAt) || !Number.isFinite(row.durationMs)) return null;
  if (row.durationMs <= 0 || row.durationMs > MAX_SESSION_MS) return null;
  if (row.startedAt > now + CLOCK_SKEW_MS) return null;
  if (isProfane(row.label)) return null;
  return {
    kind: row.kind,
    label: row.label === null ? null : row.label.trim().slice(0, LABEL_MAX) || null,
    startedAt: row.startedAt,
    durationMs: row.durationMs,
  };
}

/** The label a viewer may see: a break shows none, and a private task never had one. */
export function visibleLabel(row: Presence): string | null {
  return row.kind === "work" ? row.label : null;
}

/**
 * May the feed show this row at all? Profanity in either half of the line — the
 * category name the device advertised or the username it goes out under — takes
 * the whole item out. Masking the label would leave the item making the same
 * point under a username, and there is nothing to gain by keeping the row.
 *
 * `accept` already turns profane labels away at the door, so in practice this
 * catches usernames (which presence does not carry, and which are immutable
 * once chosen) and rows written before the wordlist existed.
 */
export function isShowable(row: Presence, username: string): boolean {
  return !isProfane(username) && !isProfane(visibleLabel(row));
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  SWEEP_GRACE_MS,
  accept,
  advertisement,
  isLive,
  isShowable,
  visibleLabel,
  type Presence,
} from "../lib/presence";

const MINUTE = 60_000;
const NOW = Date.parse("2026-07-30T09:00:00Z");

const row = (over: Partial<Presence> = {}): Presence => ({
  kind: "work",
  label: "کد نویسی",
  startedAt: NOW - 5 * MINUTE,
  durationMs: 25 * MINUTE,
  ...over,
});

test("a row is live until its session's end time", () => {
  const p = row({ startedAt: NOW, durationMs: 25 * MINUTE });
  assert.equal(isLive(p, NOW), true);
  assert.equal(isLive(p, NOW + 25 * MINUTE - 1), true);
  // The end time itself is over, not still running.
  assert.equal(isLive(p, NOW + 25 * MINUTE), false);
});

test("a sweep spares a row until the grace period has passed", () => {
  // Expired exactly now: gone from the feed, but the sweep still spares it,
  // since the device that owns it may yet come back and clear it itself.
  const ended = row({ startedAt: NOW - 25 * MINUTE, durationMs: 25 * MINUTE });
  assert.equal(isLive(ended, NOW), false);
  assert.equal(isLive(ended, NOW - SWEEP_GRACE_MS), true);

  // Expired longer ago than the grace period: the sweep may take it.
  const stale = row({ startedAt: NOW - 40 * MINUTE, durationMs: 25 * MINUTE });
  assert.equal(isLive(stale, NOW - SWEEP_GRACE_MS), false);
});

test("a public work session advertises its category name", () => {
  const ad = advertisement(
    { kind: "work", startedAt: NOW, durationMs: 25 * MINUTE },
    { name: "کد نویسی", isPublic: true },
  );
  assert.equal(ad.label, "کد نویسی");
});

test("a private category's name never leaves the device", () => {
  const ad = advertisement(
    { kind: "work", startedAt: NOW, durationMs: 25 * MINUTE },
    { name: "درمان", isPublic: false },
  );
  assert.equal(ad.label, null);
  assert.equal(ad.kind, "work");
});

test("a break advertises no label, public category or not", () => {
  for (const kind of ["shortBreak", "longBreak"] as const) {
    const ad = advertisement(
      { kind, startedAt: NOW, durationMs: 5 * MINUTE },
      { name: "کد نویسی", isPublic: true },
    );
    assert.equal(ad.label, null);
  }
});

test("a session with no category advertises no label", () => {
  const ad = advertisement({ kind: "work", startedAt: NOW, durationMs: 25 * MINUTE }, null);
  assert.equal(ad.label, null);
});

test("a plausible advertisement is accepted", () => {
  assert.notEqual(accept(row(), NOW), null);
});

test("labels are trimmed and capped at 40 characters", () => {
  const vetted = accept(row({ label: `  ${"ا".repeat(60)}  ` }), NOW);
  assert.equal(vetted?.label?.length, 40);
  // A label that is only whitespace is no label at all.
  assert.equal(accept(row({ label: "   " }), NOW)?.label, null);
});

test("nonsense durations are rejected", () => {
  assert.equal(accept(row({ durationMs: 0 }), NOW), null);
  assert.equal(accept(row({ durationMs: -1 }), NOW), null);
  assert.equal(accept(row({ durationMs: Number.NaN }), NOW), null);
  assert.equal(accept(row({ durationMs: Number.POSITIVE_INFINITY }), NOW), null);
  // Longer than any session, so nothing legitimate is being described.
  assert.equal(accept(row({ durationMs: 61 * MINUTE }), NOW), null);
  // A long break is the longest honest claim.
  assert.notEqual(accept(row({ durationMs: 20 * MINUTE }), NOW), null);
});

test("a start time beyond clock skew is rejected", () => {
  assert.equal(accept(row({ startedAt: NOW + 6 * MINUTE }), NOW), null);
  // Within skew: a device whose clock runs a little fast still gets in.
  assert.notEqual(accept(row({ startedAt: NOW + 4 * MINUTE }), NOW), null);
  assert.equal(accept(row({ startedAt: Number.NaN }), NOW), null);
});

test("a profane label is not stored at all", () => {
  assert.equal(accept(row({ label: "سکس" }), NOW), null);
  assert.equal(accept(row({ label: "یه کم کیر" }), NOW), null);
  // Read before the 40-character cap, so a long label cannot smuggle a word
  // past by putting it where the trim would have cut it off anyway.
  assert.equal(accept(row({ label: `${"ا".repeat(45)} سکس` }), NOW), null);
  assert.notEqual(accept(row({ label: "درس خوندن" }), NOW), null);
});

test("a viewer sees a work label and never a break's", () => {
  assert.equal(visibleLabel(row({ kind: "work", label: "کد نویسی" })), "کد نویسی");
  assert.equal(visibleLabel(row({ kind: "work", label: null })), null);
  assert.equal(visibleLabel(row({ kind: "shortBreak", label: "کد نویسی" })), null);
  assert.equal(visibleLabel(row({ kind: "longBreak", label: "کد نویسی" })), null);
});

test("the feed drops an item profane on either half of its line", () => {
  assert.equal(isShowable(row(), "sara_71"), true);
  // A label that predates the wordlist, or a username that can never be edited.
  assert.equal(isShowable(row({ label: "سکس" }), "sara_71"), false);
  assert.equal(isShowable(row(), "koskesh"), false);
  // A break carries no label, so only the username can take it out.
  assert.equal(isShowable(row({ kind: "shortBreak", label: "سکس" }), "sara_71"), true);
});

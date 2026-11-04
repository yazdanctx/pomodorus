# 0006 — A blackhole is an open-ended session with a credit cap

**Status:** accepted (2026-11-04). Extends ADR 0001, 0002 and 0004.

## Context

A pomodoro credits a nominal length chosen up front. Long stretches of
focused, multi-task work do not fit that shape: they have no length until they
end, they drift between tasks, and forcing them into back-to-back pomodoros
either loses time between bells or credits rests that were not taken.

## Decision

A **blackhole** is a third session kind with no nominal length. It runs until
the person *stops* it (credited for actual elapsed time) or *discards* it (not
credited). It starts with at least one task and may gain or lose tasks while
live; with more than one it wears the label *multi task*.

It stays within the existing rules rather than bending them:

- **It is the one live session.** Pomodoros run inside it are child rows that
  reference it and pick one of its tasks. They keep the full cycle, bells,
  confirmations and breaks, and they advance the account's one cycle counter.
  They are *attribution*, not credit: their span belongs to the blackhole and
  is never counted twice. Starting a blackhole around a live pomodoro is
  refused.
- **Nothing advances on its own.** There is a **credit cap** of 16 hours. Past
  it the blackhole stays live until tapped but earns nothing further; one push
  is sent and the screen says so, with no bell sound. The cap is a ceiling on
  credit computed at read time, not a scheduler.
- **Credit splits at Tehran midnight** by elapsed time, unlike a pomodoro,
  which is credited whole to the day of its bell. A ten-hour night credited to
  one day would distort both days and every record built on them.
- **Attribution on the chart:** time covered by an inner pomodoro lands on that
  pomodoro's task; the rest lands on the blackhole's single task, or in the
  *multi task* bucket when it has several.
- **On the feed** it counts up instead of down. With several tasks the feed
  says *multi task* regardless of privacy, so a mixed public/private set
  cannot leak by omission.
- A stop ends any inner pomodoro with it; a pomodoro cut short this way is not
  a completed pomodoro and does not advance the cycle. Discard asks for
  confirmation after the first minute; stop never does.

## Considered options

- *A container that is not credited, only its inner pomodoros are.* Rejected:
  the point is that the work between bells is real.
- *Credit both the blackhole and its pomodoros.* Rejected: a day would be
  double-counted the moment the feature was used as intended.
- *Relax one-live-per-user to one-per-kind.* Rejected: the index is what makes
  the timer belong to the person, and the feed and badge assume one entry.
- *No cap.* Rejected: a phone that dies at 2am would credit three days.

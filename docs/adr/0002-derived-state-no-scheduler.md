# 0002 — Session state is derived, not scheduled

**Status:** accepted (2026-08-13).

## Context

A session's end is a moment in the future. With the server owning the timer
(ADR 0001), something has to account for the transition from running to
ringing. The obvious implementations are a Go timer per session, or a periodic
job that sweeps rows and flips them.

Both are subsystems that can be wrong: timers must be rebuilt on boot, they
drift, they fire twice or not at all, and a sweep adds seconds of lag to a
clock the user is watching to the second.

## Decision

Nothing is scheduled. A session is stored as facts — `started_at`,
`duration_ms`, `confirmed_at` — and its state is a pure function of those plus
`now`:

- `now < ends_at` → **running**
- `now >= ends_at` and not confirmed → **ringing**
- confirmed → **over**

The only row that ever mutates is the confirmation.

The client is handed the same facts and derives the same state, including the
bell. Nothing has to be pushed at the exact moment a session ends.

## Consequences

- The process can restart mid-session and lose nothing. There is no boot-time
  reconstruction step.
- No missed fires, no duplicate fires, no cron, no queue, no worker.
- The feed is one SQL query over `ends_at`, and "who is working right now" has
  no separate presence table to go stale — a thing v1 had to describe as
  "advisory, not truth".
- Every payload carries the server's `now`, and every timestamp on the wire is
  absolute epoch milliseconds. The client corrects for skew and uses its own
  clock only to measure elapsed time, never to decide what time it is. A brief
  disconnect is therefore invisible: the countdown keeps running, correctly.
- **Exception:** Web Push needs something to fire *at* the bell, so there is
  one in-memory timer per running session whose only job is to send it. It
  writes no state and is rebuilt from a single query on boot. Losing one costs
  a notification, never correctness. Nothing else may be scheduled.

# 0001 — The server owns the timer

**Status:** accepted (2026-08-13). Reverses the v1 decision recorded at
`git show v1-nextjs:docs/adr/0001-local-first-timer.md`.

## Context

v1 was local-first: the device that ran a session owned it, `startedAt` and
`duration` lived in localStorage, and the server was an append-only log the
device drained into when it happened to be online. That bought a timer that
worked with no network at all, and cost a sync layer — a pending queue,
acknowledged drains, last-write-wins on categories, and the standing admission
that two devices double-count focus time.

The rewrite was originally specified as offline-first too. That was reversed
during design: what was actually wanted was a timer that follows you between
devices, and offline was dropped in exchange.

## Decision

The server is the source of truth for a session. A session exists as a row;
the client renders it.

Offline is **out of scope**. There is no local queue, no replay, no
reconciliation, and no conflict resolution, because there are no conflicting
writers.

## Consequences

- Starting a session on a phone and opening a laptop shows the same timer with
  the same digits. This is the entire point.
- Focus time can no longer be double-counted, because there is only ever one
  live session per user (see ADR 0004).
- The app requires a network to *act*. It does not require one to *count* —
  see ADR 0002, which is what keeps a flaky connection from being a broken
  timer, and which matters more here than it would elsewhere because the users
  are on Iranian mobile networks.
- Reintroducing offline later is a client-side re-architecture, not a bolt-on.
  The one hedge taken is that every mutation is idempotent and carries a
  client-minted id — done for retry safety on a bad connection, but it is also
  the shape a replay log would need.

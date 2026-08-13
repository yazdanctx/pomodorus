# 0004 — One live session per user, and nothing advances on its own

**Status:** accepted (2026-08-13). The second half is carried over from v1
unchanged (`git show v1-nextjs:docs/adr/0004-confirmed-transitions.md`).

## One live session

v1 had no such rule: every device ran its own timer, and a two-device user
could legitimately double-count focus time. With the server owning the timer
(ADR 0001) that stops being a trade-off and starts being a bug.

A partial unique index enforces at most one unconfirmed session per user.
`start` is **idempotent**: asking to start while one is live returns the live
one rather than erroring. A second device therefore never shows a start
button — it opens into the running timer and can cancel or confirm it.

There is no conflict resolution, because there is nothing to resolve.

## Confirmed transitions

Kept exactly as v1 had it, because it was right:

- **Nothing advances on its own.** A session that reaches its end enters
  *ringing* and stops there. No break auto-starts, no chain runs. However long
  the app was closed, at most one transition is ever pending.
- **Ring time is not focus time.** Work is credited at its exact nominal end,
  at its full nominal duration. Confirming in two seconds or two hours records
  identically.
- **Ring time comes out of the break.** The break is anchored at the nominal
  end: confirm after ten seconds and a five-minute break is `5:00 − 0:10`; ring
  past the whole break and there is none left, so confirming drops straight to
  idle.
- **Only an explicit tap confirms.** Tab focus, app resume, notification
  clicks and mouse movement do not.
- Confirming work starts the surviving break in one tap. Confirming a break
  offers two: continue (straight back into the same task at the same length)
  and done.

Auto-advancing the chain would derive even more cleanly than this — the whole
sequence is computable from one `started_at`. It is rejected because it credits
you for "breaks" spent in a meeting and runs the app on without you.

## Dropped from v1

The rule that a ring's audibility is decided once when it is born, so that a
ring discovered hours later stays silent. It existed because a local-first app
could launch into a session that had ended overnight. With a live socket and a
server-derived state there is no such discovery, so the rule has nothing left
to protect against.

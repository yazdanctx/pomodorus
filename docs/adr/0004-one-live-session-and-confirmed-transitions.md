# 0004 — One live session per user, and nothing advances on its own

**Status:** accepted (2026-08-13); extended 2026-08-16 when breaks were built
(#16) and again when the intervals moved onto the account (#17). The
"confirmed transitions" half is
carried over from v1 unchanged
(`git show v1-nextjs:docs/adr/0004-confirmed-transitions.md`).

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

## The break is the server's to create

Confirming a pomodoro and starting its break are one transaction, and the
break's id is minted by the **server** — the one write in the app that does not
carry a client-minted id. It is not a request anybody made: it is a consequence
of the confirmation, and there is no second gesture to make idempotent.

What makes a retry safe instead is that `confirm` is idempotent on the session
it names. A tap that already landed — a double click, the other device catching
up, a request whose answer was lost — re-reads the row, sees it acknowledged,
and answers with the timer as it stands, which on the retry is the break the
first attempt started. `confirmed_at` never moves, and the partial unique index
means a second break cannot exist even if two taps race.

The alternative — a client-minted break id in the confirm body — was rejected
because it asks the client to name something it did not ask for, and buys
nothing the idempotent read does not already give.

For the same reason a live break carries the task and the length of the
pomodoro it followed. "Another one" has to mean the same work on whichever
device is at hand, and a device that opened into the ring has never picked
anything; its own remembered picks are the fallback, not the source.

## Under `FAST_SESSIONS`, only the elapse collapses

Ring time is deducted from the break on the **nominal** scale even in fast
mode: a three-second session still owes five minutes of rest, and the break
that starts then takes three seconds rather than five minutes.

The consequence is a real one and is accepted deliberately: "ring past the
whole break and there is none left" cannot be reached in fast mode without
ringing for five real minutes. The trade is the other way round — deducting on
the fast scale would make the break itself unreachable, because nobody answers
a bell within three seconds, and the flag exists precisely so that the bell,
the ring, the break and the cycle are all reachable in a minute. The no-break
path is covered by tests instead.

Auto-advancing the chain would derive even more cleanly than this — the whole
sequence is computable from one `started_at`. It is rejected because it credits
you for "breaks" spent in a meeting and runs the app on without you.

## The intervals are the account's, and a session keeps the ones it started with

v1 kept the four intervals in localStorage, because the device owned the timer
and those durations *are* the timer. With the server owning it (ADR 0001) they
follow: a phone and a laptop may not disagree about how long a rest is.

They are edited by `POST /api/intervals`, which is the second write in the app
with no client-minted id (the first is the break above). It needs none: the
dialog holds all three and sends all three, so the request is the whole of the
setting and a retry lands on the row it already wrote. There is nothing to
merge, and therefore nothing a second attempt could double.

The three split in two, though, and the split is the decision worth recording:

- **The break lengths are snapshotted.** A pomodoro copies them onto its own
  row when it starts, and the rest it hands over is read from there. Editing
  the dialog mid-session — or mid-ring — cannot change the break the session in
  front of you has already earned, which is the same rule as work being
  credited at its nominal length: a session is a stored fact, and what it owes
  is part of that fact.
- **Pomodoros-per-cycle is not.** It describes the cycle rather than the
  session, is read at completion, and applies immediately — so shortening the
  cycle while a pomodoro runs can turn the rest it is heading for into the long
  one, and the screen says so straight away.

Both are visible before the bell, because the deadline a ringing pomodoro is
racing (`breakEndsAt`) is computed from them.

Snapshotting all four instead was rejected: a cycle that only takes effect
after the next completion has no moment anybody could point at, and "every
fourth" would then mean whatever was true four pomodoros ago.

## Dropped from v1

The rule that a ring's audibility is decided once when it is born, so that a
ring discovered hours later stays silent. It existed because a local-first app
could launch into a session that had ended overnight. With a live socket and a
server-derived state there is no such discovery, so the rule has nothing left
to protect against.

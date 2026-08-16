-- name: LiveSessionForUser :one
-- The one session that has not been acknowledged or abandoned. It may be
-- running or ringing; which of those it is, is a question for the clock and
-- not for the database.
SELECT sqlc.embed(sessions), categories.name AS category_name, categories.is_public AS category_is_public
FROM sessions
LEFT JOIN categories ON categories.id = sessions.category_id
WHERE sessions.user_id = $1
  AND sessions.confirmed_at IS NULL
  AND sessions.cancelled_at IS NULL;

-- name: SessionByID :one
SELECT * FROM sessions WHERE id = $1 AND user_id = $2;

-- name: StartSession :one
-- Idempotent on the client-minted id. The partial unique index is what stops a
-- second live session existing; this returns the row rather than erroring when
-- the same start is retried.
--
-- The two break lengths are the account's, as they stood at this instant. They
-- are written once with the row and never touched again, which is what makes
-- editing the dialog mid-session unable to change the rest this session owes.
INSERT INTO sessions (id, user_id, kind, category_id, started_at, duration_ms, ends_at, short_break_ms, long_break_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (id) DO UPDATE SET id = sessions.id
RETURNING *;

-- name: CancelSession :execrows
-- Only while it is still running: once the bell has gone the work has been
-- credited, and credited work cannot be retracted.
UPDATE sessions SET cancelled_at = $3
WHERE id = $1 AND user_id = $2
  AND confirmed_at IS NULL AND cancelled_at IS NULL
  AND ends_at > $3;

-- name: ConfirmSession :execrows
-- Only once the bell has gone, and only ever this one column. The work was
-- credited at its exact nominal end, so what this records is the
-- acknowledgement and nothing else: confirming in two seconds and confirming
-- in two hours write the same history.
UPDATE sessions SET confirmed_at = $3
WHERE id = $1 AND user_id = $2
  AND confirmed_at IS NULL AND cancelled_at IS NULL
  AND ends_at <= $3;

-- name: WorkBeforeBreak :one
-- The pomodoro a break was handed over from.
--
-- Found by its end rather than by a foreign key, because that is what the two
-- rows actually share: a break is anchored at its pomodoro's nominal end, so
-- `started_at` here *is* that bell. One live session per user is what makes it
-- unambiguous — two uncancelled pomodoros cannot end at the same instant.
SELECT * FROM sessions
WHERE user_id = $1 AND kind = 'work' AND cancelled_at IS NULL AND ends_at = $2;

-- name: SessionsSince :many
-- The recent past the cycle counter is walked out of, oldest first.
--
-- Nothing stores the count: it is derived from these rows plus now(), like
-- every other piece of session state. The window only has to be wider than a
-- cycle can be — an hour of idleness ends one, and a long break every few
-- pomodoros ends one — so a day is many times over enough.
SELECT * FROM sessions
WHERE user_id = $1 AND started_at >= $2
ORDER BY started_at;

-- name: HasLiveSessionForCategory :one
-- The guard on editing a task out from under a session that is using it.
SELECT EXISTS (
    SELECT 1 FROM sessions
    WHERE user_id = $1 AND category_id = $2
      AND confirmed_at IS NULL AND cancelled_at IS NULL
);

-- name: CreditedBetween :one
-- What has been credited in a window: how many pomodoros, and how long they
-- were worth.
--
-- Bounded by `ends_at` rather than `started_at`, because that is when work is
-- credited. A pomodoro that began before Tehran midnight and rang after it
-- belongs to the new day, and one whose bell has gone counts immediately —
-- confirming it is an acknowledgement and moves nothing.
--
-- `duration_ms` rather than the wall time between the two timestamps: the
-- nominal length is what is credited, and under FAST_SESSIONS those are not
-- the same number.
SELECT count(*)::bigint AS count, coalesce(sum(duration_ms), 0)::bigint AS total_ms
FROM sessions
WHERE user_id = sqlc.arg(user_id)
  AND kind = 'work'
  AND cancelled_at IS NULL
  AND ends_at >= sqlc.arg(from_time)
  AND ends_at <= sqlc.arg(to_time);

-- name: LiveFeed :many
-- Everybody working right now, across all accounts.
--
-- A query over the sessions themselves rather than an advisory "who is online"
-- table, so it cannot go stale and cannot disagree with the timer it describes.
-- The partial index on (ends_at) where the session is live is what makes that
-- affordable.
--
-- `ends_at > @now` is how somebody leaves the feed at their bell rather than at
-- the tap that acknowledges it: ring time is not work, and advertising it as
-- work would be advertising a pomodoro that finished twenty minutes ago.
--
-- An account with no handle yet is nobody the feed can name, so it is not in it.
-- The category's name and its visibility both come back; deciding what a
-- stranger may read is the application's job and not this query's.
SELECT users.handle, sessions.kind, sessions.started_at, sessions.ends_at,
       categories.name AS category_name, categories.is_public AS category_is_public
FROM sessions
JOIN users ON users.id = sessions.user_id
LEFT JOIN categories ON categories.id = sessions.category_id
WHERE sessions.confirmed_at IS NULL
  AND sessions.cancelled_at IS NULL
  AND sessions.ends_at > @now
  AND users.handle IS NOT NULL
ORDER BY sessions.started_at DESC;

-- name: CreditedWorkBetween :many
-- The credited pomodoros in a window, for the chart to be built from.
--
-- Rows rather than a GROUP BY, because the grouping is by *Tehran* day and that
-- boundary lives in the domain package — a second definition of it in SQL would
-- be a second thing to get wrong, and this one would depend on the database's
-- own timezone data rather than the tzdata the binary embeds. The volume is a
-- few hundred rows over ninety days of heavy use, which is nothing to carry.
--
-- Bounded by `ends_at`, like every other read of credited work: it is when the
-- bell went, and a pomodoro that began before Tehran midnight and rang after it
-- belongs to the day it was credited in.
--
-- The task comes back with the row, name and visibility both, because the day
-- detail is built from the same pomodoros the line is. The join carries no
-- `deleted_at` filter on purpose: a tombstoned category keeps its name and
-- keeps appearing under it, since tidying a task list is not an edit to the
-- history recorded against it. Whether a stranger may read that name is the
-- application's question and not this query's — as in the feed.
SELECT sessions.ends_at, sessions.duration_ms,
       categories.name AS category_name, categories.is_public AS category_is_public
FROM sessions
LEFT JOIN categories ON categories.id = sessions.category_id
WHERE sessions.user_id = sqlc.arg(user_id)
  AND sessions.kind = 'work'
  AND sessions.cancelled_at IS NULL
  AND sessions.ends_at >= sqlc.arg(from_time)
  AND sessions.ends_at <= sqlc.arg(to_time)
ORDER BY sessions.ends_at;

-- name: HasCreditedWork :one
-- Whether this account has ever finished a pomodoro.
--
-- Asked separately from the chart because it is a different question: the chart
-- is about a range, and this is about a person. A week with nothing in it is a
-- flat line — the zero-fill exists to draw exactly that — and only somebody who
-- has never finished anything at all gets an empty state instead.
SELECT EXISTS (
    SELECT 1 FROM sessions
    WHERE user_id = $1 AND kind = 'work' AND cancelled_at IS NULL AND ends_at <= $2
);

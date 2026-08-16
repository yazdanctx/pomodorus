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
INSERT INTO sessions (id, user_id, kind, category_id, started_at, duration_ms, ends_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
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

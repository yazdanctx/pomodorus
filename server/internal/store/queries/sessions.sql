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

-- name: HasLiveSessionForCategory :one
-- The guard on editing a task out from under a session that is using it.
SELECT EXISTS (
    SELECT 1 FROM sessions
    WHERE user_id = $1 AND category_id = $2
      AND confirmed_at IS NULL AND cancelled_at IS NULL
);

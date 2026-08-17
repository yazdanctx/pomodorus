-- name: SaveSubscription :exec
-- Idempotent on the endpoint, which is the device's own name for itself. A tab
-- that re-subscribes on every load writes the same row every time, and a shared
-- browser that is now somebody else's moves it to them.
INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (endpoint) DO UPDATE
    SET user_id = excluded.user_id,
        p256dh  = excluded.p256dh,
        auth    = excluded.auth;

-- name: SubscriptionsForUser :many
SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1;

-- name: DeleteSubscription :exec
-- By endpoint alone, with no user_id: this is what the push service reporting
-- "gone" turns into, and by then the row's owner is beside the point. The
-- endpoint is unguessable and belongs to whoever holds it, which is the same
-- thing that makes it safe as the key.
DELETE FROM push_subscriptions WHERE endpoint = $1;

-- name: PendingBells :many
-- Every bell that has not rung yet, across all accounts, for the in-memory
-- timers to be rebuilt from at boot.
--
-- Bounded by `ends_at > $1` on purpose: a bell that went while the process was
-- down has already been missed, and a notification for it now would be an
-- alarm about something that finished during the restart. Nothing is written
-- here and nothing is written when one of these fires — the timer is a
-- courtesy laid over state that is still derived from the rows themselves.
SELECT id, user_id, kind, ends_at FROM sessions
WHERE confirmed_at IS NULL AND cancelled_at IS NULL AND ends_at > $1
ORDER BY ends_at;

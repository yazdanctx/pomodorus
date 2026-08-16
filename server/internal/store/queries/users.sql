-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: SetIntervals :one
-- The account's intervals, replaced whole. There is nothing to merge: the
-- dialog holds all three and sends all three, so a stepper tapped on a phone
-- cannot quietly revert what was set on a laptop a moment ago.
--
-- The bands are a CHECK on the table as well as a guard in the handler, so the
-- worst a bug here can do is fail.
UPDATE users SET short_break_ms = $2, long_break_ms = $3, per_cycle = $4
WHERE id = $1
RETURNING *;

-- name: ClaimHandle :one
-- Claimed once. The WHERE is what makes it once: a user who already has one
-- matches nothing, so a second claim is a no-op that the caller can recognise
-- rather than a silent overwrite. The trigger on the table refuses a rename
-- anyway — this is the layer that gives a readable answer, not the one that
-- enforces it.
UPDATE users SET handle = $2, handle_set_at = $3
WHERE id = $1 AND handle IS NULL
RETURNING *;

-- name: UserByHandle :one
-- The public lookup, and the only one that finds somebody by the name they
-- chose rather than by their credential.
--
-- `handle` is citext, so this folds case the way the person typing the URL
-- expects: /u/Yazdan and /u/yazdan are the same profile, and neither is a
-- second account waiting to be claimed.
SELECT * FROM users WHERE handle = $1;

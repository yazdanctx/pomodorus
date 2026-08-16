-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: ClaimHandle :one
-- Claimed once. The WHERE is what makes it once: a user who already has one
-- matches nothing, so a second claim is a no-op that the caller can recognise
-- rather than a silent overwrite. The trigger on the table refuses a rename
-- anyway — this is the layer that gives a readable answer, not the one that
-- enforces it.
UPDATE users SET handle = $2, handle_set_at = $3
WHERE id = $1 AND handle IS NULL
RETURNING *;

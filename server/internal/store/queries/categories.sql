-- name: LiveCategories :many
SELECT * FROM categories
WHERE user_id = $1 AND deleted_at IS NULL
ORDER BY created_at;

-- name: CategoryByID :one
-- Tombstones included: a caller editing a category that was deleted on another
-- device needs to be told it is gone, not told it never existed.
SELECT * FROM categories WHERE id = $1 AND user_id = $2;

-- name: CreateCategory :one
-- Idempotent on the client-minted id: a retry returns the row the first
-- attempt made rather than making a second one. The DO UPDATE is a no-op that
-- exists only so RETURNING fires on the conflict path too.
INSERT INTO categories (id, user_id, name, is_public, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $5)
ON CONFLICT (id) DO UPDATE SET id = categories.id
RETURNING *;

-- name: UpdateCategory :one
UPDATE categories SET name = $3, is_public = $4, updated_at = $5
WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
RETURNING *;

-- name: DeleteCategory :execrows
-- A tombstone. Deleting one that is already deleted is not an error — the
-- caller asked for a state, and the state is what it gets.
UPDATE categories SET deleted_at = $3, updated_at = $3
WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL;

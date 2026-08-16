-- name: UserByID :one
SELECT * FROM users WHERE id = $1;

-- name: UserByHandle :one
SELECT * FROM users WHERE handle = $1;

-- name: CountUsers :one
SELECT count(*) FROM users;

-- +goose Up

-- The labels a user attaches to their focus time: a name, and whether
-- strangers may read it.
CREATE TABLE categories (
    -- Client-minted. Every mutation in this app carries an id the client
    -- chose, so a retry on a poor connection lands on the row it already
    -- created rather than making a second one.
    id         uuid PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       text        NOT NULL,
    -- A private category's name never leaves its owner: the feed and a
    -- visitor's view of a profile show a generic label in its place.
    is_public  boolean     NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    -- A tombstone, not a delete. Past sessions keep pointing at the row and
    -- the row keeps its name, so tidying up a task list never erases the
    -- focus time recorded against it.
    deleted_at timestamptz,

    -- Restated from the app because the database is the layer that cannot be
    -- bypassed. Forty is what the picker's field allows.
    CONSTRAINT category_name_length CHECK (char_length(name) BETWEEN 1 AND 40)
);

-- Every read is "this user's live categories", so the tombstones are kept out
-- of the index rather than filtered out of the result.
CREATE INDEX categories_live_idx ON categories (user_id, created_at)
    WHERE deleted_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS categories;

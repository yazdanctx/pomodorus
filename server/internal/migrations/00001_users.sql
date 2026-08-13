-- +goose Up

-- Case-insensitive text, so an address typed as Yazdan@Gmail.com and one typed
-- as yazdan@gmail.com are the same account rather than two. Handles get it for
-- the same reason: the URL /u/Yazdan and /u/yazdan must not be two people.
CREATE EXTENSION IF NOT EXISTS citext;

-- Email is the credential and is never shown to anyone. `handle` is the public
-- identity: it appears in the feed, on the profile, and in the profile URL.
--
-- The handle is nullable because the account exists the moment the code is
-- verified, before its owner has picked one — an account with no handle is
-- signed in but cannot yet appear anywhere public. It is set exactly once and
-- a trigger refuses to change it afterwards, because shared profile links are
-- expected to keep working forever.
CREATE TABLE users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email       citext      NOT NULL UNIQUE,
    handle      citext      UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    handle_set_at timestamptz,

    -- Same shape the client validates against, restated here because the
    -- database is the only place that cannot be bypassed.
    CONSTRAINT handle_format CHECK (handle IS NULL OR handle ~ '^[a-z0-9_]{3,20}$'),
    CONSTRAINT handle_set_at_agrees CHECK ((handle IS NULL) = (handle_set_at IS NULL))
);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION users_handle_is_immutable() RETURNS trigger AS $$
BEGIN
    IF OLD.handle IS NOT NULL AND NEW.handle IS DISTINCT FROM OLD.handle THEN
        RAISE EXCEPTION 'handle is immutable (user %)', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER users_handle_immutable
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION users_handle_is_immutable();

-- +goose Down
DROP TRIGGER IF EXISTS users_handle_immutable ON users;
DROP FUNCTION IF EXISTS users_handle_is_immutable();
DROP TABLE IF EXISTS users;

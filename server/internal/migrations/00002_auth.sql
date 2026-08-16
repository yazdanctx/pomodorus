-- +goose Up

-- A login code, from the moment it is requested until it is used, expires or
-- is superseded. There is no password anywhere in this app, so this table and
-- the one below it are the whole of authentication.
--
-- Every timestamp here is written by the application, never by now(): the
-- clock is an injected dependency so that a test can move it, and a column
-- Postgres filled in would be a column no test can move.
CREATE TABLE login_codes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- citext, so a code requested for Yazdan@Gmail.com is verifiable by
    -- someone who types it back in lowercase.
    email        citext      NOT NULL,
    -- Hashed at rest and compared in constant time. Six digits is a small
    -- space, so what actually protects it is the ten-minute expiry, the
    -- five-attempt limit and the rate limits below — the hash is what stops a
    -- leaked backup from being a pile of live codes.
    code_hash    bytea       NOT NULL,
    -- Kept for the per-IP rate limit. It is not identity and is never shown.
    requested_ip inet,
    created_at   timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL,
    -- Counts wrong guesses. At the limit the row is consumed, so the code
    -- cannot be guessed by persistence.
    attempts     int         NOT NULL DEFAULT 0,
    -- Set the moment the code is used or invalidated. A consumed row is dead:
    -- this is what makes a forwarded or leaked email unrepeatable.
    consumed_at  timestamptz
);

-- Both rate limits are counts over a recent window, so both read this index.
CREATE INDEX login_codes_email_created_idx ON login_codes (email, created_at DESC);
CREATE INDEX login_codes_ip_created_idx ON login_codes (requested_ip, created_at DESC);

-- An authenticated session. The token itself is 32 random bytes handed to the
-- browser in an httpOnly cookie and never stored — only its hash is, so a
-- database read does not hand anybody a working session.
--
-- The row is what makes signing out real: deleting it stops the cookie
-- working immediately, everywhere, which a self-contained signed token could
-- not do.
CREATE TABLE auth_sessions (
    token_hash   bytea PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL,
    -- Slides forward as the session is used, so a tool somebody opens every
    -- day never asks them to sign in again.
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL
);

CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

-- +goose Down
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS login_codes;

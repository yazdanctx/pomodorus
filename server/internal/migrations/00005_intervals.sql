-- +goose Up

-- The intervals live on the account rather than on the device. The device no
-- longer owns the timer, so it no longer owns what a break is worth: a phone
-- and a laptop cannot be allowed to disagree about how long a rest lasts.
--
-- The defaults are the classic technique, so an account that never opens the
-- dialog is the technique. The CHECKs are the bands the dialog's steppers walk,
-- restated here because the database is the only place that cannot be bypassed
-- — as with the handle's shape.
--
-- The pomodoro's own length is deliberately not here: it is a per-session
-- decision made on the start screen, not a policy.
ALTER TABLE users
    ADD COLUMN short_break_ms bigint  NOT NULL DEFAULT 300000,
    ADD COLUMN long_break_ms  bigint  NOT NULL DEFAULT 1200000,
    ADD COLUMN per_cycle      integer NOT NULL DEFAULT 4,

    ADD CONSTRAINT short_break_in_band CHECK (
        short_break_ms BETWEEN 180000 AND 900000 AND short_break_ms % 60000 = 0),
    ADD CONSTRAINT long_break_in_band CHECK (
        long_break_ms BETWEEN 600000 AND 2100000 AND (long_break_ms - 600000) % 300000 = 0),
    ADD CONSTRAINT per_cycle_in_band CHECK (per_cycle BETWEEN 2 AND 6);

-- What the two breaks were worth when this pomodoro started, copied off the
-- account at that moment. A session is a stored fact, and the rest it owes is
-- part of that fact: editing the dialog mid-session, or mid-ring, cannot change
-- the break the session in front of you has already earned.
--
-- Both are carried because which of them is owed depends on the cycle counter
-- at completion, and pomodoros-per-cycle is deliberately *not* snapshotted — it
-- describes the cycle rather than the session, is read at completion, and
-- applies immediately.
--
-- Nullable, because a break owes no break of its own, and because a row written
-- before this migration recorded nothing: such a pomodoro falls back to the
-- account's current intervals, which is the closest thing to what it meant.
ALTER TABLE sessions
    ADD COLUMN short_break_ms bigint,
    ADD COLUMN long_break_ms  bigint,

    ADD CONSTRAINT session_breaks_are_positive CHECK (
        (short_break_ms IS NULL OR short_break_ms > 0) AND
        (long_break_ms IS NULL OR long_break_ms > 0)),
    -- One snapshot or none: a pomodoro that knew one of its breaks and not the
    -- other would be a fact nothing produces.
    ADD CONSTRAINT session_breaks_agree CHECK (
        (short_break_ms IS NULL) = (long_break_ms IS NULL)),
    -- Only work owes rest; a break is a break.
    ADD CONSTRAINT break_owes_no_break CHECK (kind = 'work' OR short_break_ms IS NULL);

-- +goose Down
ALTER TABLE sessions
    DROP CONSTRAINT IF EXISTS break_owes_no_break,
    DROP CONSTRAINT IF EXISTS session_breaks_agree,
    DROP CONSTRAINT IF EXISTS session_breaks_are_positive,
    DROP COLUMN IF EXISTS long_break_ms,
    DROP COLUMN IF EXISTS short_break_ms;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS per_cycle_in_band,
    DROP CONSTRAINT IF EXISTS long_break_in_band,
    DROP CONSTRAINT IF EXISTS short_break_in_band,
    DROP COLUMN IF EXISTS per_cycle,
    DROP COLUMN IF EXISTS long_break_ms,
    DROP COLUMN IF EXISTS short_break_ms;

-- +goose Up

CREATE TYPE session_kind AS ENUM ('work', 'short_break', 'long_break');

-- A Session is a stored fact, never a ticking clock. Its state is a pure
-- function of these columns plus now(): before ends_at it is running, after
-- ends_at and unconfirmed it is ringing, once confirmed or cancelled it is
-- over. There is no scheduler, no cron, and no job that flips a row — see
-- docs/adr/0002-derived-state-no-scheduler.md, and do not add one.
CREATE TABLE sessions (
    -- Client-minted, so a start that is retried on a poor connection lands on
    -- the session it already began rather than beginning a second one.
    id           uuid         PRIMARY KEY,
    user_id      uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         session_kind NOT NULL,

    -- Nullable because a break has no task, and because a work session's
    -- category may be a tombstone by the time anybody reads this row. There is
    -- deliberately no ON DELETE: categories are never actually deleted.
    category_id  uuid REFERENCES categories(id),

    started_at   timestamptz NOT NULL,

    -- What is credited. It is the *nominal* length — the twenty-five minutes
    -- somebody chose — and it is what the history and the feed are built from.
    duration_ms  bigint      NOT NULL,

    -- When the bell actually rings. Normally started_at + duration_ms; under
    -- FAST_SESSIONS it is seconds away while duration_ms stays whole, which is
    -- what makes the bell, the ring, the break and the cycle testable in a
    -- minute. Keeping it as its own column puts that entire trick at the
    -- moment of creation, so nothing downstream has to know about it.
    ends_at      timestamptz NOT NULL,

    -- The only column that is ever updated after the row is written: the
    -- acknowledgement of the bell. Work is credited at its exact nominal end
    -- whatever this says, so confirming late records the same thing as
    -- confirming instantly.
    confirmed_at timestamptz,

    -- An interrupted session. It is not credited and it does not advance the
    -- cycle, so abandoning one cannot earn a break.
    cancelled_at timestamptz,

    CONSTRAINT session_ends_after_it_starts CHECK (ends_at > started_at),
    CONSTRAINT session_has_a_duration CHECK (duration_ms > 0),
    -- A session cannot be both acknowledged and abandoned.
    CONSTRAINT session_one_ending CHECK (confirmed_at IS NULL OR cancelled_at IS NULL),
    -- Only work has a task; a break is a break.
    CONSTRAINT break_has_no_category CHECK (kind = 'work' OR category_id IS NULL)
);

-- One live session per user, decided here rather than by a check-then-write.
-- This is what makes the timer belong to the person instead of the device: a
-- second device asking to start cannot create a second timer, whatever the
-- application layer does. A ringing session is still live — it has to be
-- acknowledged before anything else can begin.
CREATE UNIQUE INDEX sessions_one_live_per_user ON sessions (user_id)
    WHERE confirmed_at IS NULL AND cancelled_at IS NULL;

-- The history reads "this user's credited work, most recent first".
CREATE INDEX sessions_credited_idx ON sessions (user_id, ends_at DESC)
    WHERE cancelled_at IS NULL;

-- The feed reads "everything live right now", across all users.
CREATE INDEX sessions_live_idx ON sessions (ends_at)
    WHERE confirmed_at IS NULL AND cancelled_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS sessions;
DROP TYPE IF EXISTS session_kind;

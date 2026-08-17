-- +goose Up

-- A device that has agreed to be told when its bell goes.
--
-- One row per device rather than per account: the point of push is reaching
-- somebody whose tab is closed, and which of their devices that is, is not
-- knowable in advance. A phone and a laptop both subscribe, both are stored,
-- and both are sent to.
--
-- Nothing here is session state. The whole table is an address book — losing
-- it costs notifications and never correctness, exactly as losing the
-- in-memory timers that read it does.
CREATE TABLE push_subscriptions (
    -- The push service's URL for this device *is* its identity: the browser
    -- mints it, hands back the same one until it rotates, and a rotation is a
    -- different device as far as anything here is concerned. So it is the key,
    -- and re-subscribing is an upsert rather than a second row.
    endpoint   text NOT NULL PRIMARY KEY,

    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- The two halves of RFC 8291's key agreement, exactly as the browser's
    -- PushSubscription hands them over: base64url, opaque to this app, and
    -- only ever passed through to the encryption. A shared device that signs
    -- out and in as somebody else keeps its endpoint and moves its user_id,
    -- which is why the keys are updated on conflict too.
    p256dh     text NOT NULL,
    auth       text NOT NULL,

    created_at timestamptz NOT NULL,

    CONSTRAINT push_endpoint_is_absolute CHECK (endpoint LIKE 'https://%'),
    CONSTRAINT push_keys_are_present CHECK (p256dh <> '' AND auth <> '')
);

-- The one read this table has: everything to send to for one person.
CREATE INDEX push_subscriptions_by_user ON push_subscriptions (user_id);

-- +goose Down
DROP TABLE IF EXISTS push_subscriptions;

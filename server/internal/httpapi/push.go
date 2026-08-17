package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/yazdanctx/pomodorus/server/internal/push"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// The push surface is two things and no more: the key a browser needs before
// it can subscribe, and the subscription it produces. There is no unsubscribe,
// because nothing here is a subscription's only ending — a browser that drops
// one makes the push service report it gone at the next bell, and that is what
// deletes the row. One path rather than two, and the one that cannot be
// skipped by a tab that was closed before it could tell us.

type pushKeyResponse struct {
	// The VAPID public key, base64url, as applicationServerKey wants it. Empty
	// means this deployment has no keypair and the bell cannot reach a closed
	// tab — a fact about the deployment rather than a failure, so it is a 200.
	PublicKey string `json:"publicKey"`
}

func (s *Server) pushKey(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, pushKeyResponse{PublicKey: s.cfg.VAPID.PublicKey})
}

// subscribeRequest is the browser's PushSubscription, flattened.
//
// Flattened rather than accepting `subscription.toJSON()` whole because that
// object also carries an `expirationTime` nothing here has a use for, and this
// server refuses fields it does not know about — a typo in a field name should
// fail loudly rather than be quietly ignored.
type subscribeRequest struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

// The endpoint is a URL a push service minted, and the keys are fixed-size
// values base64url-encoded. None of them is anywhere near these bounds; the
// bounds exist so that a bug or a spiteful client cannot put a megabyte in a
// primary key.
const (
	maxEndpoint = 2048
	maxPushKey  = 256
)

// subscribePush records a device that has agreed to be told when its bell goes.
//
// Idempotent on the endpoint, which is the device's own name for itself: a tab
// that re-subscribes on every load writes the same row every time. There is no
// client-minted id here for the same reason there is no id column — the push
// service already minted the only identity this row has.
func (s *Server) subscribePush(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	var body subscribeRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	endpoint := strings.TrimSpace(body.Endpoint)
	p256dh := strings.TrimSpace(body.P256dh)
	auth := strings.TrimSpace(body.Auth)
	// https only, because that is what a push service is and because the
	// column's own CHECK says so — a row that failed the constraint would be a
	// 500 for what is a malformed request.
	if !strings.HasPrefix(endpoint, "https://") || len(endpoint) > maxEndpoint {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}
	if p256dh == "" || auth == "" || len(p256dh) > maxPushKey || len(auth) > maxPushKey {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	if err := s.q.SaveSubscription(ctx, db.SaveSubscriptionParams{
		Endpoint:  endpoint,
		UserID:    user.ID,
		P256dh:    p256dh,
		Auth:      auth,
		CreatedAt: pgTime(s.now()),
	}); err != nil {
		s.log.Error("save push subscription", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	// Answered with the timer state, like every other write, so the tab that
	// just subscribed mid-session is not left having to ask again. Nothing is
	// pushed for it: another device does not care which addresses this one
	// keeps.
	s.writeTimerState(ctx, w, user, s.now())
}

// --- the notifier's view of the world ---------------------------------------

// pushStore is the address book as the push package needs it. It is the whole
// of the dependency: the notifier knows about subscriptions and pending bells,
// and nothing about sessions, users or SQL.
type pushStore struct{ q *db.Queries }

func (p pushStore) SubscriptionsFor(ctx context.Context, userID uuid.UUID) ([]push.Subscription, error) {
	rows, err := p.q.SubscriptionsForUser(ctx, pgID(userID))
	if err != nil {
		return nil, err
	}
	subs := make([]push.Subscription, 0, len(rows))
	for _, row := range rows {
		subs = append(subs, push.Subscription{
			Endpoint: row.Endpoint, P256dh: row.P256dh, Auth: row.Auth,
		})
	}
	return subs, nil
}

func (p pushStore) Forget(ctx context.Context, endpoint string) error {
	return p.q.DeleteSubscription(ctx, endpoint)
}

func (p pushStore) Pending(ctx context.Context, after time.Time) ([]push.Bell, error) {
	rows, err := p.q.PendingBells(ctx, pgTime(after))
	if err != nil {
		return nil, err
	}
	bells := make([]push.Bell, 0, len(rows))
	for _, row := range rows {
		bells = append(bells, push.Bell{
			SessionID: uuid.UUID(row.ID.Bytes),
			UserID:    uuid.UUID(row.UserID.Bytes),
			Kind:      string(kindOf(row.Kind)),
			At:        row.EndsAt.Time,
		})
	}
	return bells, nil
}

// armBell keeps the pending notification in step with the timer.
//
// It is called with the state a handler just answered, so what gets armed is
// exactly what the caller was told — there is no second read that could
// disagree with it. Arming replaces, so calling this on every change is the
// whole of keeping it correct: an edit that moves nothing re-arms the same
// instant, and a state with no live session arms nothing.
//
// None of this is state. Losing every timer costs notifications and never the
// timer, which is why it is done after the answer has gone out rather than
// inside the transaction that produced it.
func (s *Server) armBell(user db.User, state sessionResponse) {
	if state.Session == nil {
		return
	}
	id, err := uuid.Parse(state.Session.ID)
	if err != nil {
		return
	}
	s.push.Arm(push.Bell{
		SessionID: id,
		UserID:    uuid.UUID(user.ID.Bytes),
		Kind:      state.Session.Kind,
		At:        time.UnixMilli(state.Session.EndsAt).UTC(),
	})
}

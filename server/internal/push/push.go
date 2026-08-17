// Package push is the bell reaching somebody whose tab is closed.
//
// It is the one place in this app where something happens because time passed
// rather than because a request arrived, and it is deliberately the smallest
// possible version of that: one in-memory timer per live session, whose entire
// job is to send a notification. It writes nothing. It owns no truth. Session
// state stays exactly what it was before this package existed — a pure
// function of the stored row plus now() — so a process that restarts and loses
// every timer here loses notifications and nothing else. See
// docs/adr/0002-derived-state-no-scheduler.md, which this does not contradict:
// nothing below can change what the timer *is*.
//
// The two things it cannot do for itself are injected. Sending is I/O against
// a push service, so a test gets a Sender that records instead. Waiting cannot
// be done with the injected clock — a fixed clock never reaches anything — so
// a test gets a Delay it fires by hand, and neither the arming nor the
// cancelling below has to know which it has.
package push

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/yazdanctx/pomodorus/server/internal/clock"
)

// Subscription is one device that has agreed to be told, exactly as the
// browser's PushSubscription describes itself. The two keys are opaque here:
// they are passed through to the encryption and read by nothing else.
type Subscription struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// ErrGone is a push service saying this subscription will never work again —
// the browser dropped it, the user cleared their data, the endpoint rotated.
// It is the difference between a failure to retry later and a row to delete,
// which is why it is a sentinel rather than a status code left to the caller.
var ErrGone = errors.New("push: the subscription is gone")

// Sender delivers one encrypted payload to one device.
type Sender interface {
	Send(ctx context.Context, to Subscription, payload []byte) error
}

// Bell is a ring that has not happened yet: which session, whose, what kind of
// session it is, and when it goes off.
type Bell struct {
	SessionID uuid.UUID
	UserID    uuid.UUID
	// The wire's spelling of the kind — "work", "shortBreak", "longBreak" —
	// because the service worker is what reads it, and the service worker
	// picks its Persian out of copy.json by this name. No sentence crosses
	// from here: the words belong to the client.
	Kind string
	At   time.Time
}

// Store is the address book, as this package needs it.
type Store interface {
	SubscriptionsFor(ctx context.Context, userID uuid.UUID) ([]Subscription, error)
	// Forget removes a subscription a push service has reported as gone. It is
	// the whole of "not retried forever".
	Forget(ctx context.Context, endpoint string) error
	// Pending is every bell still ahead of an instant, which is what the
	// timers are rebuilt from at boot.
	Pending(ctx context.Context, after time.Time) ([]Bell, error)
}

// Delay is waiting, as the one thing here that a moved clock cannot express.
//
// The injected clock says what time it is and is driven by hand in tests; it
// can never make a timer fire. So the wait is its own seam: production hands
// over time.AfterFunc, and a test hands over something it triggers itself.
type Delay interface {
	// After runs f once, d from now, unless the returned cancel runs first.
	// Cancelling after f has run, or twice, does nothing.
	//
	// It must return before it runs f — never synchronously — because the
	// arming below calls it holding the lock that f then takes.
	After(d time.Duration, f func()) (cancel func())
}

// Real is the wait that actually waits.
type Real struct{}

func (Real) After(d time.Duration, f func()) func() {
	t := time.AfterFunc(d, f)
	return func() { t.Stop() }
}

// Deps is everything a Notifier does not construct for itself.
type Deps struct {
	Store  Store
	Sender Sender
	Delay  Delay
	Clock  clock.Clock
	Log    *slog.Logger
}

// Notifier holds the pending bells: one cancellable timer per live session.
//
// A nil *Notifier is a working Notifier that does nothing, which is what the
// app runs as when no VAPID keys are configured. That is deliberate — the
// alternative is an interface and a null implementation for a feature whose
// absence is meant to be invisible everywhere it is called from.
type Notifier struct {
	store  Store
	sender Sender
	delay  Delay
	clock  clock.Clock
	log    *slog.Logger

	mu    sync.Mutex
	armed map[uuid.UUID]*pending
}

// pending is one armed bell. It is a pointer so that a timer which fires can
// tell whether the entry in the map is still its own: re-arming the same
// session replaces the entry, and the replaced timer must not then delete its
// successor on the way out.
type pending struct {
	cancel func()
}

func New(deps Deps) *Notifier {
	if deps.Store == nil || deps.Sender == nil {
		return nil
	}
	if deps.Delay == nil {
		deps.Delay = Real{}
	}
	return &Notifier{
		store:  deps.Store,
		sender: deps.Sender,
		delay:  deps.Delay,
		clock:  deps.Clock,
		log:    deps.Log,
		armed:  make(map[uuid.UUID]*pending),
	}
}

// Arm schedules the notification for a bell, replacing any already armed for
// that session.
//
// A bell that is not in the future is dropped rather than fired late. Two
// cases reach that: a session restored at boot whose bell went while the
// process was down, and a clock that has moved on past it. Neither is worth an
// alarm — the ring is already on screen for anybody looking, and a push that
// arrives announcing something that finished during a restart is noise.
func (n *Notifier) Arm(b Bell) {
	if n == nil {
		return
	}
	wait := b.At.Sub(n.clock.Now())
	if wait <= 0 {
		return
	}

	entry := &pending{}

	// Everything about `armed` — including each entry's cancel — happens under
	// this one lock, and the timer is started inside it. Publishing an entry
	// whose cancel was still being assigned is the race that lets a cancelled
	// pomodoro push anyway: a Disarm landing in that window would find nothing
	// to stop. The lock is held across the call into Delay, which is why Delay
	// is documented as never running its callback synchronously.
	n.mu.Lock()
	defer n.mu.Unlock()

	if was, ok := n.armed[b.SessionID]; ok {
		was.cancel()
	}
	n.armed[b.SessionID] = entry
	entry.cancel = n.delay.After(wait, func() {
		n.mu.Lock()
		// Only if this entry is still the one armed for the session. A bell
		// that was re-armed while this timer was in flight must not delete its
		// successor on the way out.
		if n.armed[b.SessionID] == entry {
			delete(n.armed, b.SessionID)
		}
		n.mu.Unlock()
		n.ring(b)
	})
}

// Disarm drops a session's pending notification. This is what cancelling a
// pomodoro and acknowledging a bell both do: the first because there is no
// longer anything to announce, the second because it has already been seen.
func (n *Notifier) Disarm(sessionID uuid.UUID) {
	if n == nil {
		return
	}
	n.mu.Lock()
	entry, ok := n.armed[sessionID]
	delete(n.armed, sessionID)
	n.mu.Unlock()
	if ok {
		entry.cancel()
	}
}

// Restore rebuilds the timers from the database, which is what a boot does
// with them. One query, no state written, and a bell already missed is left
// missed — see Arm.
func (n *Notifier) Restore(ctx context.Context) error {
	if n == nil {
		return nil
	}
	bells, err := n.store.Pending(ctx, n.clock.Now())
	if err != nil {
		return err
	}
	for _, bell := range bells {
		n.Arm(bell)
	}
	return nil
}

// Close stops every pending timer, so a shutdown does not leave goroutines
// holding a Notifier that is on its way out. Nothing is lost by it that a
// restart would not have lost anyway.
func (n *Notifier) Close() {
	if n == nil {
		return
	}
	n.mu.Lock()
	entries := n.armed
	n.armed = make(map[uuid.UUID]*pending)
	n.mu.Unlock()
	for _, entry := range entries {
		entry.cancel()
	}
}

// Pending is how many bells are armed. It exists for the tests and for a log
// line at boot; nothing in the app branches on it.
func (n *Notifier) Pending() int {
	if n == nil {
		return 0
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.armed)
}

// bellPayload is what crosses to the service worker. Enough to say which ring
// this is and no more: the words are the client's, and the sentence for a
// `kind` lives in copy.json beside the one the in-tab notification uses.
//
// There is deliberately no instant on it. Everything else that crosses the
// wire carries one because something derives state from it; nothing here does,
// and a push that arrives late is dropped by the push service rather than
// reasoned about — that is what the TTL is for.
type bellPayload struct {
	// Which ring this was. The worker does not read it; it is what makes a
	// delivery traceable to the session it announced.
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
}

// sendTimeout is the whole budget for telling one device. Generous, because a
// push service on the far side of a censored network is slow before it is
// broken, and bounded, because nothing is waiting on the answer.
const sendTimeout = 20 * time.Second

// ring sends the bell to every device the person has subscribed.
//
// It runs on the timer's own goroutine with no request behind it, so it takes
// a fresh context rather than inheriting one that was cancelled when the POST
// that armed it was answered.
func (n *Notifier) ring(b Bell) {
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()

	subs, err := n.store.SubscriptionsFor(ctx, b.UserID)
	if err != nil {
		n.logError("push: read subscriptions", err)
		return
	}
	if len(subs) == 0 {
		return
	}

	payload, err := json.Marshal(bellPayload{
		SessionID: b.SessionID.String(),
		Kind:      b.Kind,
	})
	if err != nil {
		n.logError("push: encode payload", err)
		return
	}

	for _, sub := range subs {
		switch err := n.sender.Send(ctx, sub, payload); {
		case err == nil:
		case errors.Is(err, ErrGone):
			// Deleted rather than retried until the end of time. A browser that
			// has dropped a subscription never takes it back, and a row kept
			// for it is one guaranteed failure on every future bell.
			if err := n.store.Forget(ctx, sub.Endpoint); err != nil {
				n.logError("push: forget subscription", err)
			}
		default:
			// Anything else is this attempt failing, not this device being
			// gone. There is no retry: the bell is a moment, and a notification
			// delivered minutes after it would be worse than none.
			n.logError("push: send", err)
		}
	}
}

func (n *Notifier) logError(msg string, err error) {
	if n.log == nil {
		return
	}
	n.log.Error(msg, "error", err)
}

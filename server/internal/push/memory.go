package push

import (
	"context"
	"sync"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/clock"
)

// Memory is a Sender that keeps what it was asked to deliver instead of
// delivering it. It is the seam a test asserts on: "this device was told" is
// observable without a push service, a network, or a browser.
//
// It lives here rather than in a _test.go file because the API-level harness
// is a different package and needs it.
type Memory struct {
	mu   sync.Mutex
	sent []Delivery
	// gone is the set of endpoints this sender pretends have expired, which is
	// how a test provokes the deletion path without a real 410.
	gone map[string]bool
	fail error
}

// Delivery is one payload handed to one device.
type Delivery struct {
	To      Subscription
	Payload []byte
}

func NewMemory() *Memory { return &Memory{gone: make(map[string]bool)} }

func (m *Memory) Send(_ context.Context, to Subscription, payload []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gone[to.Endpoint] {
		return ErrGone
	}
	if m.fail != nil {
		return m.fail
	}
	m.sent = append(m.sent, Delivery{To: to, Payload: payload})
	return nil
}

// Sent is everything delivered so far, oldest first.
func (m *Memory) Sent() []Delivery {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Delivery(nil), m.sent...)
}

// Gone makes an endpoint answer as expired, the way a push service reports a
// subscription the browser has dropped.
func (m *Memory) Gone(endpoint string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gone[endpoint] = true
}

// Fail makes every send report an ordinary failure — the push service being
// unreachable rather than the subscription being dead.
func (m *Memory) Fail(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.fail = err
}

// Manual is a Delay that never waits. It records what was asked for against
// the injected clock, and fires whatever that clock has reached when a test
// says so.
//
// This is what keeps the push path testable under the same rule as everything
// else here: move the clock, ask what the server says. The one difference is
// that a bell has to be rung explicitly, because a fixed clock cannot notice
// it has passed anything.
type Manual struct {
	clock clock.Clock

	mu      sync.Mutex
	pending []*armed
}

type armed struct {
	at       time.Time
	fire     func()
	finished bool
}

func NewManual(c clock.Clock) *Manual { return &Manual{clock: c} }

func (m *Manual) After(d time.Duration, f func()) func() {
	entry := &armed{at: m.clock.Now().Add(d), fire: f}

	m.mu.Lock()
	m.pending = append(m.pending, entry)
	m.mu.Unlock()

	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		entry.finished = true
	}
}

// Due fires every bell the clock has reached, and reports how many went off.
//
// The callbacks run outside the lock, because one of them arming another — a
// pomodoro's bell is not that, but nothing here should depend on it — must not
// deadlock.
func (m *Manual) Due() int {
	now := m.clock.Now()

	m.mu.Lock()
	var ring []*armed
	var keep []*armed
	for _, entry := range m.pending {
		switch {
		case entry.finished:
		case !entry.at.After(now):
			entry.finished = true
			ring = append(ring, entry)
		default:
			keep = append(keep, entry)
		}
	}
	m.pending = keep
	m.mu.Unlock()

	for _, entry := range ring {
		entry.fire()
	}
	return len(ring)
}

// Armed is how many bells are waiting, which is what a test asserting that
// something was cancelled looks at.
func (m *Manual) Armed() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, entry := range m.pending {
		if !entry.finished {
			n++
		}
	}
	return n
}

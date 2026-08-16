// Package clock is the app's only source of the current time.
//
// Nothing calls time.Now() directly. Session state is derived from stored
// facts plus "now" rather than scheduled, which means a test that can move
// "now" can exercise the bell, the ring, the break and the whole cycle
// instantly — no sleeping, no fake scheduler, and nothing that goes flaky on
// a loaded machine.
//
// The database's own now() is deliberately not used for anything the app
// reasons about, for the same reason: it cannot be moved, so a timestamp
// written by Postgres would disagree with a test's clock.
package clock

import (
	"sync"
	"time"
)

type Clock interface {
	Now() time.Time
}

// System is the real clock, in UTC. Every instant in this app is stored and
// sent as UTC epoch milliseconds; Tehran only ever appears at the point where
// a day boundary is being decided.
func System() Clock { return system{} }

type system struct{}

func (system) Now() time.Time { return time.Now().UTC() }

// Fixed is a clock a test drives by hand. It is safe for concurrent use
// because the server under test reads it from its own goroutines.
type Fixed struct {
	mu  sync.Mutex
	now time.Time
}

func NewFixed(at time.Time) *Fixed { return &Fixed{now: at.UTC()} }

func (f *Fixed) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// Advance moves the clock forward. This is how expiry, the bell and the break
// are tested: the assertion is about what the server says at a later instant,
// not about whether a timer fired.
func (f *Fixed) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}

func (f *Fixed) Set(at time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = at.UTC()
}

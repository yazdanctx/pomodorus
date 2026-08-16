// Package timer is the pomodoro's rules, with no I/O in sight.
//
// Everything here is a pure function of stored facts plus an instant, which is
// what lets the whole timer be exercised by moving a clock rather than by
// waiting. See docs/adr/0002-derived-state-no-scheduler.md.
package timer

import "time"

// The band a work session may be drawn from, and the step it moves in. This is
// the technique staying recognisably the technique: a "pomodoro" of four
// minutes or four hours is not one.
const (
	MinWork  = 15 * time.Minute
	MaxWork  = 60 * time.Minute
	WorkStep = 5 * time.Minute
)

// FastElapse is how long a session takes to reach its bell when FAST_SESSIONS
// is on. Its nominal duration is recorded whole, so the bell, the ring, the
// break and the cycle are all reachable in a minute rather than two hours.
const FastElapse = 3 * time.Second

// IsWorkDuration reports whether a requested length is one the app offers.
// Checked on the server because a client that could ask for any length could
// mint focus time.
func IsWorkDuration(d time.Duration) bool {
	return d >= MinWork && d <= MaxWork && d%WorkStep == 0
}

// State is what a session is right now. It is derived, never stored: no row
// is ever flipped from one of these to the next.
type State string

const (
	// Running: the clock is counting down and the session can be cancelled.
	Running State = "running"
	// Ringing: the nominal end has passed and nobody has acknowledged it. The
	// work is already credited, which is why it can no longer be cancelled.
	Ringing State = "ringing"
	// Over: acknowledged or abandoned. Nothing derives from it any more.
	Over State = "over"
)

// StateOf derives a session's state from its facts and an instant.
//
// `ended` covers both endings — a confirmation and a cancellation — because
// from here they are the same thing: the session is no longer live.
func StateOf(endsAt time.Time, ended bool, now time.Time) State {
	switch {
	case ended:
		return Over
	case now.Before(endsAt):
		return Running
	default:
		return Ringing
	}
}

// Ends returns the instant a session's bell will ring.
//
// Under fast sessions that is seconds away while the nominal duration stays
// whole. Keeping the trick here means nothing downstream has to know about it:
// every later question is asked of `ends_at` and `duration_ms`, and neither
// can tell how it was arrived at.
func Ends(startedAt time.Time, nominal time.Duration, fast bool) time.Time {
	if fast {
		return startedAt.Add(FastElapse)
	}
	return startedAt.Add(nominal)
}

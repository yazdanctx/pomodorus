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

// The classic technique, which is what the app is until #17 puts these on the
// account: five minutes of rest, twenty after the fourth pomodoro.
const (
	DefaultShortBreak = 5 * time.Minute
	DefaultLongBreak  = 20 * time.Minute
	DefaultPerCycle   = 4
)

// IdleReset is how long a timer may sit still before the cycle it was in is
// abandoned. Four pomodoros spread across a day were never one cycle.
const IdleReset = time.Hour

// IsWorkDuration reports whether a requested length is one the app offers.
// Checked on the server because a client that could ask for any length could
// mint focus time.
func IsWorkDuration(d time.Duration) bool {
	return d >= MinWork && d <= MaxWork && d%WorkStep == 0
}

// Kind is what a session is for. Work is the only kind that is ever credited;
// the two breaks differ only in length and in what finishing one does to the
// cycle.
type Kind string

const (
	Work       Kind = "work"
	ShortBreak Kind = "shortBreak"
	LongBreak  Kind = "longBreak"
)

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

// BreakAfter is the rest owed for a pomodoro, given how many have been
// completed in the cycle it closed — itself included.
//
// The count is compared with `>=` rather than `==` so that a cycle that ran
// past its length still offers the long break: the counter only goes back to
// zero when a long break is actually finished or skipped, so somebody who
// keeps declining one is owed one every time.
func BreakAfter(completed int) (Kind, time.Duration) {
	if completed >= DefaultPerCycle {
		return LongBreak, DefaultLongBreak
	}
	return ShortBreak, DefaultShortBreak
}

// BreakDeadline is the instant a pomodoro's owed rest runs out.
//
// It is the whole of the ring-time rule in one line: the break is anchored at
// the bell, so this is fixed the moment the pomodoro ends and does not move
// however late the bell is answered. Ringing for ten seconds spends ten
// seconds of the break; ringing past this instant leaves none of it.
func BreakDeadline(bell time.Time, length time.Duration) time.Time {
	return bell.Add(length)
}

// BreakEnds is when the rest owed by a pomodoro that rang at `bell` will
// itself ring, for a break being started at `now` — and whether there is any
// of it left to start at all.
//
// Under fast sessions only the *elapse* collapses, never the deduction. The
// break still has to have survived the ring to exist, and then takes seconds
// instead of minutes — a flag that exists to make the bell, the ring, the
// break and the cycle reachable in a minute cannot be the reason the break is
// the one part of that chain nobody can reach.
func BreakEnds(bell time.Time, length time.Duration, now time.Time, fast bool) (time.Time, bool) {
	over := BreakDeadline(bell, length)
	if !over.After(now) {
		return time.Time{}, false
	}
	if fast {
		return now.Add(FastElapse), true
	}
	return over, true
}

// A Session as the cycle counter sees it: when it was meant to run, and
// whether it was abandoned. Confirmation is deliberately absent — a bell that
// was acknowledged late is the same fact as one acknowledged instantly, and
// the ring in between is idleness rather than activity.
type Session struct {
	Kind      Kind
	StartedAt time.Time
	EndsAt    time.Time
	// Zero unless the session was abandoned: a cancelled pomodoro, or a break
	// that was skipped.
	CancelledAt time.Time
}

func (s Session) abandoned() bool { return !s.CancelledAt.IsZero() }

// Cycle counts the pomodoros completed in the cycle that is current at `now`.
//
// Nothing stores this number. It is walked out of the sessions themselves, in
// order of when they started, which is what makes it agree across devices and
// survive a server that was restarted mid-cycle.
//
// Two things end a cycle. A long break, once it is over — taken or skipped,
// because declining the rest still closes the set. And an hour with nothing
// running, measured from a session's *nominal end* rather than from its
// confirmation, so an hour of ringing counts as the idleness it was.
//
// An abandoned pomodoro is not in the cycle and is not rest either: it counts
// for nothing at all, which is why a cancel leaves both the count and the
// idleness clock exactly where they were.
func Cycle(sessions []Session, now time.Time) int {
	count := 0
	// The last thing that happened: a nominal end, or the moment a break was
	// skipped. Never a confirmation.
	var last time.Time
	live := false

	for _, s := range sessions {
		if s.abandoned() && s.Kind == Work {
			continue
		}
		over := !s.EndsAt.After(now)

		switch {
		case s.Kind == Work:
			// Checked on the way in, because an hour of doing nothing is only
			// visible from the far side of it.
			if count > 0 && !last.IsZero() && s.StartedAt.Sub(last) > IdleReset {
				count = 0
			}
			if !over {
				live = true
				continue
			}
			count++
			last = s.EndsAt

		case s.abandoned(): // a skipped break
			if s.Kind == LongBreak {
				count = 0
			}
			last = s.CancelledAt

		case over:
			// The cycle closes when the long break is over, not when somebody
			// gets round to acknowledging it.
			if s.Kind == LongBreak {
				count = 0
			}
			last = s.EndsAt

		default:
			live = true
		}
	}

	// And the idleness that is still running: a cycle abandoned an hour ago is
	// abandoned now, whether or not anything has been started since.
	if !live && count > 0 && !last.IsZero() && now.Sub(last) > IdleReset {
		count = 0
	}
	return count
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

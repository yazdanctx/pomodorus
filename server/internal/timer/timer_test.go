package timer_test

import (
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/timer"
)

func TestIsWorkDuration(t *testing.T) {
	tests := []struct {
		name  string
		given time.Duration
		want  bool
	}{
		{"the shortest the app offers", 15 * time.Minute, true},
		{"the default", 25 * time.Minute, true},
		{"the longest", 60 * time.Minute, true},
		{"a step below the shortest", 10 * time.Minute, false},
		{"a step above the longest", 65 * time.Minute, false},
		{"off the five-minute step", 26 * time.Minute, false},
		{"a second off the step", 25*time.Minute + time.Second, false},
		{"nothing at all", 0, false},
		{"backwards", -25 * time.Minute, false},
		// The reason this is checked on the server at all: a hand-edited ten
		// hour "pomodoro" is focus time minted out of nothing.
		{"a working day", 10 * time.Hour, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := timer.IsWorkDuration(tc.given); got != tc.want {
				t.Errorf("IsWorkDuration(%v) = %v, want %v", tc.given, got, tc.want)
			}
		})
	}
}

func TestEveryOfferedLengthIsAccepted(t *testing.T) {
	// The stepper walks this exact set, so nothing it can produce may be
	// refused by the server it is talking to.
	for d := timer.MinWork; d <= timer.MaxWork; d += timer.WorkStep {
		if !timer.IsWorkDuration(d) {
			t.Errorf("the stepper offers %v and the server refuses it", d)
		}
	}
}

func TestStateOf(t *testing.T) {
	start := time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC)
	ends := start.Add(25 * time.Minute)

	tests := []struct {
		name  string
		now   time.Time
		ended bool
		want  timer.State
	}{
		{"the instant it starts", start, false, timer.Running},
		{"midway", start.Add(12 * time.Minute), false, timer.Running},
		// The boundary belongs to the ring: at its nominal end the work is
		// done, and a session that were still running there could be cancelled
		// after being credited.
		{"a moment before the end", ends.Add(-time.Millisecond), false, timer.Running},
		{"at the end", ends, false, timer.Ringing},
		{"long after the end", ends.Add(3 * time.Hour), false, timer.Ringing},
		{"acknowledged", ends.Add(time.Minute), true, timer.Over},
		// Cancelling happens before the end, and ends it there and then.
		{"abandoned midway", start.Add(time.Minute), true, timer.Over},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := timer.StateOf(ends, tc.ended, tc.now); got != tc.want {
				t.Errorf("StateOf() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestBreakAfter(t *testing.T) {
	tests := []struct {
		name      string
		completed int
		wantKind  timer.Kind
		wantLen   time.Duration
	}{
		{"the first of the cycle", 1, timer.ShortBreak, timer.DefaultShortBreak},
		{"the one before last", 3, timer.ShortBreak, timer.DefaultShortBreak},
		{"the one that closes the cycle", 4, timer.LongBreak, timer.DefaultLongBreak},
		// Somebody who keeps declining the long break is owed it every time:
		// the counter only goes back to zero once one is actually over.
		{"a cycle that ran past its length", 7, timer.LongBreak, timer.DefaultLongBreak},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			kind, length := timer.BreakAfter(tc.completed)
			if kind != tc.wantKind || length != tc.wantLen {
				t.Errorf("BreakAfter(%d) = %v/%v, want %v/%v",
					tc.completed, kind, length, tc.wantKind, tc.wantLen)
			}
		})
	}
}

func TestBreakEnds(t *testing.T) {
	// The whole of the ring-time rule, and the only arithmetic behind it: the
	// break ends a fixed distance from the bell, so every second of ringing is
	// a second of it already spent.
	bell := time.Date(2026, 3, 15, 9, 25, 0, 0, time.UTC)

	tests := []struct {
		name   string
		length time.Duration
		rang   time.Duration
		want   time.Duration // what is left of the break, zero for none at all
	}{
		{"acknowledged the instant it rang", timer.DefaultShortBreak, 0, 5 * time.Minute},
		{"ten seconds late", timer.DefaultShortBreak, 10 * time.Second, 4*time.Minute + 50*time.Second},
		{"a millisecond before the short break is gone", timer.DefaultShortBreak, 5*time.Minute - time.Millisecond, time.Millisecond},
		// The boundary belongs to idleness: a break of exactly nothing is no
		// break, and confirming drops straight back to the start screen.
		{"exactly as long as the short break", timer.DefaultShortBreak, 5 * time.Minute, 0},
		{"long past the short break", timer.DefaultShortBreak, time.Hour, 0},

		// The long one is the same arithmetic over a longer number, which is
		// the point of it being one function: a ring that would have eaten a
		// short break outright leaves a quarter of an hour of this one.
		{"five minutes into the long break", timer.DefaultLongBreak, 5 * time.Minute, 15 * time.Minute},
		{"a millisecond before the long break is gone", timer.DefaultLongBreak, 20*time.Minute - time.Millisecond, time.Millisecond},
		{"exactly as long as the long break", timer.DefaultLongBreak, 20 * time.Minute, 0},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			now := bell.Add(tc.rang)
			over := bell.Add(tc.length)

			ends, left := timer.BreakEnds(bell, tc.length, now, false)
			if left != (tc.want > 0) {
				t.Fatalf("any break left = %v, want %v", left, tc.want > 0)
			}
			if left && ends.Sub(now) != tc.want {
				t.Errorf("%v of break left, want %v", ends.Sub(now), tc.want)
			}
			// Whatever the ring did, the end itself never moved: it was fixed
			// when the bell rang, before anybody was late.
			if left && !ends.Equal(over) {
				t.Errorf("the break ends at %v, want %v", ends, over)
			}
		})
	}
}

func TestAFastBreakStillHasToSurviveTheRing(t *testing.T) {
	bell := time.Date(2026, 3, 15, 9, 25, 0, 0, time.UTC)

	// Under fast sessions only the elapse collapses. The deduction is still
	// measured on the nominal scale, or the flag that exists to make the whole
	// chain reachable in a minute would make the break unreachable: nobody
	// answers a bell in three seconds.
	ends, left := timer.BreakEnds(bell, timer.DefaultShortBreak, bell.Add(time.Minute), true)
	if !left {
		t.Fatal("a minute of ringing ate a five-minute break")
	}
	if want := bell.Add(time.Minute + timer.FastElapse); !ends.Equal(want) {
		t.Errorf("the fast break ends at %v, want %v", ends, want)
	}

	// And a ring that outlasts the nominal break leaves nothing, fast or not.
	if _, left := timer.BreakEnds(bell, timer.DefaultShortBreak, bell.Add(6*time.Minute), true); left {
		t.Error("six minutes of ringing still bought a break")
	}
}

// The cycle counter, as a walk over what somebody's day actually contained.
func TestCycle(t *testing.T) {
	origin := time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC)
	at := func(d time.Duration) time.Time { return origin.Add(d) }

	// A pomodoro of the given length, starting at `from`.
	work := func(from time.Duration, length time.Duration) timer.Session {
		return timer.Session{
			Kind: timer.Work, StartedAt: at(from), EndsAt: at(from + length),
		}
	}
	rest := func(kind timer.Kind, from, length time.Duration) timer.Session {
		return timer.Session{Kind: kind, StartedAt: at(from), EndsAt: at(from + length)}
	}
	cancelled := func(s timer.Session, when time.Duration) timer.Session {
		s.CancelledAt = at(when)
		return s
	}

	// One turn of the classic cycle: 25 of work, then 5 of rest, four times.
	classic := []timer.Session{
		work(0, 25*time.Minute),
		rest(timer.ShortBreak, 25*time.Minute, 5*time.Minute),
		work(30*time.Minute, 25*time.Minute),
		rest(timer.ShortBreak, 55*time.Minute, 5*time.Minute),
		work(60*time.Minute, 25*time.Minute),
		rest(timer.ShortBreak, 85*time.Minute, 5*time.Minute),
		work(90*time.Minute, 25*time.Minute),
	}

	tests := []struct {
		name     string
		sessions []timer.Session
		now      time.Duration
		want     int
	}{
		{"a fresh account", nil, 0, 0},
		{"midway through the first pomodoro", classic[:1], 10 * time.Minute, 0},
		// The boundary belongs to the bell: work is credited at its nominal
		// end, not when somebody acknowledges it.
		{"the instant the first bell rings", classic[:1], 25 * time.Minute, 1},
		{"still ringing an unconfirmed first", classic[:1], 26 * time.Minute, 1},
		{"through the break that followed", classic[:2], 32 * time.Minute, 1},
		{"the fourth pomodoro, mid-flight", classic, 100 * time.Minute, 3},
		{"the fourth pomodoro, done", classic, 115 * time.Minute, 4},

		// An abandoned pomodoro counts for nothing — not towards the cycle,
		// and not as the rest that would keep the cycle alive either.
		{
			"a cancelled pomodoro",
			[]timer.Session{cancelled(work(0, 25*time.Minute), 10*time.Minute)},
			25 * time.Minute, 0,
		},
		{
			"a cancelled pomodoro in the middle of a cycle",
			[]timer.Session{
				work(0, 25*time.Minute),
				cancelled(work(30*time.Minute, 25*time.Minute), 35*time.Minute),
				work(40*time.Minute, 25*time.Minute),
			},
			65 * time.Minute, 2,
		},

		// The long break closes the cycle when it is over, taken or skipped.
		{
			"the long break, still running",
			append(classic[:7:7], rest(timer.LongBreak, 115*time.Minute, 20*time.Minute)),
			120 * time.Minute, 4,
		},
		{
			"the long break, finished",
			append(classic[:7:7], rest(timer.LongBreak, 115*time.Minute, 20*time.Minute)),
			135 * time.Minute, 0,
		},
		{
			"the long break, skipped",
			append(classic[:7:7],
				cancelled(rest(timer.LongBreak, 115*time.Minute, 20*time.Minute), 116*time.Minute)),
			120 * time.Minute, 0,
		},
		// A skipped short break is just a short break: it closes nothing.
		{
			"a short break, skipped",
			[]timer.Session{
				work(0, 25*time.Minute),
				cancelled(rest(timer.ShortBreak, 25*time.Minute, 5*time.Minute), 26*time.Minute),
			},
			27 * time.Minute, 1,
		},

		// An hour of nothing abandons the cycle, wherever the hour falls.
		{
			"an hour of doing nothing, then another pomodoro",
			[]timer.Session{
				work(0, 25*time.Minute),
				work(90*time.Minute, 25*time.Minute),
			},
			115 * time.Minute, 1,
		},
		{
			"fifty-nine minutes of doing nothing",
			[]timer.Session{
				work(0, 25*time.Minute),
				work(84*time.Minute, 25*time.Minute),
			},
			109 * time.Minute, 2,
		},
		{
			"an hour of doing nothing, and nothing started since",
			[]timer.Session{work(0, 25*time.Minute)},
			90 * time.Minute, 0,
		},
		// Measured from the nominal end, never from the confirmation — so an
		// hour of ringing is exactly the hour of idleness it was.
		{
			"an hour of ringing",
			[]timer.Session{work(0, 25*time.Minute), work(30*time.Minute, 25*time.Minute)},
			2 * time.Hour, 0,
		},
		// A long session is not idleness: the clock is running the whole time.
		{
			"a running session past the hour mark",
			[]timer.Session{work(0, 25*time.Minute), work(30*time.Minute, 60*time.Minute)},
			89 * time.Minute, 1,
		},
		// Nor is a running break.
		{
			"a break that outlasts the idle window",
			[]timer.Session{
				work(0, 25*time.Minute),
				rest(timer.ShortBreak, 25*time.Minute, 90*time.Minute),
			},
			110 * time.Minute, 1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := timer.Cycle(tc.sessions, at(tc.now)); got != tc.want {
				t.Errorf("Cycle() = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestEnds(t *testing.T) {
	start := time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC)

	if got := timer.Ends(start, 25*time.Minute, false); !got.Equal(start.Add(25 * time.Minute)) {
		t.Errorf("Ends() = %v, want the nominal end", got)
	}

	// A fast session reaches its bell in seconds. Its nominal duration is not
	// this function's business and is recorded whole elsewhere — which is the
	// whole point of keeping the two apart.
	if got := timer.Ends(start, 25*time.Minute, true); !got.Equal(start.Add(timer.FastElapse)) {
		t.Errorf("Ends() = %v, want seconds away", got)
	}
}

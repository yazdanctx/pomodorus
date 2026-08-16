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

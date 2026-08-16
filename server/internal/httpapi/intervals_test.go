package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// setIntervals sends all three, which is the only shape the endpoint takes, and
// returns the timer state it answers with.
func setIntervals(t *testing.T, c *apitest.Client, shortBreak, longBreak time.Duration, perCycle int) sessionPayload {
	t.Helper()
	return payload(t, c.POST("/api/intervals", map[string]any{
		"shortBreakMs": shortBreak.Milliseconds(),
		"longBreakMs":  longBreak.Milliseconds(),
		"perCycle":     perCycle,
	}))
}

func TestAFreshAccountIsTheClassicTechnique(t *testing.T) {
	h := apitest.New(t)
	client, _ := working(t, h)

	got := liveSession(t, client).Intervals
	if got.ShortBreakMs != shortBreak.Milliseconds() ||
		got.LongBreakMs != longBreak.Milliseconds() ||
		got.PerCycle != 4 {
		t.Errorf("a fresh account is %+v, want 5/20 and a cycle of four", got)
	}
}

func TestEditedIntervalsReachEveryDevice(t *testing.T) {
	h := apitest.New(t)
	client, _ := working(t, h)

	// A second browser, same account. This is the whole reason the intervals
	// are on the account rather than on the device: the timer belongs to the
	// person, so what a break is worth has to as well.
	other := h.NewClient()
	other.CopyCookiesFrom(client)

	answered := setIntervals(t, client, 3*time.Minute, 35*time.Minute, 2).Intervals
	if answered.ShortBreakMs != (3*time.Minute).Milliseconds() || answered.PerCycle != 2 {
		t.Fatalf("the edit answered with %+v", answered)
	}

	got := liveSession(t, other).Intervals
	if got != answered {
		t.Errorf("the other device reads %+v, want %+v", got, answered)
	}
}

func TestIntervalsOutsideTheirBandAreRefused(t *testing.T) {
	tests := []struct {
		name                  string
		shortBreak, longBreak time.Duration
		perCycle              int
	}{
		{"a short break under its band", 2 * time.Minute, 20 * time.Minute, 4},
		{"a short break over its band", 16 * time.Minute, 20 * time.Minute, 4},
		{"a short break off the minute", 5*time.Minute + time.Second, 20 * time.Minute, 4},
		{"a long break under its band", 5 * time.Minute, 5 * time.Minute, 4},
		{"a long break over its band", 5 * time.Minute, 40 * time.Minute, 4},
		{"a long break off the five-minute step", 5 * time.Minute, 22 * time.Minute, 4},
		// The reason any of this is checked on the server: a hand-rolled
		// request is the one client that never walked a stepper.
		{"an afternoon of rest", 5 * time.Minute, 4 * time.Hour, 4},
		{"a cycle of one", 5 * time.Minute, 20 * time.Minute, 1},
		{"a cycle of none", 5 * time.Minute, 20 * time.Minute, 0},
		{"a cycle past its band", 5 * time.Minute, 20 * time.Minute, 7},
	}

	h := apitest.New(t)
	client, _ := working(t, h)

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client.POST("/api/intervals", map[string]any{
				"shortBreakMs": tc.shortBreak.Milliseconds(),
				"longBreakMs":  tc.longBreak.Milliseconds(),
				"perCycle":     tc.perCycle,
			}).ExpectError(http.StatusBadRequest, "bad_interval")

			// Refused whole: a rejected request leaves the account exactly as
			// it was, rather than landing the fields that happened to be legal.
			got := liveSession(t, client).Intervals
			if got.ShortBreakMs != shortBreak.Milliseconds() ||
				got.LongBreakMs != longBreak.Milliseconds() ||
				got.PerCycle != 4 {
				t.Errorf("the refused edit still moved the account to %+v", got)
			}
		})
	}
}

func TestTheIntervalsBelongToTheAccountThatSetThem(t *testing.T) {
	h := apitest.New(t)
	mine, _ := working(t, h)
	theirs := h.SignIn("someone@example.com")

	setIntervals(t, mine, 3*time.Minute, 35*time.Minute, 2)

	if got := liveSession(t, theirs).Intervals; got.PerCycle != 4 ||
		got.ShortBreakMs != shortBreak.Milliseconds() {
		t.Errorf("somebody else's account moved to %+v", got)
	}
}

func TestSettingIntervalsRequiresBeingSignedIn(t *testing.T) {
	h := apitest.New(t)
	h.NewClient().POST("/api/intervals", map[string]any{
		"shortBreakMs": (3 * time.Minute).Milliseconds(),
		"longBreakMs":  (35 * time.Minute).Milliseconds(),
		"perCycle":     2,
	}).ExpectError(http.StatusUnauthorized, "not_signed_in")
}

func TestANewShortBreakGovernsTheNextPomodoro(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	setIntervals(t, client, 12*time.Minute, longBreak, 4)

	live := payload(t, start(client, category, pomodoro)).Session
	// Known before the bell, because the deadline it is heading for is twelve
	// minutes past that bell rather than five.
	if want := live.EndsAt + (12 * time.Minute).Milliseconds(); live.BreakEndsAt == nil || *live.BreakEndsAt != want {
		t.Fatalf("breakEndsAt is %v, want %d", live.BreakEndsAt, want)
	}

	h.Clock.Advance(25 * time.Minute)
	rest := confirm(t, client, live.ID).Session
	if rest.DurationMs != (12 * time.Minute).Milliseconds() {
		t.Errorf("the break is %d long, want the twelve minutes the account asks for", rest.DurationMs)
	}
}

func TestEditingMidSessionDoesNotChangeTheBreakItOwes(t *testing.T) {
	// A session is a stored fact, and the rest it owes is part of that fact.
	// The two halves of the edit are made at the two moments that could
	// plausibly change it — while the pomodoro runs, and while its bell rings.
	tests := []struct {
		name string
		// how long after the pomodoro started the dialog is opened, and how
		// long after its bell it is acknowledged
		edited, confirmed time.Duration
	}{
		{"edited mid-session", 10 * time.Minute, 0},
		{"edited mid-ring", 25*time.Minute + time.Minute, time.Minute},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := apitest.New(t)
			client, category := working(t, h)
			live := payload(t, start(client, category, pomodoro)).Session

			h.Clock.Advance(tc.edited)
			edited := setIntervals(t, client, 15*time.Minute, 35*time.Minute, 4)

			// The deadline this pomodoro is heading for did not move, so the
			// button that says whether confirming still buys a break is still
			// telling the truth.
			if edited.Session.BreakEndsAt == nil || *edited.Session.BreakEndsAt != *live.BreakEndsAt {
				t.Errorf("breakEndsAt moved to %v, want the %d it owed", edited.Session.BreakEndsAt, *live.BreakEndsAt)
			}

			h.Clock.Set(time.UnixMilli(live.EndsAt).UTC().Add(tc.confirmed))
			rest := confirm(t, client, live.ID).Session
			if rest.DurationMs != shortBreak.Milliseconds() {
				t.Errorf("the break is %d long, want the five minutes it earned", rest.DurationMs)
			}
			if want := live.EndsAt + shortBreak.Milliseconds(); rest.EndsAt != want {
				t.Errorf("the break ends at %d, want %d", rest.EndsAt, want)
			}
		})
	}
}

func TestAShorterCycleAppliesToTheVeryNextCompletion(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	// One pomodoro of four done, and its short break out of the way.
	first := pomodoroAndBreak(t, h, client, category, 0)
	if first.Session.Kind != "shortBreak" {
		t.Fatalf("the first pomodoro earned a %s", first.Session.Kind)
	}
	confirm(t, client, first.Session.ID)

	// The cycle is now two long, and the pomodoro about to be started is the
	// second: unlike the break lengths, this is read at completion, so it
	// applies to the very next one.
	setIntervals(t, client, shortBreak, longBreak, 2)

	live := payload(t, start(client, category, pomodoro)).Session
	if want := live.EndsAt + longBreak.Milliseconds(); live.BreakEndsAt == nil || *live.BreakEndsAt != want {
		t.Fatalf("breakEndsAt is %v, want the long break at %d", live.BreakEndsAt, want)
	}

	h.Clock.Advance(25 * time.Minute)
	rest := confirm(t, client, live.ID)
	if rest.Session.Kind != "longBreak" {
		t.Errorf("the second pomodoro of a two-pomodoro cycle earned a %s", rest.Session.Kind)
	}
	if rest.Cycle.Count != 2 {
		t.Errorf("the cycle is at %d, want 2", rest.Cycle.Count)
	}
}

func TestShorteningTheCycleUnderARunningPomodoroMovesItsDeadline(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	first := pomodoroAndBreak(t, h, client, category, 0)
	confirm(t, client, first.Session.ID)

	live := payload(t, start(client, category, pomodoro)).Session
	if want := live.EndsAt + shortBreak.Milliseconds(); *live.BreakEndsAt != want {
		t.Fatalf("the second of four is heading for %d, want the short break at %d", *live.BreakEndsAt, want)
	}

	// Shortening the cycle while it runs makes this pomodoro the one that
	// closes the set — the count is not the session's to keep, and the screen
	// says so straight away.
	edited := setIntervals(t, client, shortBreak, longBreak, 2)
	if want := live.EndsAt + longBreak.Milliseconds(); *edited.Session.BreakEndsAt != want {
		t.Errorf("breakEndsAt is %d, want the long break at %d", *edited.Session.BreakEndsAt, want)
	}
}

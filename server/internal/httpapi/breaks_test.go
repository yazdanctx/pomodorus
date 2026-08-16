package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

const (
	shortBreak = 5 * time.Minute
	longBreak  = 20 * time.Minute
)

// confirm acknowledges a bell and returns whatever the timer became: the break
// that survived the ring, or nothing.
func confirm(t *testing.T, c *apitest.Client, id string) sessionPayload {
	t.Helper()
	return payload(t, c.POST("/api/session/"+id+"/confirm", nil))
}

// pomodoroAndBreak runs one whole turn: a pomodoro to its bell, acknowledged
// `late` after it, and then the break it earned to *its* bell. It returns the
// state at the break's bell, which is where the next decision is made.
func pomodoroAndBreak(t *testing.T, h *apitest.Harness, c *apitest.Client, category string, late time.Duration) sessionPayload {
	t.Helper()
	live := payload(t, start(c, category, pomodoro)).Session
	h.Clock.Advance(25*time.Minute + late)

	rest := confirm(t, c, live.ID).Session
	if rest == nil {
		t.Fatalf("no break followed a pomodoro confirmed %v late", late)
	}
	// To the break's own bell, wherever that falls — it is anchored at the
	// pomodoro's end, so a late confirmation gets there sooner.
	h.Clock.Set(time.UnixMilli(rest.EndsAt).UTC())
	return liveSession(t, c)
}

func TestConfirmingWorkStartsTheBreakItEarned(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	h.Clock.Advance(25 * time.Minute)
	rest := confirm(t, client, live.ID).Session

	if rest.Kind != "shortBreak" {
		t.Errorf("kind is %q, want shortBreak", rest.Kind)
	}
	// A break is a break: it belongs to no task.
	if rest.CategoryID != nil || rest.CategoryName != nil {
		t.Errorf("the break carries a task: %+v", rest)
	}
	if rest.DurationMs != shortBreak.Milliseconds() {
		t.Errorf("durationMs is %d, want the nominal %d", rest.DurationMs, shortBreak.Milliseconds())
	}
	// Anchored at the bell, not at the tap — which is what makes ring time
	// come out of it.
	if want := live.EndsAt; rest.StartedAt != want {
		t.Errorf("startedAt is %d, want the pomodoro's end %d", rest.StartedAt, want)
	}
	if want := live.EndsAt + shortBreak.Milliseconds(); rest.EndsAt != want {
		t.Errorf("endsAt is %d, want %d", rest.EndsAt, want)
	}
}

func TestRingTimeIsSpentOutOfTheBreak(t *testing.T) {
	tests := []struct {
		name string
		rang time.Duration
		left time.Duration
	}{
		{"acknowledged the instant it rang", 0, shortBreak},
		{"ten seconds late", 10 * time.Second, shortBreak - 10*time.Second},
		{"four minutes late", 4 * time.Minute, time.Minute},
		{"a second before the break would have been over", shortBreak - time.Second, time.Second},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := apitest.New(t)
			client, category := working(t, h)
			live := payload(t, start(client, category, pomodoro)).Session

			h.Clock.Advance(25*time.Minute + tc.rang)
			body := confirm(t, client, live.ID)
			rest := body.Session
			if rest == nil {
				t.Fatalf("ringing for %v left no break at all", tc.rang)
			}

			if got := time.Duration(rest.EndsAt-body.ServerNow) * time.Millisecond; got != tc.left {
				t.Errorf("%v of break left, want %v", got, tc.left)
			}
			// The length on the record is the whole break, whatever was left
			// of it: what was actually rested is the end minus now, and it is
			// nobody's job to store that.
			if rest.DurationMs != shortBreak.Milliseconds() {
				t.Errorf("durationMs is %d, want the nominal %d", rest.DurationMs, shortBreak.Milliseconds())
			}
		})
	}
}

func TestRingingPastTheWholeBreakLeavesNone(t *testing.T) {
	for _, rang := range []time.Duration{shortBreak, shortBreak + time.Second, 2 * time.Hour} {
		h := apitest.New(t)
		client, category := working(t, h)
		live := payload(t, start(client, category, pomodoro)).Session

		h.Clock.Advance(25*time.Minute + rang)
		// Rung through the whole of it: there is nothing left to start, so
		// acknowledging drops straight back to the start screen.
		if got := confirm(t, client, live.ID).Session; got != nil {
			t.Errorf("ringing for %v still bought a break: %+v", rang, got)
		}
		if got := liveSession(t, client); got.Session != nil {
			t.Errorf("ringing for %v left something live: %+v", rang, got.Session)
		}
	}
}

func TestARingingPomodoroSaysWhatConfirmingWillBuy(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// The answer is one instant, sent once: the client compares it with the
	// clock and the button's label follows the ring second by second, without
	// asking again.
	if want := live.EndsAt + shortBreak.Milliseconds(); live.BreakEndsAt == nil || *live.BreakEndsAt != want {
		t.Fatalf("breakEndsAt is %v, want %d", live.BreakEndsAt, want)
	}

	// And it does not move while the bell rings: the break was anchored at the
	// nominal end before anybody was late.
	h.Clock.Advance(25*time.Minute + 3*time.Minute)
	ringing := liveSession(t, client).Session
	if *ringing.BreakEndsAt != *live.BreakEndsAt {
		t.Errorf("breakEndsAt moved to %d during the ring", *ringing.BreakEndsAt)
	}

	// A break owes no break of its own.
	rest := confirm(t, client, live.ID).Session
	if rest.BreakEndsAt != nil {
		t.Errorf("the break owes a break: %+v", rest)
	}
}

func TestABreakCarriesWhatAnotherOneWouldResume(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, 30*60*1000)).Session
	h.Clock.Advance(30 * time.Minute)
	rest := confirm(t, client, live.ID).Session

	// Read off the pomodoro rather than left to the device: a second device
	// that opens into this break has never picked anything, and "another one"
	// has to mean the same task at the same length there too.
	if rest.ResumeCategoryID == nil || *rest.ResumeCategoryID != category {
		t.Errorf("resumeCategoryId is %v, want %s", rest.ResumeCategoryID, category)
	}
	if rest.ResumeDurationMs == nil || *rest.ResumeDurationMs != 30*60*1000 {
		t.Errorf("resumeDurationMs is %v, want the thirty minutes it ran", rest.ResumeDurationMs)
	}

	// A pomodoro resumes nothing: it is the thing being done.
	if live.ResumeCategoryID != nil || live.ResumeDurationMs != nil {
		t.Errorf("a pomodoro carries a resume hint: %+v", live)
	}
}

func TestARunningBreakCanBeSkipped(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(25 * time.Minute)
	rest := confirm(t, client, live.ID).Session

	h.Clock.Advance(time.Minute)
	body := payload(t, client.POST("/api/session/"+rest.ID+"/cancel", nil))
	if body.Session != nil {
		t.Errorf("skipping the break left something live: %+v", body.Session)
	}

	// Straight back to work, with no bell to acknowledge first.
	next := payload(t, start(client, category, pomodoro)).Session
	if next.Kind != "work" {
		t.Errorf("kind is %q, want work", next.Kind)
	}
}

func TestConfirmingABreakStartsNothing(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	body := pomodoroAndBreak(t, h, client, category, 0)

	// Whether to go round again is the technique's own fork, and it is asked
	// as two buttons on the client rather than answered here.
	rest := body.Session
	if rest == nil || rest.Kind != "shortBreak" {
		t.Fatalf("the break is not ringing: %+v", rest)
	}
	if got := confirm(t, client, rest.ID).Session; got != nil {
		t.Errorf("acknowledging a break started something: %+v", got)
	}
}

func TestTheCycleCountsPomodorosAndPlacesTheLongBreak(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	if got := liveSession(t, client); got.Cycle.Count != 0 || got.Intervals.PerCycle != 4 {
		t.Fatalf("a fresh account is at %d of %d, want 0 of 4", got.Cycle.Count, got.Intervals.PerCycle)
	}

	// Three turns of work and rest, each earning the short break.
	for i := 1; i <= 3; i++ {
		body := pomodoroAndBreak(t, h, client, category, 0)
		if body.Session.Kind != "shortBreak" {
			t.Fatalf("pomodoro %d earned a %s", i, body.Session.Kind)
		}
		if body.Cycle.Count != i {
			t.Fatalf("after pomodoro %d the cycle is at %d", i, body.Cycle.Count)
		}
		confirm(t, client, body.Session.ID)
	}

	// The fourth closes the cycle, and the rest it earns is the long one —
	// which it knows before its own bell, because the deadline it is running
	// towards is twenty minutes past that bell rather than five.
	live := payload(t, start(client, category, pomodoro)).Session
	if want := live.EndsAt + longBreak.Milliseconds(); live.BreakEndsAt == nil || *live.BreakEndsAt != want {
		t.Fatalf("the fourth pomodoro's break runs out at %v, want %d", live.BreakEndsAt, want)
	}
	h.Clock.Advance(25 * time.Minute)

	rest := confirm(t, client, live.ID)
	if rest.Session.Kind != "longBreak" {
		t.Fatalf("the fourth pomodoro earned a %s", rest.Session.Kind)
	}
	if want := live.EndsAt + longBreak.Milliseconds(); rest.Session.EndsAt != want {
		t.Errorf("the long break ends at %d, want %d", rest.Session.EndsAt, want)
	}
	// It is still the fourth of four until the long break is over: the counter
	// closes with the rest, not with the work.
	if rest.Cycle.Count != 4 {
		t.Errorf("the cycle is at %d during the long break, want 4", rest.Cycle.Count)
	}
}

func TestTheCycleResetsAfterTheLongBreakTakenOrSkipped(t *testing.T) {
	tests := []struct {
		name string
		// what the user does with the long break once it is running
		end func(t *testing.T, h *apitest.Harness, c *apitest.Client, id string, endsAt int64)
	}{
		{
			"taken to its end",
			func(t *testing.T, h *apitest.Harness, c *apitest.Client, id string, endsAt int64) {
				h.Clock.Set(time.UnixMilli(endsAt).UTC())
				confirm(t, c, id)
			},
		},
		{
			// Declining the rest still closes the set: what the counter is for
			// is placing the long break, and one has now been placed.
			"skipped a minute in",
			func(t *testing.T, h *apitest.Harness, c *apitest.Client, id string, _ int64) {
				h.Clock.Advance(time.Minute)
				c.POST("/api/session/"+id+"/cancel", nil).ExpectStatus(http.StatusOK)
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := apitest.New(t)
			client, category := working(t, h)

			for i := 1; i <= 3; i++ {
				body := pomodoroAndBreak(t, h, client, category, 0)
				confirm(t, client, body.Session.ID)
			}
			live := payload(t, start(client, category, pomodoro)).Session
			h.Clock.Advance(25 * time.Minute)
			long := confirm(t, client, live.ID).Session
			if long.Kind != "longBreak" {
				t.Fatalf("the fourth pomodoro earned a %s", long.Kind)
			}

			tc.end(t, h, client, long.ID, long.EndsAt)

			if got := liveSession(t, client); got.Cycle.Count != 0 {
				t.Errorf("the cycle is at %d after the long break, want 0", got.Cycle.Count)
			}
			// And the next pomodoro is the first of a new set, so the rest it
			// earns is the short one again.
			next := payload(t, start(client, category, pomodoro)).Session
			if want := next.EndsAt + shortBreak.Milliseconds(); next.BreakEndsAt == nil || *next.BreakEndsAt != want {
				t.Errorf("the next pomodoro's break runs out at %v, want %d", next.BreakEndsAt, want)
			}
		})
	}
}

func TestTheCycleResetsAfterAnHourOfIdleness(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	// One pomodoro and the break it earned, left ringing at the break's own
	// nominal end — which is the last thing that happened.
	body := pomodoroAndBreak(t, h, client, category, 0)
	if body.Cycle.Count != 1 {
		t.Fatalf("the cycle is at %d after one pomodoro, want 1", body.Cycle.Count)
	}
	breakEnded := time.UnixMilli(body.Session.EndsAt).UTC()

	// Fifty-nine minutes later is still the same stretch of work.
	h.Clock.Set(breakEnded.Add(59 * time.Minute))
	if got := liveSession(t, client); got.Cycle.Count != 1 {
		t.Errorf("the cycle is at %d after 59 minutes, want 1", got.Cycle.Count)
	}

	// An hour is not. Four pomodoros spread across a day were never one cycle.
	h.Clock.Advance(2 * time.Minute)
	if got := liveSession(t, client); got.Cycle.Count != 0 {
		t.Errorf("the cycle is at %d after an hour, want 0", got.Cycle.Count)
	}
}

func TestALongRingCountsAsTheIdlenessItWas(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	live := payload(t, start(client, category, pomodoro)).Session
	// Measured from the nominal end, never from the confirmation: an hour of
	// ringing is an hour of not working, whatever the row says about when the
	// bell was finally acknowledged.
	h.Clock.Advance(25*time.Minute + 61*time.Minute)
	if got := confirm(t, client, live.ID); got.Cycle.Count != 0 {
		t.Errorf("the cycle is at %d after an hour of ringing, want 0", got.Cycle.Count)
	}
}

func TestAnAbandonedPomodoroIsNotInTheCycle(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(10 * time.Minute)
	body := payload(t, client.POST("/api/session/"+live.ID+"/cancel", nil))

	// Not credited, not counted: abandoning a pomodoro cannot earn a break,
	// nor bring the long one any closer.
	if body.Cycle.Count != 0 {
		t.Errorf("the cycle is at %d after a cancel, want 0", body.Cycle.Count)
	}
}

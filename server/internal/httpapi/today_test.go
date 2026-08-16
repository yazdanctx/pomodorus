package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// The first Tehran midnight after the harness clock's origin, written out
// rather than computed.
//
// Tehran runs +03:30, so its midnight falls at 20:30 UTC the calendar day
// before — and the origin, 09:00 UTC on the 15th, is half past noon there.
// Deriving this from the code under test would be a boundary that moves
// whenever the implementation does, which is a test that agrees with a bug.
var tehranMidnight = time.Date(2026, 3, 15, 20, 30, 0, 0, time.UTC)

// Today's focus is a query over credited work, never a counter. These tests
// are about the two edges that makes interesting: when work is credited, and
// where a day begins.

func today(t *testing.T, c *apitest.Client) (int, int64) {
	t.Helper()
	body := liveSession(t, c)
	return body.Today.Count, body.Today.TotalMs
}

// A pomodoro seen all the way through: run it out, and the day has it.
func finish(t *testing.T, h *apitest.Harness, c *apitest.Client, category string, length time.Duration) {
	t.Helper()
	started := payload(t, start(c, category, length.Milliseconds())).Session
	h.Clock.Advance(length + time.Minute)
	c.POST("/api/session/"+started.ID+"/confirm", nil).ExpectStatus(http.StatusOK)
	// Out of the break, so the next pomodoro can begin.
	if rest := liveSession(t, c).Session; rest != nil {
		c.POST("/api/session/"+rest.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
	}
}

func TestTheDayStartsEmpty(t *testing.T) {
	h := apitest.New(t)
	client, _ := working(t, h)

	count, total := today(t, client)
	if count != 0 || total != 0 {
		t.Errorf("a fresh day reads %d pomodoros and %dms, want nothing", count, total)
	}
}

func TestTheDayCountsCreditedWork(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	finish(t, h, client, category, 25*time.Minute)
	finish(t, h, client, category, 30*time.Minute)

	count, total := today(t, client)
	if count != 2 {
		t.Errorf("count is %d, want 2", count)
	}
	if want := (55 * time.Minute).Milliseconds(); total != want {
		t.Errorf("total is %dms, want %dms", total, want)
	}
}

// The criterion this ticket turns on: the bell credits the work, and the tap
// that acknowledges it moves nothing.
func TestWorkIsCreditedAtTheBellAndNotAtConfirmation(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	started := payload(t, start(client, category, pomodoro)).Session

	// Still running: nothing owed yet.
	if count, _ := today(t, client); count != 0 {
		t.Fatalf("a running pomodoro was already counted (%d)", count)
	}

	// The bell, and nobody has touched it. The work is already in the day.
	h.Clock.Advance(26 * time.Minute)
	count, total := today(t, client)
	if count != 1 {
		t.Errorf("a ringing pomodoro counts %d, want 1 — work is credited at its bell", count)
	}
	if total != pomodoro {
		t.Errorf("total is %dms, want %dms", total, pomodoro)
	}

	// An hour of ringing, then the tap. It records the same day it would have
	// recorded a second after the bell.
	h.Clock.Advance(time.Hour)
	client.POST("/api/session/"+started.ID+"/confirm", nil).ExpectStatus(http.StatusOK)

	if count, after := today(t, client); count != 1 || after != total {
		t.Errorf("confirming changed the day to %d/%dms, want %d/%dms", count, after, 1, total)
	}
}

func TestAbandonedWorkIsNotCredited(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	started := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(10 * time.Minute)
	client.POST("/api/session/"+started.ID+"/cancel", nil).ExpectStatus(http.StatusOK)

	// Past where its bell would have been, so a query that forgot the cancel
	// would now be wrong.
	h.Clock.Advance(30 * time.Minute)
	if count, total := today(t, client); count != 0 || total != 0 {
		t.Errorf("an abandoned pomodoro was credited: %d/%dms", count, total)
	}
}

func TestRestIsNotFocusTime(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	// One pomodoro, then let its break run all the way out.
	finished := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(26 * time.Minute)
	client.POST("/api/session/"+finished.ID+"/confirm", nil).ExpectStatus(http.StatusOK)
	h.Clock.Advance(10 * time.Minute)

	// The break has rung. Only the pomodoro is in the total.
	count, total := today(t, client)
	if count != 1 || total != pomodoro {
		t.Errorf("the day reads %d/%dms, want 1/%dms — a break is not focus time", count, total, pomodoro)
	}
}

func TestTheDayIsPerAccount(t *testing.T) {
	h := apitest.New(t)
	mine, category := working(t, h)
	finish(t, h, mine, category, 25*time.Minute)

	stranger := h.SignIn("someone@else.example")
	claim(stranger, "someone").ExpectStatus(http.StatusOK)
	theirCategory := createdCategory(t, createCategory(stranger, "کار", true)).ID
	finish(t, h, stranger, theirCategory, 25*time.Minute)

	// Two people, one pomodoro each — not two each.
	if count, _ := today(t, mine); count != 1 {
		t.Errorf("my day counts %d, want 1", count)
	}
	if count, _ := today(t, stranger); count != 1 {
		t.Errorf("their day counts %d, want 1", count)
	}
}

// The boundary, and the reason it is worth a test at all: the server is in
// UTC, the day is Tehran's, and the two turn over three and a half hours
// apart.
func TestTheDayTurnsOverAtTehranMidnight(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	// Ten minutes before Tehran midnight. A pomodoro finished here belongs to
	// the day that is ending.
	midnight := tehranMidnight
	h.Clock.Set(midnight.Add(-40 * time.Minute))
	finish(t, h, client, category, 25*time.Minute)

	if count, _ := today(t, client); count != 1 {
		t.Fatalf("the pomodoro before midnight counts %d in its own day, want 1", count)
	}

	// A minute past midnight, Tehran. The day is new and empty, even though
	// the work is minutes old and the UTC date has not changed.
	h.Clock.Set(midnight.Add(time.Minute))
	if count, total := today(t, client); count != 0 || total != 0 {
		t.Errorf("the new Tehran day reads %d/%dms, want nothing — yesterday's work leaked in",
			count, total)
	}

	// And UTC midnight, three and a half hours later, is not a boundary: the
	// pomodoro below it stays in the day it was credited to.
	h.Clock.Set(midnight.Add(time.Minute))
	finish(t, h, client, category, 25*time.Minute)
	h.Clock.Set(midnight.Add(4 * time.Hour))
	if count, _ := today(t, client); count != 1 {
		t.Errorf("crossing UTC midnight changed the day to %d, want 1", count)
	}
}

// A pomodoro that begins before Tehran midnight and rings after it belongs to
// the day it was credited in, not the one it started in.
func TestAPomodoroIsCreditedToTheDayItsBellFallsIn(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	midnight := tehranMidnight
	// Started ten minutes before midnight, ringing twenty-five minutes later —
	// which is fifteen minutes into the new day.
	h.Clock.Set(midnight.Add(-10 * time.Minute))
	start(client, category, pomodoro).ExpectStatus(http.StatusOK)

	// Just before the bell, still in the old day and still uncounted.
	h.Clock.Set(midnight.Add(10 * time.Minute))
	if count, _ := today(t, client); count != 0 {
		t.Fatalf("a pomodoro still running was counted (%d)", count)
	}

	// The bell falls in the new day, and so does the work.
	h.Clock.Set(midnight.Add(20 * time.Minute))
	if count, total := today(t, client); count != 1 || total != pomodoro {
		t.Errorf("the new day reads %d/%dms, want 1/%dms", count, total, pomodoro)
	}
}

// It rides on the timer payload, so it reaches a second device with everything
// else rather than needing a request of its own.
func TestTodayReachesAnotherDeviceOnTheSocket(t *testing.T) {
	h := apitest.New(t)
	phone, category := working(t, h)

	laptop := device(t, h).Socket()
	frameSession(t, laptop)

	started := payload(t, start(phone, category, pomodoro)).Session
	frameSession(t, laptop) // the pomodoro starting

	h.Clock.Advance(26 * time.Minute)
	phone.POST("/api/session/"+started.ID+"/confirm", nil).ExpectStatus(http.StatusOK)

	pushed := frameSession(t, laptop)
	if pushed.Today.Count != 1 || pushed.Today.TotalMs != pomodoro {
		t.Errorf("the pushed day reads %d/%dms, want 1/%dms",
			pushed.Today.Count, pushed.Today.TotalMs, pomodoro)
	}
}

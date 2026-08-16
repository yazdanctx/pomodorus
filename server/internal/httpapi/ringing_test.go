package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// stored reads back the columns the whole record is built from, so a test can
// say what the row is rather than what the API said about it.
func stored(t *testing.T, h *apitest.Harness, id string) (endsAt time.Time, durationMs int64, confirmedAt *time.Time) {
	t.Helper()
	if err := h.DB.QueryRow(t.Context(),
		`SELECT ends_at, duration_ms, confirmed_at FROM sessions WHERE id = $1`,
		id).Scan(&endsAt, &durationMs, &confirmedAt); err != nil {
		t.Fatal(err)
	}
	return
}

func TestConfirmingIsRefusedBeforeTheBell(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// A running session is not something to acknowledge. Letting it through
	// would be a way to end a pomodoro early and be paid for it in full.
	h.Clock.Advance(25*time.Minute - time.Millisecond)
	client.POST("/api/session/"+live.ID+"/confirm", nil).
		ExpectError(http.StatusConflict, "nothing_ringing")

	if got := liveSession(t, client); got.Session == nil || got.Session.ID != live.ID {
		t.Fatalf("the running session was ended anyway: %+v", got.Session)
	}
}

func TestConfirmingAtTheBellEndsTheSession(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// The boundary belongs to the ring: at the nominal end, exactly, it is
	// already ringing and already the user's to acknowledge.
	h.Clock.Advance(25 * time.Minute)
	body := payload(t, client.POST("/api/session/"+live.ID+"/confirm", nil))

	// The pomodoro is over and the break it earned has begun — one tap, not
	// two. Nothing else advanced on its own: the break stops at its own bell.
	if body.Session == nil || body.Session.Kind != "shortBreak" {
		t.Fatalf("confirming did not start the break: %+v", body.Session)
	}
	if got := liveSession(t, client); got.Session == nil || got.Session.ID != body.Session.ID {
		t.Errorf("the break is not the live session: %+v", got.Session)
	}

	_, _, confirmedAt := stored(t, h, live.ID)
	if confirmedAt == nil {
		t.Fatal("the session was not confirmed")
	}
}

func TestWorkIsCreditedAtItsNominalEndHoweverLateItIsConfirmed(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// Two hours of ringing. The confirmation is the only column that moves;
	// what gets credited was decided when the row was written, so this records
	// exactly what confirming two seconds late would have.
	h.Clock.Advance(2 * time.Hour)
	client.POST("/api/session/"+live.ID+"/confirm", nil).ExpectStatus(http.StatusOK)

	endsAt, durationMs, confirmedAt := stored(t, h, live.ID)
	if endsAt.UnixMilli() != live.EndsAt {
		t.Errorf("ends_at moved to %d, want %d", endsAt.UnixMilli(), live.EndsAt)
	}
	if durationMs != pomodoro {
		t.Errorf("duration_ms is %d, want the nominal %d", durationMs, pomodoro)
	}
	// Ring time is not focus time: it is recorded as the acknowledgement it is
	// and never folded into the length.
	if want := apitest.Origin.Add(2 * time.Hour); !confirmedAt.Equal(want) {
		t.Errorf("confirmed_at is %v, want %v", confirmedAt, want)
	}
}

func TestARingIsNotCancellable(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	h.Clock.Advance(25 * time.Minute)
	// The session is complete and already credited; there is nothing left to
	// abandon. Only a confirmation ends it.
	client.POST("/api/session/"+live.ID+"/cancel", nil).
		ExpectError(http.StatusConflict, "not_cancellable")
	client.POST("/api/session/"+live.ID+"/confirm", nil).ExpectStatus(http.StatusOK)

	_, _, confirmedAt := stored(t, h, live.ID)
	if confirmedAt == nil {
		t.Error("the ring was not confirmed")
	}
}

func TestConfirmingTwiceChangesNothing(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(25 * time.Minute)

	rest := confirm(t, client, live.ID).Session
	first := apitest.Origin.Add(25 * time.Minute)

	// A second tap — a double click, the other device catching up, or a retry
	// of a request whose answer was lost on the way back — acknowledges
	// nothing a second time and starts no second break. It says what the timer
	// is, which is the break the first tap started.
	h.Clock.Advance(time.Minute)
	again := confirm(t, client, live.ID).Session
	if again == nil || again.ID != rest.ID {
		t.Errorf("the second tap did not land on the same break: %+v", again)
	}

	_, _, confirmedAt := stored(t, h, live.ID)
	if !confirmedAt.Equal(first) {
		t.Errorf("confirmed_at moved to %v, want %v", confirmedAt, first)
	}

	var breaks int
	if err := h.DB.QueryRow(t.Context(),
		`SELECT count(*) FROM sessions WHERE kind <> 'work'`).Scan(&breaks); err != nil {
		t.Fatal(err)
	}
	if breaks != 1 {
		t.Errorf("%d breaks exist, want the one", breaks)
	}
}

func TestConfirmingFreesTheTimerForAnother(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(25 * time.Minute)
	client.POST("/api/session/"+live.ID+"/confirm", nil).ExpectStatus(http.StatusOK)

	next := payload(t, start(client, category, pomodoro)).Session
	if next.ID == live.ID {
		t.Error("starting again returned the confirmed session")
	}
}

func TestSomebodyElsesRingIsNotTheirsToConfirm(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(25 * time.Minute)

	theirs := h.SignIn("someone@example.com")
	claim(theirs, "someone").ExpectStatus(http.StatusOK)
	theirs.POST("/api/session/"+live.ID+"/confirm", nil).
		ExpectError(http.StatusConflict, "nothing_ringing")

	if got := liveSession(t, client); got.Session == nil {
		t.Error("somebody else confirmed my ring")
	}
}

func TestARingIsAcknowledgedFromWhicheverDeviceIsAtHand(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(25 * time.Minute)

	// The timer belongs to the person: whichever device is in front of them
	// when the bell goes is the one that answers it.
	other := h.NewClient()
	other.CopyCookiesFrom(client)
	other.POST("/api/session/"+live.ID+"/confirm", nil).ExpectStatus(http.StatusOK)

	// And the device that was not touched is on the break, because it asks the
	// same question of the same server and gets the same answer.
	if got := liveSession(t, client); got.Session == nil || got.Session.Kind != "shortBreak" {
		t.Errorf("the first device still shows the ring: %+v", got.Session)
	}
}

func TestConfirmingRequiresBeingSignedIn(t *testing.T) {
	h := apitest.New(t)

	h.POST("/api/session/"+uuid.NewString()+"/confirm", nil).
		ExpectError(http.StatusUnauthorized, "not_signed_in")
}

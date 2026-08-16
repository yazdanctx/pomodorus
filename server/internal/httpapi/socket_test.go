package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// The socket is the difference between "the server owns the timer" and "one
// timer follows you between devices". These tests are at the same seam as
// every other: real HTTP, a real upgrade, a real Postgres — and what they
// assert on is what somebody with two devices would see.

// device signs in again as the same person, which is what a second device is:
// its own cookie jar, its own session row, the same account.
func device(t *testing.T, h *apitest.Harness) *apitest.Client {
	t.Helper()
	return h.SignIn(address)
}

func frameSession(t *testing.T, s *apitest.Socket) sessionPayload {
	t.Helper()
	var body sessionPayload
	s.NextTimer(&body)
	return body
}

func TestTheSocketOpensOntoWhateverTheTimerAlreadyIs(t *testing.T) {
	h := apitest.New(t)
	phone, category := working(t, h)
	started := payload(t, start(phone, category, pomodoro)).Session

	// The laptop has never asked anything over HTTP. Opening the socket is
	// enough to know there is a pomodoro running and when it ends — which is
	// what stops it offering a start button to somebody mid-session.
	laptop := device(t, h).Socket()
	opened := frameSession(t, laptop)

	if opened.Session == nil {
		t.Fatal("the socket opened onto no session, and one is running")
	}
	if opened.Session.ID != started.ID {
		t.Errorf("session %s, want %s", opened.Session.ID, started.ID)
	}
	// The same digits, because the same instants: the countdown is computed
	// from these, never streamed.
	if opened.Session.EndsAt != started.EndsAt {
		t.Errorf("endsAt %d, want %d", opened.Session.EndsAt, started.EndsAt)
	}
	if opened.Session.StartedAt != started.StartedAt {
		t.Errorf("startedAt %d, want %d", opened.Session.StartedAt, started.StartedAt)
	}
	// And it carries the server's clock like every other answer, so a device
	// that has only ever held a socket can still correct its own skew.
	if opened.ServerNow != apitest.Origin.UnixMilli() {
		t.Errorf("serverNow %d, want %d", opened.ServerNow, apitest.Origin.UnixMilli())
	}
}

func TestAnEmptyTimerIsPushedAsEmpty(t *testing.T) {
	h := apitest.New(t)
	signedIn(t, h)

	opened := frameSession(t, device(t, h).Socket())
	if opened.Session != nil {
		t.Fatalf("a fresh account opened onto a session: %+v", opened.Session)
	}
	// The intervals ride along, so a device that has only the socket still
	// knows what a break is worth on this account.
	if opened.Intervals.PerCycle == 0 {
		t.Error("the frame carries no intervals")
	}
}

func TestStartingOnOneDeviceReachesTheOther(t *testing.T) {
	h := apitest.New(t)
	phone, category := working(t, h)

	laptop := device(t, h).Socket()
	frameSession(t, laptop) // the empty timer it opened onto

	started := payload(t, start(phone, category, pomodoro)).Session

	pushed := frameSession(t, laptop)
	if pushed.Session == nil || pushed.Session.ID != started.ID {
		t.Fatalf("the laptop was not told about the pomodoro: %+v", pushed.Session)
	}
	if pushed.Session.EndsAt != started.EndsAt {
		t.Errorf("endsAt %d, want %d", pushed.Session.EndsAt, started.EndsAt)
	}
	// The task travels with it, because it is the same timer and not a second
	// one: the laptop shows what is being worked on without ever picking it.
	if pushed.Session.CategoryName == nil || *pushed.Session.CategoryName != "درس" {
		t.Errorf("categoryName is %v, want درس", pushed.Session.CategoryName)
	}
}

func TestCancellingOnOneDeviceReachesTheOther(t *testing.T) {
	h := apitest.New(t)
	phone, category := working(t, h)
	started := payload(t, start(phone, category, pomodoro)).Session

	laptop := device(t, h).Socket()
	frameSession(t, laptop) // the running pomodoro it opened onto

	phone.POST("/api/session/"+started.ID+"/cancel", nil).ExpectStatus(http.StatusOK)

	// The laptop stops counting down something that was abandoned elsewhere.
	if pushed := frameSession(t, laptop); pushed.Session != nil {
		t.Fatalf("the laptop still has a session after it was cancelled: %+v", pushed.Session)
	}
}

func TestConfirmingOnOneDeviceReachesTheOther(t *testing.T) {
	h := apitest.New(t)
	phone, category := working(t, h)
	started := payload(t, start(phone, category, pomodoro)).Session

	laptop := device(t, h).Socket()
	frameSession(t, laptop)

	// Ring the bell, then answer it on the phone.
	h.Clock.Advance(26 * time.Minute)
	confirmed := payload(t, phone.POST("/api/session/"+started.ID+"/confirm", nil)).Session

	// What the laptop is told is the break the confirmation started, not the
	// pomodoro that was acknowledged — the fact, after it became durable.
	pushed := frameSession(t, laptop)
	if pushed.Session == nil {
		t.Fatal("the laptop was told the timer is empty, and a break is running")
	}
	if pushed.Session.ID != confirmed.ID {
		t.Errorf("session %s, want the break %s", pushed.Session.ID, confirmed.ID)
	}
	if pushed.Session.Kind != "shortBreak" {
		t.Errorf("kind %q, want shortBreak", pushed.Session.Kind)
	}
	// And the cycle it closed, which is what the row of dots reads.
	if pushed.Cycle.Count != 1 {
		t.Errorf("cycle count %d, want 1", pushed.Cycle.Count)
	}
}

func TestEditingTheIntervalsReachesTheOther(t *testing.T) {
	h := apitest.New(t)
	phone := signedIn(t, h)

	laptop := device(t, h).Socket()
	frameSession(t, laptop)

	phone.POST("/api/intervals", map[string]any{
		"shortBreakMs": 10 * 60 * 1000, "longBreakMs": 30 * 60 * 1000, "perCycle": 3,
	}).ExpectStatus(http.StatusOK)

	pushed := frameSession(t, laptop)
	if pushed.Intervals.ShortBreakMs != 10*60*1000 || pushed.Intervals.PerCycle != 3 {
		t.Errorf("the laptop kept the old intervals: %+v", pushed.Intervals)
	}
}

// The one guarantee here that is not about convenience.
func TestAUserOnlyEverReceivesTheirOwnTimer(t *testing.T) {
	h := apitest.New(t)
	mine := signedIn(t, h)
	_ = mine

	watching := device(t, h).Socket()
	frameSession(t, watching)

	// Somebody else's whole gesture, on their own account.
	stranger := h.SignIn("someone@else.example")
	claim(stranger, "someone").ExpectStatus(http.StatusOK)
	theirCategory := createdCategory(t, createCategory(stranger, "کار", true)).ID
	start(stranger, theirCategory, pomodoro).ExpectStatus(http.StatusOK)

	watching.ExpectNothing()
}

func TestAnAnonymousUpgradeIsRefused(t *testing.T) {
	h := apitest.New(t)

	// Refused before the upgrade, as an ordinary 401 — and refused for want of
	// a cookie, since there is no other way to present a credential here.
	if status := h.NewClient().SocketRefused(); status != http.StatusUnauthorized {
		t.Errorf("the upgrade was answered %d, want %d", status, http.StatusUnauthorized)
	}
}

// A cookie is attached by the browser to whoever asks, so the question the
// upgrade has to answer is not "is this person signed in" but "is this their
// own app asking". Refusing another site is the whole of that answer.
func TestAnotherSiteCannotOpenSomebodysSocket(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	if status := client.SocketRefused("https://evil.example"); status != http.StatusForbidden {
		t.Errorf("a cross-origin upgrade was answered %d, want %d", status, http.StatusForbidden)
	}
}

func TestSigningOutClosesTheDoorOnANewSocket(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)
	client.POST("/api/auth/sign-out", nil).ExpectStatus(http.StatusNoContent)

	if status := client.SocketRefused(); status != http.StatusUnauthorized {
		t.Errorf("the upgrade was answered %d, want %d", status, http.StatusUnauthorized)
	}
}

func TestKeepaliveHoldsAnIdleSocketOpen(t *testing.T) {
	// The hosting proxy drops quiet connections, and a pomodoro is
	// twenty-five quiet minutes. Turned down to milliseconds so several
	// keepalives pass in the time a test can afford.
	h := apitest.New(t, apitest.Keepalive(20*time.Millisecond))
	phone, category := working(t, h)

	laptop := device(t, h).Socket()
	frameSession(t, laptop)

	// Idle, across many ping intervals. The socket answering them is what
	// keeps it open, and a socket that had died would take the frame below
	// with it.
	time.Sleep(300 * time.Millisecond)

	started := payload(t, start(phone, category, pomodoro)).Session
	if pushed := frameSession(t, laptop); pushed.Session == nil || pushed.Session.ID != started.ID {
		t.Fatalf("the socket did not survive being idle: %+v", pushed.Session)
	}
}

// The other half of the keepalive, and the half that can fail if it is
// removed: a device that stops answering is let go of rather than held open
// forever with a subscription and a goroutine behind it.
func TestASocketThatStopsAnsweringIsDropped(t *testing.T) {
	h := apitest.New(t, apitest.Keepalive(20*time.Millisecond))
	signedIn(t, h)

	// Nothing at this layer would ever notice: the connection is fine as far
	// as the operating system is concerned, and only the unanswered ping says
	// otherwise.
	device(t, h).SilentSocket().ExpectDropped(300 * time.Millisecond)
}

// A session is revocable instantly, and a socket held open for hours must not
// be the exception that makes it "revocable, eventually".
func TestSigningOutHangsUpASocketAlreadyOpen(t *testing.T) {
	h := apitest.New(t, apitest.Keepalive(20*time.Millisecond))
	client := signedIn(t, h)

	open := client.Socket()
	frameSession(t, open)

	client.POST("/api/auth/sign-out", nil).ExpectStatus(http.StatusNoContent)

	open.ExpectClosed(2 * time.Second)
}

func TestAReconnectedSocketResynchronises(t *testing.T) {
	h := apitest.New(t)
	phone, category := working(t, h)

	laptop := device(t, h)
	dropped := laptop.Socket()
	frameSession(t, dropped)

	// The tunnel. Everything that happens while the socket is down is missed,
	// and nothing is replayed to it — the timer is a stored fact, so there is
	// nothing to replay.
	dropped.Close()
	started := payload(t, start(phone, category, pomodoro)).Session
	h.Clock.Advance(5 * time.Minute)

	// Coming back is the same as arriving: the first frame is the whole
	// current answer, and the countdown it implies is where it would have been
	// had the socket never dropped.
	back := frameSession(t, laptop.Socket())
	if back.Session == nil || back.Session.ID != started.ID {
		t.Fatalf("the reconnected socket did not resynchronise: %+v", back.Session)
	}
	if back.Session.EndsAt != started.EndsAt {
		t.Errorf("endsAt %d, want %d — the countdown moved across a reconnect",
			back.Session.EndsAt, started.EndsAt)
	}
	if back.ServerNow != apitest.Origin.Add(5*time.Minute).UnixMilli() {
		t.Errorf("serverNow %d, want the clock as it now is", back.ServerNow)
	}
}

// Three devices is not a special case, and the hub should not make it one.
func TestEveryOpenDeviceIsReached(t *testing.T) {
	h := apitest.New(t)
	phone, category := working(t, h)

	laptop := device(t, h).Socket()
	tablet := device(t, h).Socket()
	frameSession(t, laptop)
	frameSession(t, tablet)

	started := payload(t, start(phone, category, pomodoro)).Session

	for name, s := range map[string]*apitest.Socket{"laptop": laptop, "tablet": tablet} {
		if pushed := frameSession(t, s); pushed.Session == nil || pushed.Session.ID != started.ID {
			t.Errorf("the %s was not reached: %+v", name, pushed.Session)
		}
	}
}

// Reading is not a change. A tab that merely looks must not put a frame on
// everybody else's wire.
func TestReadingTheTimerPushesNothing(t *testing.T) {
	h := apitest.New(t)
	phone, category := working(t, h)
	start(phone, category, pomodoro).ExpectStatus(http.StatusOK)

	laptop := device(t, h).Socket()
	frameSession(t, laptop)

	liveSession(t, phone)
	laptop.ExpectNothing()
}

package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
	"github.com/yazdanctx/pomodorus/server/internal/timer"
)

type sessionPayload struct {
	Session *struct {
		ID           string  `json:"id"`
		Kind         string  `json:"kind"`
		CategoryID   *string `json:"categoryId"`
		CategoryName *string `json:"categoryName"`
		StartedAt    int64   `json:"startedAt"`
		EndsAt       int64   `json:"endsAt"`
		DurationMs   int64   `json:"durationMs"`
	} `json:"session"`
	ServerNow int64 `json:"serverNow"`
}

const pomodoro = int64(25 * 60 * 1000)

func start(c *apitest.Client, categoryID string, durationMs int64) *apitest.Response {
	return c.POST("/api/session/start", map[string]any{
		"id": uuid.NewString(), "categoryId": categoryID, "durationMs": durationMs,
	})
}

func liveSession(t *testing.T, c *apitest.Client) sessionPayload {
	t.Helper()
	var body sessionPayload
	c.GET("/api/session").ExpectStatus(http.StatusOK).JSON(&body)
	return body
}

func payload(t *testing.T, res *apitest.Response) sessionPayload {
	t.Helper()
	var body sessionPayload
	res.ExpectStatus(http.StatusOK).JSON(&body)
	return body
}

// working signs somebody in, gives them a task, and returns both.
func working(t *testing.T, h *apitest.Harness) (*apitest.Client, string) {
	t.Helper()
	client := signedIn(t, h)
	return client, createdCategory(t, createCategory(client, "درس", true)).ID
}

func TestThereIsNoSessionUntilOneIsStarted(t *testing.T) {
	h := apitest.New(t)
	client, _ := working(t, h)

	// The field is always present and null, so the client never has to tell
	// "no timer" from "not asked yet".
	if got := liveSession(t, client); got.Session != nil {
		t.Fatalf("a fresh account has a session: %+v", got.Session)
	}
}

func TestStartingASession(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	started := payload(t, start(client, category, pomodoro)).Session
	if started == nil {
		t.Fatal("starting returned no session")
	}

	if started.Kind != "work" {
		t.Errorf("kind is %q, want work", started.Kind)
	}
	if started.CategoryID == nil || *started.CategoryID != category {
		t.Errorf("categoryId is %v, want %s", started.CategoryID, category)
	}
	if started.CategoryName == nil || *started.CategoryName != "درس" {
		t.Errorf("categoryName is %v, want درس", started.CategoryName)
	}
	if started.DurationMs != pomodoro {
		t.Errorf("durationMs is %d, want %d", started.DurationMs, pomodoro)
	}

	// It is there the moment it is asked for, from anywhere.
	if got := liveSession(t, client); got.Session == nil || got.Session.ID != started.ID {
		t.Errorf("the session is not live afterwards: %+v", got.Session)
	}
}

func TestEveryTimestampIsAbsoluteEpochMillis(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	body := payload(t, start(client, category, pomodoro))
	started := body.Session

	// Not "seconds remaining": a response read late still says the same thing.
	if want := apitest.Origin.UnixMilli(); started.StartedAt != want {
		t.Errorf("startedAt is %d, want %d", started.StartedAt, want)
	}
	if want := apitest.Origin.Add(25 * time.Minute).UnixMilli(); started.EndsAt != want {
		t.Errorf("endsAt is %d, want %d", started.EndsAt, want)
	}
	// And every response carries the server's clock, so a client can correct
	// for skew rather than trusting its own idea of what time it is.
	if body.ServerNow != apitest.Origin.UnixMilli() {
		t.Errorf("serverNow is %d, want %d", body.ServerNow, apitest.Origin.UnixMilli())
	}
}

func TestStartingWhileOneIsLiveReturnsTheLiveOne(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	first := payload(t, start(client, category, pomodoro)).Session

	// A second device opening the app is not a second timer. It asks to
	// start, and is shown the one already running.
	second := h.NewClient()
	second.CopyCookiesFrom(client)
	again := payload(t, start(second, category, 30*60*1000)).Session

	if again.ID != first.ID {
		t.Fatalf("a second start made a new session: %s then %s", first.ID, again.ID)
	}
	// The length it asked for is ignored: the running session is the truth.
	if again.DurationMs != pomodoro {
		t.Errorf("durationMs is %d, want the live session's %d", again.DurationMs, pomodoro)
	}
	if again.EndsAt != first.EndsAt {
		t.Error("the live session's end moved")
	}
}

func TestStartingIsIdempotentOnTheClientMintedID(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	body := map[string]any{
		"id": uuid.NewString(), "categoryId": category, "durationMs": pomodoro,
	}
	first := payload(t, client.POST("/api/session/start", body)).Session
	// The same request twice, which is what a retry on a poor connection is.
	second := payload(t, client.POST("/api/session/start", body)).Session

	if first.ID != second.ID || first.StartedAt != second.StartedAt {
		t.Errorf("the retry started a different session: %+v then %+v", first, second)
	}
}

func TestOnlyOneLiveSessionCanExistPerUser(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// Decided by the schema, not by the handler: writing a second live row
	// directly has to fail too, or the guarantee is only as good as the code
	// path that happens to be in front of it.
	_, err := h.DB.Exec(t.Context(),
		`INSERT INTO sessions (id, user_id, kind, category_id, started_at, duration_ms, ends_at)
		 SELECT $1, user_id, kind, category_id, started_at, duration_ms, ends_at
		 FROM sessions WHERE id = $2`,
		uuid.New(), live.ID)
	if err == nil {
		t.Fatal("the schema allowed a second live session")
	}
}

func TestCancellingVoidsTheSession(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	client.POST("/api/session/"+live.ID+"/cancel", nil).ExpectStatus(http.StatusOK)

	if got := liveSession(t, client); got.Session != nil {
		t.Fatalf("the cancelled session is still live: %+v", got.Session)
	}
	// Voided, not credited: an interrupted pomodoro is not focus time.
	var cancelled bool
	if err := h.DB.QueryRow(t.Context(),
		`SELECT cancelled_at IS NOT NULL AND confirmed_at IS NULL FROM sessions WHERE id = $1`,
		live.ID).Scan(&cancelled); err != nil {
		t.Fatal(err)
	}
	if !cancelled {
		t.Error("the session was not voided")
	}
}

func TestCancellingFreesTheTimerForAnother(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session
	client.POST("/api/session/"+live.ID+"/cancel", nil).ExpectStatus(http.StatusOK)

	next := payload(t, start(client, category, pomodoro)).Session
	if next.ID == live.ID {
		t.Error("starting again returned the cancelled session")
	}
}

func TestCancellingIsRefusedOnceTheBellHasGone(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// At the nominal end the work has been credited, so it can no longer be
	// retracted. The boundary belongs to the ring.
	h.Clock.Advance(25 * time.Minute)
	client.POST("/api/session/"+live.ID+"/cancel", nil).
		ExpectError(http.StatusConflict, "not_cancellable")

	// It is still live — ringing, waiting to be acknowledged.
	if got := liveSession(t, client); got.Session == nil || got.Session.ID != live.ID {
		t.Errorf("the ringing session vanished: %+v", got.Session)
	}
}

func TestCancellingIsAllowedUntilTheVeryLastMoment(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// One millisecond before the end it is still the user's to abandon, which
	// is what says the clock is deciding rather than the test always being on
	// one side of the boundary.
	h.Clock.Advance(25*time.Minute - time.Millisecond)
	client.POST("/api/session/"+live.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
}

func TestCancellingTwiceIsRefused(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	client.POST("/api/session/"+live.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
	client.POST("/api/session/"+live.ID+"/cancel", nil).
		ExpectError(http.StatusConflict, "not_cancellable")
}

func TestASessionRunsAndThenRings(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// Advancing the clock drives the session to its end with no waiting at
	// all — which is what deriving state instead of scheduling it buys.
	h.Clock.Advance(25 * time.Minute)

	got := liveSession(t, client)
	if got.Session == nil {
		t.Fatal("the session disappeared at its end rather than ringing")
	}
	// Nothing advances on its own: it is still here, unacknowledged, and its
	// stored facts have not moved.
	if got.Session.EndsAt != live.EndsAt || got.Session.DurationMs != live.DurationMs {
		t.Error("the row changed when the bell rang")
	}
	if got.ServerNow < got.Session.EndsAt {
		t.Error("the clock did not actually reach the end")
	}
}

func TestOnlyTheOfferedLengthsAreAccepted(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	for _, bad := range []int64{
		0,
		-int64(25 * time.Minute / time.Millisecond),
		int64(10 * time.Minute / time.Millisecond), // under the band
		int64(65 * time.Minute / time.Millisecond), // over it
		int64(26 * time.Minute / time.Millisecond), // off the step
		int64(10 * time.Hour / time.Millisecond),   // focus time out of nothing
	} {
		start(client, category, bad).ExpectError(http.StatusBadRequest, "bad_duration")
	}

	// Everything the stepper can produce is accepted.
	for d := timer.MinWork; d <= timer.MaxWork; d += timer.WorkStep {
		live := payload(t, start(client, category, int64(d/time.Millisecond))).Session
		client.POST("/api/session/"+live.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
	}
}

func TestASessionNeedsATaskThatExists(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	start(client, uuid.NewString(), pomodoro).
		ExpectError(http.StatusNotFound, "category_not_found")

	// Somebody else's task is not one to record against either.
	theirs := h.SignIn("someone@example.com")
	claim(theirs, "someone").ExpectStatus(http.StatusOK)
	start(theirs, category, pomodoro).ExpectError(http.StatusNotFound, "category_not_found")

	// Nor is a deleted one.
	client.POST("/api/categories/"+category+"/delete", nil).ExpectStatus(http.StatusNoContent)
	start(client, category, pomodoro).ExpectError(http.StatusNotFound, "category_not_found")
}

func TestATaskWithALiveSessionCannotBeEditedOrDeleted(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// A live session cannot lose its label or have it changed underneath it.
	client.POST("/api/categories/"+category, map[string]any{"name": "ریاضی", "isPublic": true}).
		ExpectError(http.StatusConflict, "category_busy")
	client.POST("/api/categories/"+category+"/delete", nil).
		ExpectError(http.StatusConflict, "category_busy")

	// Still guarded while it rings, because it is still live.
	h.Clock.Advance(25 * time.Minute)
	client.POST("/api/categories/"+category+"/delete", nil).
		ExpectError(http.StatusConflict, "category_busy")

	// Released the moment it is no longer live.
	h.Clock.Set(apitest.Origin)
	client.POST("/api/session/"+live.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
	client.POST("/api/categories/"+category, map[string]any{"name": "ریاضی", "isPublic": true}).
		ExpectStatus(http.StatusOK)
}

func TestTheTimerBelongsToThePersonNotTheDevice(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	// A second device, same person: it opens into the running timer…
	other := h.NewClient()
	other.CopyCookiesFrom(client)
	if got := liveSession(t, other); got.Session == nil || got.Session.ID != live.ID {
		t.Fatal("the second device sees no timer")
	}

	// …and can cancel it from there.
	other.POST("/api/session/"+live.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
	if got := liveSession(t, client); got.Session != nil {
		t.Error("the first device still shows a cancelled session")
	}
}

func TestSomebodyElsesSessionIsNotYoursToCancel(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	live := payload(t, start(client, category, pomodoro)).Session

	theirs := h.SignIn("someone@example.com")
	claim(theirs, "someone").ExpectStatus(http.StatusOK)
	theirs.POST("/api/session/"+live.ID+"/cancel", nil).
		ExpectError(http.StatusConflict, "not_cancellable")

	if got := liveSession(t, client); got.Session == nil {
		t.Error("somebody else cancelled my session")
	}
}

func TestSessionsRequireBeingSignedIn(t *testing.T) {
	h := apitest.New(t)

	h.GET("/api/session").ExpectError(http.StatusUnauthorized, "not_signed_in")
	start(h.Client, uuid.NewString(), pomodoro).
		ExpectError(http.StatusUnauthorized, "not_signed_in")
}

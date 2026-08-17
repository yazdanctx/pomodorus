package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
	"github.com/yazdanctx/pomodorus/server/internal/push"
)

// bell is the payload a service worker receives: which ring this is, and no
// words. The Persian for it lives in the client's copy.json, beside the
// sentence the in-tab notification uses.
type bell struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
}

// subscribe registers a device, the way a browser hands over what
// PushManager.subscribe gave it.
func subscribe(c *apitest.Client, name string) *apitest.Response {
	return c.POST("/api/push/subscribe", map[string]any{
		"endpoint": "https://push.example/" + name,
		"p256dh":   "BN" + name,
		"auth":     "auth-" + name,
	})
}

func delivered(t *testing.T, h *apitest.Harness) []bell {
	t.Helper()
	sent := h.Push.Sent()
	bells := make([]bell, 0, len(sent))
	for _, one := range sent {
		var got bell
		if err := json.Unmarshal(one.Payload, &got); err != nil {
			t.Fatalf("payload is not JSON: %v — %s", err, one.Payload)
		}
		bells = append(bells, got)
	}
	return bells
}

func TestSubscribingIsRequiredToBeSignedIn(t *testing.T) {
	h := apitest.New(t)
	subscribe(h.NewClient(), "phone").ExpectError(http.StatusUnauthorized, "not_signed_in")
}

func TestOnlyARealPushEndpointIsAccepted(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	for _, body := range []map[string]any{
		{"endpoint": "http://push.example/insecure", "p256dh": "k", "auth": "a"},
		{"endpoint": "not-a-url", "p256dh": "k", "auth": "a"},
		{"endpoint": "https://push.example/x", "p256dh": "", "auth": "a"},
		{"endpoint": "https://push.example/x", "p256dh": "k", "auth": ""},
	} {
		client.POST("/api/push/subscribe", body).
			ExpectError(http.StatusBadRequest, "malformed_request")
	}
}

func TestTheBellReachesEveryDeviceAtItsNominalEnd(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	// Two devices, one account. There is nothing else to fake: the server owns
	// the timer, so "my phone and my laptop" is one cookie in two jars.
	laptop := h.NewClient()
	laptop.CopyCookiesFrom(client)
	subscribe(client, "phone").ExpectStatus(http.StatusOK)
	subscribe(laptop, "laptop").ExpectStatus(http.StatusOK)

	live := payload(t, start(client, category, pomodoro)).Session

	h.Clock.Advance(25*time.Minute - time.Millisecond)
	if got := delivered(t, h); len(got) != 0 {
		t.Fatalf("delivered %d before the bell, want none", len(got))
	}

	h.Clock.Advance(time.Millisecond)
	got := delivered(t, h)
	if len(got) != 2 {
		t.Fatalf("delivered %d at the bell, want one per device", len(got))
	}
	for _, one := range got {
		if one.SessionID != live.ID {
			t.Errorf("announced %s, want the session that rang, %s", one.SessionID, live.ID)
		}
		if one.Kind != "work" {
			t.Errorf("kind %q, want work", one.Kind)
		}
	}
}

func TestTheBellChangesNothingAboutTheSession(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	subscribe(client, "phone").ExpectStatus(http.StatusOK)

	live := payload(t, start(client, category, pomodoro)).Session
	endsAt, durationMs, _ := stored(t, h, live.ID)

	h.Clock.Advance(25 * time.Minute)
	if got := len(delivered(t, h)); got != 1 {
		t.Fatalf("delivered %d, want 1", got)
	}

	// The notification is a courtesy laid over derived state. Sending it must
	// not confirm anything, credit anything, or move a column.
	after, afterDuration, confirmedAt := stored(t, h, live.ID)
	if !after.Equal(endsAt) || afterDuration != durationMs || confirmedAt != nil {
		t.Fatalf("the push wrote to the session: ends_at %v, duration %d, confirmed %v",
			after, afterDuration, confirmedAt)
	}
	// And it is still ringing, waiting for the one deliberate tap that ends it.
	if got := liveSession(t, client); got.Session == nil || got.Session.ID != live.ID {
		t.Fatalf("the session stopped ringing on its own: %+v", got.Session)
	}
}

func TestCancellingASessionCancelsItsNotification(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	subscribe(client, "phone").ExpectStatus(http.StatusOK)

	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(5 * time.Minute)
	client.POST("/api/session/"+live.ID+"/cancel", nil).ExpectStatus(http.StatusOK)

	h.Clock.Advance(30 * time.Minute)
	if got := delivered(t, h); len(got) != 0 {
		t.Fatalf("delivered %v for an abandoned session, want none", got)
	}
}

func TestTheBreakThatSurvivesARingGetsItsOwnNotification(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	subscribe(client, "phone").ExpectStatus(http.StatusOK)

	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(25 * time.Minute)

	rest := payload(t, client.POST("/api/session/"+live.ID+"/confirm", nil)).Session
	if rest == nil || rest.Kind != "shortBreak" {
		t.Fatalf("confirming did not start the break: %+v", rest)
	}

	h.Clock.Advance(5 * time.Minute)
	got := delivered(t, h)
	if len(got) != 2 {
		t.Fatalf("delivered %d, want the pomodoro's bell and the break's", len(got))
	}
	if got[1].Kind != "shortBreak" || got[1].SessionID != rest.ID {
		t.Fatalf("the second bell was %+v, want the break %s", got[1], rest.ID)
	}
}

func TestSkippingABreakCancelsItsNotification(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	subscribe(client, "phone").ExpectStatus(http.StatusOK)

	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(25 * time.Minute)
	rest := payload(t, client.POST("/api/session/"+live.ID+"/confirm", nil)).Session

	client.POST("/api/session/"+rest.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
	h.Clock.Advance(10 * time.Minute)

	// The pomodoro's own bell, and nothing for the rest that was skipped.
	if got := delivered(t, h); len(got) != 1 || got[0].Kind != "work" {
		t.Fatalf("delivered %v, want only the pomodoro's bell", got)
	}
}

func TestAnExpiredSubscriptionIsDeletedRatherThanRetriedForever(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	subscribe(client, "dead").ExpectStatus(http.StatusOK)
	subscribe(client, "alive").ExpectStatus(http.StatusOK)
	h.Push.Gone("https://push.example/dead")

	live := payload(t, start(client, category, pomodoro)).Session
	h.Clock.Advance(25 * time.Minute)
	client.POST("/api/session/"+live.ID+"/confirm", nil).ExpectStatus(http.StatusOK)

	if got := subscriptionCount(t, h); got != 1 {
		t.Fatalf("%d subscriptions remain, want the expired one gone", got)
	}
	// The device beside it heard the bell all the same.
	if got := delivered(t, h); len(got) != 1 {
		t.Fatalf("delivered %d, want the one live device to have been told", len(got))
	}
}

func TestResubscribingIsOneDeviceRatherThanTwo(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	subscribe(client, "phone").ExpectStatus(http.StatusOK)
	subscribe(client, "phone").ExpectStatus(http.StatusOK)

	if got := subscriptionCount(t, h); got != 1 {
		t.Fatalf("%d subscriptions, want one per device however often it re-registers", got)
	}
}

func TestABellIsRebuiltAcrossARestart(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	subscribe(client, "phone").ExpectStatus(http.StatusOK)

	live := payload(t, start(client, category, pomodoro)).Session

	// The process goes away five minutes in, taking every in-memory timer with
	// it, and comes back on the same database.
	h.Clock.Advance(5 * time.Minute)
	h.Reboot()

	// The timer itself never depended on the process: it is the row plus now().
	after := liveSession(t, client)
	if after.Session == nil || after.Session.ID != live.ID || after.Session.EndsAt != live.EndsAt {
		t.Fatalf("the restart moved the timer: %+v", after.Session)
	}

	// And the notification is back, from the one query the boot runs.
	h.Clock.Advance(20 * time.Minute)
	got := delivered(t, h)
	if len(got) != 1 || got[0].SessionID != live.ID {
		t.Fatalf("delivered %v after the restart, want the pending bell", got)
	}
}

func TestABellMissedDuringARestartIsNotFiredLate(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	subscribe(client, "phone").ExpectStatus(http.StatusOK)
	start(client, category, pomodoro).ExpectStatus(http.StatusOK)

	// Down through the bell and back up an hour later. The session is still
	// ringing — nothing advances on its own — but announcing it now would be an
	// alarm about the middle of the afternoon.
	h.Halt()
	h.Clock.Advance(time.Hour)
	h.Reboot()

	h.Clock.Advance(time.Hour)
	if got := delivered(t, h); len(got) != 0 {
		t.Fatalf("delivered %v for a bell that went during the restart, want none", got)
	}
}

func TestTheVAPIDKeyIsWhatTheDeploymentHas(t *testing.T) {
	h := apitest.New(t)

	var body struct {
		PublicKey string `json:"publicKey"`
	}
	h.GET("/api/push/key").ExpectStatus(http.StatusOK).JSON(&body)

	// The harness stands up a development deployment, which has no keypair.
	// An empty key is the honest answer, and a 200: a browser reads it as
	// "this deployment cannot reach a closed tab", which is not a failure.
	if body.PublicKey != "" {
		t.Fatalf("publicKey = %q, want empty on a deployment with no keypair", body.PublicKey)
	}

	// And a deployment that has one hands it over to anybody, signed in or not:
	// it is a public key, and a browser needs it before it can subscribe.
	configured := apitest.New(t, apitest.WithVAPID("BKa-public"))
	configured.NewClient().GET("/api/push/key").ExpectStatus(http.StatusOK).JSON(&body)
	if body.PublicKey != "BKa-public" {
		t.Fatalf("publicKey = %q, want the deployment's", body.PublicKey)
	}
}

func TestNobodyElsesBellArrivesHere(t *testing.T) {
	h := apitest.New(t)
	mine, category := working(t, h)
	subscribe(mine, "mine").ExpectStatus(http.StatusOK)

	theirs := h.SignIn("someone@example.com")
	claim(theirs, "someone").ExpectStatus(http.StatusOK)
	subscribe(theirs, "theirs").ExpectStatus(http.StatusOK)

	start(mine, category, pomodoro).ExpectStatus(http.StatusOK)
	h.Clock.Advance(25 * time.Minute)

	sent := h.Push.Sent()
	if len(sent) != 1 {
		t.Fatalf("delivered %d, want one", len(sent))
	}
	if sent[0].To.Endpoint != "https://push.example/mine" {
		t.Fatalf("delivered to %s, want the account whose bell it was", sent[0].To.Endpoint)
	}
}

// A compile-time reminder of what the harness is holding: the memory sender is
// the seam, and a test that needs the real one is testing the push service.
var _ push.Sender = (*push.Memory)(nil)

func subscriptionCount(t *testing.T, h *apitest.Harness) int {
	t.Helper()
	var count int
	if err := h.DB.QueryRow(t.Context(),
		`SELECT count(*) FROM push_subscriptions`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

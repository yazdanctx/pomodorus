package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

func claim(c *apitest.Client, handle string) *apitest.Response {
	return c.POST("/api/handle", map[string]string{"handle": handle})
}

func handleOf(t *testing.T, c *apitest.Client) *string {
	t.Helper()
	var body struct {
		Handle *string `json:"handle"`
	}
	c.GET("/api/me").ExpectStatus(http.StatusOK).JSON(&body)
	return body.Handle
}

func TestClaimingAHandle(t *testing.T) {
	h := apitest.New(t)
	client := h.SignIn(address)

	claim(client, "yazdan").ExpectStatus(http.StatusOK)

	got := handleOf(t, client)
	if got == nil || *got != "yazdan" {
		t.Fatalf("handle is %v, want yazdan", got)
	}
}

func TestAHandleIsPermanent(t *testing.T) {
	h := apitest.New(t)
	client := h.SignIn(address)
	claim(client, "yazdan").ExpectStatus(http.StatusOK)

	// A shared profile link is expected to keep working forever, so there is
	// no route by which this succeeds — not a second claim, not a different
	// device, not a session opened later.
	claim(client, "someoneelse").ExpectError(http.StatusConflict, "handle_already_set")
	claim(h.SignIn(address), "someoneelse").ExpectError(http.StatusConflict, "handle_already_set")

	if got := handleOf(t, client); got == nil || *got != "yazdan" {
		t.Fatalf("handle is %v, want yazdan", got)
	}
}

func TestABadlyFormattedHandleIsRefusedWithItsOwnReason(t *testing.T) {
	h := apitest.New(t)
	client := h.SignIn(address)

	for _, bad := range []string{
		"",                        // nothing
		"ab",                      // too short
		"abcdefghijklmnopqrstuvw", // too long
		"yazdan-ctx",              // hyphen
		"yazdan ctx",              // space
		"یزدان",                   // Persian: the handle is Latin by construction
		"yazdan!",
	} {
		claim(client, bad).ExpectError(http.StatusBadRequest, "handle_invalid")
	}

	if got := handleOf(t, client); got != nil {
		t.Fatalf("a refused claim set the handle to %v", *got)
	}
}

func TestAProfaneHandleIsRefusedWithItsOwnReason(t *testing.T) {
	h := apitest.New(t)
	client := h.SignIn(address)

	// A distinct reason from a format failure: "that name is taken" and "that
	// name is not allowed" are different problems, and guessing which is
	// which is the thing this ticket exists to stop.
	claim(client, "koskesh").ExpectError(http.StatusBadRequest, "handle_profane")
	claim(client, "khamenei_1").ExpectError(http.StatusBadRequest, "handle_profane")

	// And an innocent name that merely contains those letters is not punished.
	claim(client, "kiarash").ExpectStatus(http.StatusOK)
}

func TestATakenHandleIsRefusedWithItsOwnReason(t *testing.T) {
	h := apitest.New(t)
	claim(h.SignIn(address), "yazdan").ExpectStatus(http.StatusOK)

	second := h.SignIn("someone@example.com")
	claim(second, "yazdan").ExpectError(http.StatusConflict, "handle_taken")

	if got := handleOf(t, second); got != nil {
		t.Fatalf("a refused claim set the handle to %v", *got)
	}
}

func TestUniquenessIsCaseInsensitive(t *testing.T) {
	h := apitest.New(t)
	claim(h.SignIn(address), "yazdan").ExpectStatus(http.StatusOK)

	// Two people who differ only in capitalisation would be two people at one
	// URL, which is the thing the citext column exists to prevent.
	claim(h.SignIn("someone@example.com"), "Yazdan").
		ExpectError(http.StatusConflict, "handle_taken")
}

func TestAHandleIsStoredLowercased(t *testing.T) {
	h := apitest.New(t)
	client := h.SignIn(address)

	// Somebody who types Yazdan means yazdan. Refusing the capital would be
	// refusing a handle for a reason nobody would guess.
	claim(client, "Yazdan").ExpectStatus(http.StatusOK)

	if got := handleOf(t, client); got == nil || *got != "yazdan" {
		t.Fatalf("handle is %v, want yazdan", got)
	}
}

func TestAbandoningTheStepResumesAtIt(t *testing.T) {
	h := apitest.New(t)
	h.SignIn(address)

	// Signing in again on a different device: still no handle, so still the
	// same step. Nothing is remembered client-side, because the server's
	// answer is the whole of it.
	later := h.SignIn(address)
	if got := handleOf(t, later); got != nil {
		t.Fatalf("handle is %v, want null", *got)
	}
	claim(later, "yazdan").ExpectStatus(http.StatusOK)
}

func TestClaimingRequiresBeingSignedIn(t *testing.T) {
	h := apitest.New(t)
	claim(h.Client, "yazdan").ExpectError(http.StatusUnauthorized, "not_signed_in")
}

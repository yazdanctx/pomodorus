package httpapi_test

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
	"github.com/yazdanctx/pomodorus/server/internal/auth"
)

func TestMain(m *testing.M) { apitest.Main(m) }

const address = "yazdan@example.com"

func requestCode(c *apitest.Client, email string) *apitest.Response {
	return c.POST("/api/auth/request-code", map[string]string{"email": email})
}

func verify(c *apitest.Client, email, code string) *apitest.Response {
	return c.POST("/api/auth/verify", map[string]string{"email": email, "code": code})
}

func TestRequestingACodeSendsMail(t *testing.T) {
	h := apitest.New(t)

	requestCode(h.Client, address).ExpectStatus(http.StatusOK)

	sent, ok := h.Mail.Last()
	if !ok {
		t.Fatal("no mail was sent")
	}
	if sent.To != address {
		t.Errorf("sent to %q, want %q", sent.To, address)
	}
	if code := h.LastCode(address); len(code) != auth.CodeDigits {
		t.Errorf("code %q is %d digits, want %d", code, len(code), auth.CodeDigits)
	}
}

func TestOneFlowNotTwo(t *testing.T) {
	h := apitest.New(t)

	// An unknown address creates the account…
	first := h.NewClient()
	requestCode(first, address).ExpectStatus(http.StatusOK)
	unknown := h.LastCode(address)
	verify(first, address, unknown).ExpectStatus(http.StatusOK)

	// …and a known one signs in, through the identical request.
	second := h.NewClient()
	requestCode(second, address).ExpectStatus(http.StatusOK)
	known := h.LastCode(address)
	verify(second, address, known).ExpectStatus(http.StatusOK)

	if got := countUsers(t, h); got != 1 {
		t.Errorf("signing in twice made %d accounts, want 1", got)
	}
}

func TestTheResponseIsIdenticalWhetherOrNotTheAddressIsKnown(t *testing.T) {
	h := apitest.New(t)
	h.SignIn(address)

	known := requestCode(h.NewClient(), address).ExpectStatus(http.StatusOK)
	unknown := requestCode(h.NewClient(), "nobody@example.com").ExpectStatus(http.StatusOK)

	// Byte-identical but for the clock, which has not moved: whether an
	// address has an account here is not something this endpoint may reveal.
	if string(known.Body) != string(unknown.Body) {
		t.Errorf("responses differ:\n known:   %s\n unknown: %s", known.Body, unknown.Body)
	}
}

func TestAMistypedAddressDoesNotCreateAnAccount(t *testing.T) {
	h := apitest.New(t)

	// The typo gets a code sent to an inbox its owner cannot read…
	requestCode(h.Client, "yazdam@example.com").ExpectStatus(http.StatusOK)

	// …and nothing exists until somebody proves they read one.
	if got := countUsers(t, h); got != 0 {
		t.Errorf("requesting a code made %d accounts, want 0", got)
	}
}

func TestAnAddressThatIsNotAnAddressIsRefused(t *testing.T) {
	h := apitest.New(t)

	for _, bad := range []string{"", "   ", "yazdan", "yazdan@", "@example.com", "yazdan@localhost"} {
		requestCode(h.Client, bad).ExpectError(http.StatusBadRequest, "invalid_email")
	}
}

func TestACodeExpiresAfterTenMinutes(t *testing.T) {
	h := apitest.New(t)
	requestCode(h.Client, address).ExpectStatus(http.StatusOK)
	code := h.LastCode(address)

	// A second before the deadline it is still good, which is what says the
	// clock is deciding rather than the test simply always being past it.
	h.Clock.Advance(auth.CodeTTL - time.Second)
	verify(h.NewClient(), address, code).ExpectStatus(http.StatusOK)

	requestCode(h.Client, address).ExpectStatus(http.StatusOK)
	stale := h.LastCode(address)
	h.Clock.Advance(auth.CodeTTL)
	verify(h.NewClient(), address, stale).ExpectError(http.StatusUnauthorized, "bad_code")
}

func TestACodeWorksOnce(t *testing.T) {
	h := apitest.New(t)
	requestCode(h.Client, address).ExpectStatus(http.StatusOK)
	code := h.LastCode(address)

	verify(h.NewClient(), address, code).ExpectStatus(http.StatusOK)
	// A forwarded or leaked email is not a second way in.
	verify(h.NewClient(), address, code).ExpectError(http.StatusUnauthorized, "bad_code")
}

func TestAskingForANewCodeKillsTheOldOne(t *testing.T) {
	h := apitest.New(t)
	requestCode(h.Client, address).ExpectStatus(http.StatusOK)
	first := h.LastCode(address)

	requestCode(h.Client, address).ExpectStatus(http.StatusOK)
	second := h.LastCode(address)
	if first == second {
		t.Fatal("the second request reissued the same code")
	}

	// The older email in the inbox stops working the moment a new one is sent.
	verify(h.NewClient(), address, first).ExpectError(http.StatusUnauthorized, "bad_code")
	verify(h.NewClient(), address, second).ExpectStatus(http.StatusOK)
}

func TestFiveWrongGuessesInvalidateTheCode(t *testing.T) {
	h := apitest.New(t)
	requestCode(h.Client, address).ExpectStatus(http.StatusOK)
	code := h.LastCode(address)

	for i := range auth.MaxAttempts {
		if wrong := wrongCode(code); verify(h.Client, address, wrong).Status != http.StatusUnauthorized {
			t.Fatalf("guess %d was not refused", i+1)
		}
	}

	// The right code no longer helps: nobody guesses their way in.
	verify(h.Client, address, code).ExpectError(http.StatusUnauthorized, "bad_code")
}

func TestFourWrongGuessesLeaveTheCodeUsable(t *testing.T) {
	h := apitest.New(t)
	requestCode(h.Client, address).ExpectStatus(http.StatusOK)
	code := h.LastCode(address)

	for range auth.MaxAttempts - 1 {
		verify(h.Client, address, wrongCode(code)).ExpectStatus(http.StatusUnauthorized)
	}

	// Fumbling the code is ordinary and must not lock anybody out.
	verify(h.Client, address, code).ExpectStatus(http.StatusOK)
}

func TestCodeRequestsAreRateLimitedPerAddress(t *testing.T) {
	h := apitest.New(t)

	for i := range auth.MaxCodesPerEmail {
		if requestCode(h.Client, address).Status != http.StatusOK {
			t.Fatalf("request %d was refused before the limit", i+1)
		}
	}
	requestCode(h.Client, address).ExpectError(http.StatusTooManyRequests, "rate_limited")

	// Another address is unaffected — the limit is per mailbox, not global.
	requestCode(h.Client, "someone@example.com").ExpectStatus(http.StatusOK)

	// And it is a window, not a ban: waiting it out restores the address.
	h.Clock.Advance(auth.RateWindow)
	requestCode(h.Client, address).ExpectStatus(http.StatusOK)
}

func TestCodeRequestsAreRateLimitedPerIP(t *testing.T) {
	h := apitest.New(t)

	// Well under the per-address limit each, so only the per-host limit can
	// be what stops this.
	sent := 0
	for i := range auth.MaxCodesPerIP {
		email := addressN(i / 2)
		if requestCode(h.Client, email).Status != http.StatusOK {
			t.Fatalf("request %d was refused before the limit", i+1)
		}
		sent++
	}
	if sent != auth.MaxCodesPerIP {
		t.Fatalf("sent %d, want %d", sent, auth.MaxCodesPerIP)
	}
	requestCode(h.Client, addressN(99)).ExpectError(http.StatusTooManyRequests, "rate_limited")
}

func TestVerifyingOpensASessionThatSurvives(t *testing.T) {
	h := apitest.New(t)
	client := h.SignIn(address)

	me := client.GET("/api/me").ExpectStatus(http.StatusOK)
	var body struct {
		Handle *string `json:"handle"`
	}
	me.JSON(&body)
	if body.Handle != nil {
		t.Errorf("handle is %v, want null before it is claimed", *body.Handle)
	}

	// Months later, still signed in: this is a personal tool, not a bank.
	h.Clock.Advance(auth.SessionTTL - 24*time.Hour)
	client.GET("/api/me").ExpectStatus(http.StatusOK)
}

func TestAnUnusedSessionEventuallyLapses(t *testing.T) {
	h := apitest.New(t)
	client := h.SignIn(address)

	h.Clock.Advance(auth.SessionTTL + time.Minute)
	client.GET("/api/me").ExpectError(http.StatusUnauthorized, "not_signed_in")
}

func TestSigningOutEndsTheSessionOnTheServer(t *testing.T) {
	h := apitest.New(t)
	client := h.SignIn(address)

	client.POST("/api/auth/sign-out", nil).ExpectStatus(http.StatusNoContent)
	client.GET("/api/me").ExpectError(http.StatusUnauthorized, "not_signed_in")
}

func TestSigningOutStopsACookieThatWasCopied(t *testing.T) {
	h := apitest.New(t)
	client := h.SignIn(address)

	// A second device holding the same cookie — which is what a stolen one is.
	stolen := h.NewClient()
	stolen.CopyCookiesFrom(client)
	stolen.GET("/api/me").ExpectStatus(http.StatusOK)

	client.POST("/api/auth/sign-out", nil).ExpectStatus(http.StatusNoContent)

	// The row is gone, so the copy stops working too. A self-contained signed
	// token could not be withdrawn like this.
	stolen.GET("/api/me").ExpectError(http.StatusUnauthorized, "not_signed_in")
}

func TestNotSignedInIsNotAnError(t *testing.T) {
	h := apitest.New(t)
	h.GET("/api/me").ExpectError(http.StatusUnauthorized, "not_signed_in")
}

func TestEveryResponseCarriesTheServerClock(t *testing.T) {
	h := apitest.New(t)

	var body struct {
		ServerNow int64 `json:"serverNow"`
	}
	requestCode(h.Client, address).ExpectStatus(http.StatusOK).JSON(&body)

	if want := apitest.Origin.UnixMilli(); body.ServerNow != want {
		t.Errorf("serverNow %d, want %d", body.ServerNow, want)
	}
}

func TestAnAddressIsCaseInsensitive(t *testing.T) {
	h := apitest.New(t)

	requestCode(h.Client, "Yazdan@Example.COM").ExpectStatus(http.StatusOK)
	code := h.LastCode("yazdan@example.com")
	verify(h.NewClient(), "yazdan@example.com", code).ExpectStatus(http.StatusOK)

	requestCode(h.Client, "YAZDAN@example.com").ExpectStatus(http.StatusOK)
	verify(h.NewClient(), "yazdan@example.com", h.LastCode("yazdan@example.com")).
		ExpectStatus(http.StatusOK)

	if got := countUsers(t, h); got != 1 {
		t.Errorf("case made %d accounts, want 1", got)
	}
}

func countUsers(t *testing.T, h *apitest.Harness) int64 {
	t.Helper()
	var body struct {
		Users int64 `json:"users"`
	}
	h.GET("/api/health").ExpectStatus(http.StatusOK).JSON(&body)
	return body.Users
}

func wrongCode(right string) string {
	wrong := []byte(right)
	if wrong[0] == '0' {
		wrong[0] = '1'
	} else {
		wrong[0] = '0'
	}
	return string(wrong)
}

func addressN(n int) string {
	return fmt.Sprintf("person%d@example.com", n)
}

func TestTheSessionCookieIsInvisibleToJavaScriptAndNotSentCrossSite(t *testing.T) {
	h := apitest.New(t)
	client := h.NewClient()
	requestCode(client, address).ExpectStatus(http.StatusOK)

	cookie := verify(client, address, h.LastCode(address)).
		ExpectStatus(http.StatusOK).
		Cookie("pomodorus_session")

	if !cookie.HttpOnly {
		t.Error("the cookie is readable by JavaScript")
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("SameSite is %v, want Lax", cookie.SameSite)
	}
	if cookie.Path != "/" {
		t.Errorf("Path is %q, want /", cookie.Path)
	}
	// Opaque: 32 random bytes, not a token anything can read a claim out of.
	if len(cookie.Value) < 32 {
		t.Errorf("the token is %d characters, which is not 32 random bytes", len(cookie.Value))
	}
}

func TestTheSessionCookieIsSecureWhereverTheConnectionIs(t *testing.T) {
	h := apitest.New(t, apitest.OverTLS())
	client := h.NewClient()
	requestCode(client, address).ExpectStatus(http.StatusOK)

	cookie := verify(client, address, h.LastCode(address)).
		ExpectStatus(http.StatusOK).
		Cookie("pomodorus_session")

	if !cookie.Secure {
		t.Error("the cookie is sent over TLS without Secure")
	}
}

func TestAForgedForwardedHeaderDoesNotDefeatThePerHostLimit(t *testing.T) {
	h := apitest.New(t)

	// Nothing is in front of this server, so the header is a header anybody
	// can send — and believing it would mean a caller who varies it per
	// request looks like a fresh host every time.
	for i := range auth.MaxCodesPerIP {
		h.Client.From(fmt.Sprintf("203.0.113.%d", i))
		if requestCode(h.Client, addressN(i/2)).Status != http.StatusOK {
			t.Fatalf("request %d was refused before the limit", i+1)
		}
	}
	h.Client.From("203.0.113.250")
	requestCode(h.Client, addressN(99)).ExpectError(http.StatusTooManyRequests, "rate_limited")
}

func TestBehindAProxyTheForwardedAddressIsWhatCounts(t *testing.T) {
	h := apitest.New(t, apitest.BehindProxy())

	// Every request arrives from the proxy's own socket, so without reading
	// the header every user behind it would share one limit.
	exhausted := h.NewClient().From("203.0.113.1")
	for i := range auth.MaxCodesPerIP {
		if requestCode(exhausted, addressN(i/2)).Status != http.StatusOK {
			t.Fatalf("request %d was refused before the limit", i+1)
		}
	}
	requestCode(exhausted, addressN(99)).ExpectError(http.StatusTooManyRequests, "rate_limited")

	// Somebody else behind the same proxy is unaffected.
	requestCode(h.NewClient().From("203.0.113.2"), addressN(99)).ExpectStatus(http.StatusOK)
}

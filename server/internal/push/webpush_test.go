package push

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// The encryption itself is the library's, and testing it here would be testing
// somebody else's code. What is worth pinning down is the wiring: that a real
// device's keys produce a request a push service would accept, and that the
// two status codes meaning "this endpoint is finished" become ErrGone while
// everything else stays a failure to shrug at.

// answering is an HTTP client that never leaves the process: it records the
// one request and replies with a status the test chose.
type answering struct {
	status int
	seen   *http.Request
	body   []byte
}

func (a *answering) Do(req *http.Request) (*http.Response, error) {
	a.seen = req
	if req.Body != nil {
		a.body, _ = io.ReadAll(req.Body)
	}
	return &http.Response{
		StatusCode: a.status,
		Status:     http.StatusText(a.status),
		Body:       io.NopCloser(strings.NewReader("")),
		Header:     http.Header{},
	}, nil
}

// device is a browser's half of the key agreement: a real P-256 public key and
// a real 16-byte secret, because the encryption will refuse anything else.
func device(t *testing.T) Subscription {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	return Subscription{
		Endpoint: "https://push.example/device",
		P256dh:   base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		Auth:     base64.RawURLEncoding.EncodeToString(secret),
	}
}

func sending(t *testing.T, status int) (*WebPush, *answering) {
	t.Helper()
	private, public, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	sender := NewWebPush(VAPID{
		Subject:    "mailto:someone@example.com",
		PublicKey:  public,
		PrivateKey: private,
	})
	service := &answering{status: status}
	sender.client = service
	return sender, service
}

func TestASentBellIsEncryptedAndSigned(t *testing.T) {
	sender, service := sending(t, http.StatusCreated)
	payload := []byte(`{"sessionId":"x","kind":"work","endsAt":1}`)

	if err := sender.Send(context.Background(), device(t), payload); err != nil {
		t.Fatalf("send: %v", err)
	}

	req := service.seen
	if req.URL.String() != "https://push.example/device" {
		t.Errorf("posted to %s", req.URL)
	}
	// RFC 8291's content coding, and RFC 8292's signature. A push service
	// rejects the request without either.
	if got := req.Header.Get("Content-Encoding"); got != "aes128gcm" {
		t.Errorf("Content-Encoding %q, want aes128gcm", got)
	}
	if got := req.Header.Get("Authorization"); !strings.HasPrefix(got, "vapid ") {
		t.Errorf("Authorization %q, want a vapid token", got)
	}
	// The bell decays fast, is the reason a phone is being woken at all, and
	// collapses onto the newest one when a device was unreachable through two.
	if got := req.Header.Get("TTL"); got != "300" {
		t.Errorf("TTL %q, want 300", got)
	}
	if got := req.Header.Get("Urgency"); got != "high" {
		t.Errorf("Urgency %q, want high", got)
	}
	if got := req.Header.Get("Topic"); got != "bell" {
		t.Errorf("Topic %q, want bell", got)
	}

	// The payload crosses encrypted. A push service can route this and read
	// none of it, which is the entire point of the key agreement above.
	if len(service.body) == 0 {
		t.Fatal("posted an empty body")
	}
	if strings.Contains(string(service.body), "sessionId") {
		t.Fatal("the payload crossed in the clear")
	}
}

func TestAFinishedEndpointIsGoneAndAnythingElseIsNot(t *testing.T) {
	// The two codes RFC 8030 gives for "this endpoint is finished" are the only
	// ones that mean delete the row rather than try again at the next bell.
	for _, status := range []int{http.StatusNotFound, http.StatusGone} {
		sender, _ := sending(t, status)
		err := sender.Send(context.Background(), device(t), []byte("{}"))
		if !errors.Is(err, ErrGone) {
			t.Errorf("%d gave %v, want ErrGone", status, err)
		}
	}

	for _, status := range []int{http.StatusTooManyRequests, http.StatusInternalServerError} {
		sender, _ := sending(t, status)
		err := sender.Send(context.Background(), device(t), []byte("{}"))
		if err == nil {
			t.Errorf("%d gave no error", status)
		}
		if errors.Is(err, ErrGone) {
			t.Errorf("%d was read as an expired subscription", status)
		}
	}
}

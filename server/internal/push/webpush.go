package push

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// VAPID identifies this server to the push services. The keypair is the app's
// permanent name to them: rotating it silently invalidates every subscription
// ever handed out, which is why it is configuration and not something minted
// at boot.
type VAPID struct {
	// Subject is the mailto: or https: URL a push service would use to reach
	// the operator. RFC 8292 requires one; nobody has ever used it.
	Subject    string
	PublicKey  string
	PrivateKey string
}

// WebPush is the Sender that actually encrypts and posts, per RFC 8291 for the
// payload and RFC 8292 for the signature.
//
// The encryption is the one piece of this app that is not written here. It is
// an ECDH agreement, an HKDF and an AES-GCM record layout, and a subtle error
// in any of them is a payload the browser silently discards — a library the
// rest of the world has already found the bugs in is worth more than the
// consistency of writing it again.
type WebPush struct {
	vapid VAPID
	// The HTTP client the library posts with. Typed as the library's own
	// interface rather than *http.Client so that a test can answer in-process
	// with a status of its choosing — there is no push service to talk to, and
	// the part worth pinning down is the request that would have gone out.
	client webpush.HTTPClient
}

func NewWebPush(vapid VAPID) *WebPush {
	return &WebPush{
		vapid: vapid,
		// Its own client rather than the default, so a push service that
		// accepts a connection and then says nothing cannot hold a goroutine
		// open indefinitely.
		client: &http.Client{Timeout: sendTimeout},
	}
}

// ttl is how long a push service may hold a bell for a device that is offline.
//
// Short on purpose. The notification says a pomodoro just ended, and the value
// of that claim decays fast: a phone that comes back online an hour later
// should find nothing waiting rather than an alarm about the middle of the
// afternoon. The ring itself is not lost by this — it is still on screen when
// the app is opened, because it was never the notification that held it.
const ttl = 5 * time.Minute

func (w *WebPush) Send(ctx context.Context, to Subscription, payload []byte) error {
	res, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: to.Endpoint,
		Keys:     webpush.Keys{P256dh: to.P256dh, Auth: to.Auth},
	}, &webpush.Options{
		HTTPClient:      w.client,
		Subscriber:      w.vapid.Subject,
		VAPIDPublicKey:  w.vapid.PublicKey,
		VAPIDPrivateKey: w.vapid.PrivateKey,
		TTL:             int(ttl.Seconds()),
		// The bell is the reason the phone is being woken at all, which is
		// what "high" means to a push service deciding whether to defer it.
		Urgency: webpush.UrgencyHigh,
		// One topic for every bell, so a device that was unreachable through
		// two of them is woken by the newer and never by both.
		Topic: "bell",
	})
	if err != nil {
		return err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}()

	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return nil
	case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone:
		// The two codes RFC 8030 gives for "this endpoint is finished". They
		// are the only ones that mean delete rather than shrug.
		return fmt.Errorf("%w: %s", ErrGone, res.Status)
	default:
		return fmt.Errorf("push service answered %s", res.Status)
	}
}

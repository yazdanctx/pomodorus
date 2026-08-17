package push_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/yazdanctx/pomodorus/server/internal/clock"
	"github.com/yazdanctx/pomodorus/server/internal/push"
)

var origin = time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC)

// book is the address book, in a map. The database's own version is exercised
// through the API tests; what is being asserted here is the timer's behaviour,
// and a map is the shortest way to see it.
type book struct {
	subs    map[uuid.UUID][]push.Subscription
	pending []push.Bell
	forgot  []string
	err     error
}

func (b *book) SubscriptionsFor(_ context.Context, userID uuid.UUID) ([]push.Subscription, error) {
	return b.subs[userID], b.err
}

func (b *book) Forget(_ context.Context, endpoint string) error {
	b.forgot = append(b.forgot, endpoint)
	for user, subs := range b.subs {
		kept := subs[:0]
		for _, sub := range subs {
			if sub.Endpoint != endpoint {
				kept = append(kept, sub)
			}
		}
		b.subs[user] = kept
	}
	return nil
}

func (b *book) Pending(_ context.Context, after time.Time) ([]push.Bell, error) {
	var ahead []push.Bell
	for _, bell := range b.pending {
		if bell.At.After(after) {
			ahead = append(ahead, bell)
		}
	}
	return ahead, nil
}

type rig struct {
	notifier *push.Notifier
	clock    *clock.Fixed
	delay    *push.Manual
	sender   *push.Memory
	store    *book
}

func newRig(t *testing.T) *rig {
	t.Helper()
	fixed := clock.NewFixed(origin)
	r := &rig{
		clock:  fixed,
		delay:  push.NewManual(fixed),
		sender: push.NewMemory(),
		store:  &book{subs: make(map[uuid.UUID][]push.Subscription)},
	}
	r.notifier = push.New(push.Deps{
		Store:  r.store,
		Sender: r.sender,
		Delay:  r.delay,
		Clock:  fixed,
	})
	t.Cleanup(r.notifier.Close)
	return r
}

// reach moves the clock and rings whatever it has reached, which is what a
// person waiting out a pomodoro does to it.
func (r *rig) reach(d time.Duration) {
	r.clock.Advance(d)
	r.delay.Due()
}

func bell(user uuid.UUID, at time.Time) push.Bell {
	return push.Bell{SessionID: uuid.New(), UserID: user, Kind: "work", At: at}
}

func device(name string) push.Subscription {
	return push.Subscription{Endpoint: "https://push.example/" + name, P256dh: "p", Auth: "a"}
}

func TestArmedBellReachesEveryDevice(t *testing.T) {
	r := newRig(t)
	user := uuid.New()
	r.store.subs[user] = []push.Subscription{device("phone"), device("laptop")}

	r.notifier.Arm(bell(user, origin.Add(25*time.Minute)))

	r.reach(24 * time.Minute)
	if got := len(r.sender.Sent()); got != 0 {
		t.Fatalf("sent %d before the bell, want none", got)
	}

	r.reach(time.Minute)
	sent := r.sender.Sent()
	if len(sent) != 2 {
		t.Fatalf("sent %d at the bell, want one per device", len(sent))
	}
	if sent[0].To.Endpoint == sent[1].To.Endpoint {
		t.Fatalf("both went to %s", sent[0].To.Endpoint)
	}
}

func TestPayloadNamesTheRingAndCarriesNoWords(t *testing.T) {
	r := newRig(t)
	user := uuid.New()
	r.store.subs[user] = []push.Subscription{device("phone")}

	ends := origin.Add(5 * time.Minute)
	b := push.Bell{SessionID: uuid.New(), UserID: user, Kind: "shortBreak", At: ends}
	r.notifier.Arm(b)
	r.reach(5 * time.Minute)

	sent := r.sender.Sent()
	if len(sent) != 1 {
		t.Fatalf("sent %d, want 1", len(sent))
	}
	var got map[string]any
	if err := json.Unmarshal(sent[0].Payload, &got); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	if got["kind"] != "shortBreak" {
		t.Errorf("kind %v, want shortBreak", got["kind"])
	}
	if got["sessionId"] != b.SessionID.String() {
		t.Errorf("sessionId %v, want %s", got["sessionId"], b.SessionID)
	}
	// The words are the client's — a title here would be a second home for copy
	// — and there is no instant, because nothing on the far side derives
	// anything from one.
	for _, key := range []string{"title", "body", "endsAt"} {
		if _, ok := got[key]; ok {
			t.Errorf("payload carries %q, which nothing on the far side reads", key)
		}
	}
}

func TestDisarmedBellNeverRings(t *testing.T) {
	r := newRig(t)
	user := uuid.New()
	r.store.subs[user] = []push.Subscription{device("phone")}

	b := bell(user, origin.Add(25*time.Minute))
	r.notifier.Arm(b)
	r.notifier.Disarm(b.SessionID)

	r.reach(30 * time.Minute)
	if got := len(r.sender.Sent()); got != 0 {
		t.Fatalf("sent %d after cancelling, want none", got)
	}
	if got := r.notifier.Pending(); got != 0 {
		t.Fatalf("%d still armed, want none", got)
	}
}

func TestRearmingReplacesRatherThanAdds(t *testing.T) {
	r := newRig(t)
	user := uuid.New()
	r.store.subs[user] = []push.Subscription{device("phone")}

	b := bell(user, origin.Add(25*time.Minute))
	r.notifier.Arm(b)
	r.notifier.Arm(b)

	r.reach(25 * time.Minute)
	if got := len(r.sender.Sent()); got != 1 {
		t.Fatalf("sent %d, want exactly one per bell", got)
	}
}

func TestAGoneSubscriptionIsForgottenRatherThanRetried(t *testing.T) {
	r := newRig(t)
	user := uuid.New()
	dead, alive := device("dead"), device("alive")
	r.store.subs[user] = []push.Subscription{dead, alive}
	r.sender.Gone(dead.Endpoint)

	r.notifier.Arm(bell(user, origin.Add(time.Minute)))
	r.reach(time.Minute)

	if len(r.store.forgot) != 1 || r.store.forgot[0] != dead.Endpoint {
		t.Fatalf("forgot %v, want [%s]", r.store.forgot, dead.Endpoint)
	}
	// The device beside it still heard about the bell.
	if sent := r.sender.Sent(); len(sent) != 1 || sent[0].To.Endpoint != alive.Endpoint {
		t.Fatalf("delivered %v, want one to %s", sent, alive.Endpoint)
	}

	// And the next bell does not try the dead one again.
	r.notifier.Arm(bell(user, r.clock.Now().Add(time.Minute)))
	r.reach(time.Minute)
	if got := len(r.store.forgot); got != 1 {
		t.Fatalf("forgot %d times, want the endpoint dropped after the first", got)
	}
}

func TestAFailedSendIsNotADeadSubscription(t *testing.T) {
	r := newRig(t)
	user := uuid.New()
	r.store.subs[user] = []push.Subscription{device("phone")}
	r.sender.Fail(errors.New("push service unreachable"))

	r.notifier.Arm(bell(user, origin.Add(time.Minute)))
	r.reach(time.Minute)

	if len(r.store.forgot) != 0 {
		t.Fatalf("forgot %v; an unreachable service is not an expired device", r.store.forgot)
	}
}

func TestRestoreArmsOnlyBellsStillAhead(t *testing.T) {
	r := newRig(t)
	user := uuid.New()
	r.store.subs[user] = []push.Subscription{device("phone")}

	ahead := bell(user, origin.Add(10*time.Minute))
	missed := bell(user, origin.Add(-time.Minute))
	r.store.pending = []push.Bell{missed, ahead}

	if err := r.notifier.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := r.notifier.Pending(); got != 1 {
		t.Fatalf("armed %d, want only the bell that has not gone", got)
	}

	r.reach(10 * time.Minute)
	sent := r.sender.Sent()
	if len(sent) != 1 {
		t.Fatalf("sent %d, want 1", len(sent))
	}
	var got bellPayloadShape
	if err := json.Unmarshal(sent[0].Payload, &got); err != nil {
		t.Fatal(err)
	}
	if got.SessionID != ahead.SessionID.String() {
		t.Errorf("rang for %s, want %s", got.SessionID, ahead.SessionID)
	}
}

type bellPayloadShape struct {
	SessionID string `json:"sessionId"`
}

func TestABellInThePastIsDroppedRatherThanFiredLate(t *testing.T) {
	r := newRig(t)
	user := uuid.New()
	r.store.subs[user] = []push.Subscription{device("phone")}

	r.notifier.Arm(bell(user, origin.Add(-time.Second)))

	r.delay.Due()
	if got := len(r.sender.Sent()); got != 0 {
		t.Fatalf("sent %d for a bell that already went, want none", got)
	}
}

func TestArmingAndCancellingAtOnceIsSafe(t *testing.T) {
	// A pomodoro started on a phone and abandoned on a laptop is two requests
	// on two goroutines, and they can land in either order or at once. Run
	// under -race, this is what says the pending bells are actually guarded:
	// an entry published before its cancel was assigned would be a Disarm with
	// nothing to stop, and a session that pushes after it was abandoned.
	r := newRig(t)
	user := uuid.New()
	r.store.subs[user] = []push.Subscription{device("phone")}

	b := bell(user, origin.Add(25*time.Minute))
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(2)
		go func() { defer wg.Done(); r.notifier.Arm(b) }()
		go func() { defer wg.Done(); r.notifier.Disarm(b.SessionID) }()
	}
	wg.Wait()

	// However they interleaved, one last word settles it.
	r.notifier.Disarm(b.SessionID)
	r.reach(30 * time.Minute)
	if got := len(r.sender.Sent()); got != 0 {
		t.Fatalf("sent %d after the last word was cancel, want none", got)
	}
}

func TestADisabledNotifierIsSilentRatherThanFatal(t *testing.T) {
	// What the app runs as with no VAPID keys configured. Every call site is
	// unconditional, so nil has to behave.
	var off *push.Notifier
	off.Arm(bell(uuid.New(), origin.Add(time.Minute)))
	off.Disarm(uuid.New())
	off.Close()
	if err := off.Restore(context.Background()); err != nil {
		t.Fatalf("restore on a disabled notifier: %v", err)
	}
	if got := off.Pending(); got != 0 {
		t.Fatalf("pending %d, want 0", got)
	}
}

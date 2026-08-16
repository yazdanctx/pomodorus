package live_test

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/live"
)

func TestEveryListenerOnATopicIsReached(t *testing.T) {
	hub := live.NewHub()
	ctx := context.Background()

	phone, stopPhone, err := hub.Subscribe(ctx, "yazdan")
	if err != nil {
		t.Fatal(err)
	}
	defer stopPhone()
	laptop, stopLaptop, err := hub.Subscribe(ctx, "yazdan")
	if err != nil {
		t.Fatal(err)
	}
	defer stopLaptop()

	if err := hub.Publish(ctx, "yazdan", []byte("started")); err != nil {
		t.Fatal(err)
	}

	if got := next(t, phone); got != "started" {
		t.Fatalf("phone read %q", got)
	}
	if got := next(t, laptop); got != "started" {
		t.Fatalf("laptop read %q", got)
	}
}

// The one guarantee that is not about delivery but about privacy: a topic is a
// person, and nothing crosses between them.
func TestATopicNeverReachesAnother(t *testing.T) {
	hub := live.NewHub()
	ctx := context.Background()

	mine, stop, err := hub.Subscribe(ctx, "yazdan")
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	if err := hub.Publish(ctx, "somebody-else", []byte("started")); err != nil {
		t.Fatal(err)
	}
	expectNothing(t, mine)
}

// Publishing into the void is not an error. Nobody is listening most of the
// time, and a handler must not have to know that.
func TestPublishingToAnEmptyTopicSucceeds(t *testing.T) {
	if err := live.NewHub().Publish(context.Background(), "nobody", []byte("started")); err != nil {
		t.Fatal(err)
	}
}

func TestUnsubscribingStopsDelivery(t *testing.T) {
	hub := live.NewHub()
	ctx := context.Background()

	ch, stop, err := hub.Subscribe(ctx, "yazdan")
	if err != nil {
		t.Fatal(err)
	}
	stop()

	if err := hub.Publish(ctx, "yazdan", []byte("started")); err != nil {
		t.Fatal(err)
	}
	// The channel is closed rather than merely quiet, so a reader still in its
	// loop finds out instead of waiting forever.
	if payload, open := <-ch; open {
		t.Fatalf("read %q from a closed subscription", payload)
	}
}

// A socket that hangs up mid-write unsubscribes twice in the ordinary case —
// once from its own defer, once from the loop that noticed. Neither may panic.
func TestUnsubscribingTwiceIsSafe(t *testing.T) {
	hub := live.NewHub()
	_, stop, err := hub.Subscribe(context.Background(), "yazdan")
	if err != nil {
		t.Fatal(err)
	}
	stop()
	stop()
}

// The property that matters when a device stops reading: the publisher is a
// request handler, and it must return regardless.
func TestASlowListenerNeverBlocksAPublisher(t *testing.T) {
	hub := live.NewHub()
	ctx := context.Background()

	slow, stop, err := hub.Subscribe(ctx, "yazdan")
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range 1000 {
			_ = hub.Publish(ctx, "yazdan", []byte(strconv.Itoa(i)))
		}
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a listener that stopped reading blocked the publisher")
	}

	// And what it does eventually read is recent, because the backlog was
	// dropped from the front: an old whole-state frame delivered after a newer
	// one would put a screen back in time.
	last, err := strconv.Atoi(next(t, slow))
	if err != nil {
		t.Fatal(err)
	}
	if last < 1000-cap(slow) {
		t.Fatalf("read %d first, which is older than the backlog it should have dropped", last)
	}
}

// The hub is written from request handlers and read from socket goroutines at
// once; this is the test that says so under -race.
func TestConcurrentUse(t *testing.T) {
	hub := live.NewHub()
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			topic := strconv.Itoa(i % 4)
			ch, stop, err := hub.Subscribe(ctx, topic)
			if err != nil {
				t.Error(err)
				return
			}
			defer stop()
			go func() {
				for range ch {
				}
			}()
			for range 100 {
				_ = hub.Publish(ctx, topic, []byte("changed"))
			}
		}()
	}
	wg.Wait()
}

func next(t *testing.T, ch <-chan []byte) string {
	t.Helper()
	select {
	case payload, open := <-ch:
		if !open {
			t.Fatal("subscription closed")
		}
		return string(payload)
	case <-time.After(time.Second):
		t.Fatal("nothing was delivered")
		return ""
	}
}

func expectNothing(t *testing.T, ch <-chan []byte) {
	t.Helper()
	select {
	case payload := <-ch:
		t.Fatalf("delivered %q, and should have delivered nothing", payload)
	case <-time.After(50 * time.Millisecond):
	}
}

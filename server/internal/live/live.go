// Package live is the fan-out behind the socket: one topic per person, and a
// fact pushed to whoever is listening on it.
//
// It knows nothing about timers, sessions or JSON. What crosses it is an
// already-encoded frame and the name of the topic it belongs to, which is what
// keeps the hub swappable — a second instance would be served by Postgres
// LISTEN/NOTIFY, and the callers on either side would not change.
//
// Nothing here is a request. The socket only pushes facts; every mutation is
// an ordinary POST, so there is no correlation id, no reply channel and no
// error semantics to carry.
package live

import (
	"context"
	"sync"
)

// Broadcaster is fan-out, as its callers see it.
//
// Both methods take a context and return an error not because the in-process
// hub needs either — it needs neither — but because the implementation that
// replaces it does I/O, and an interface that cannot express a failed publish
// is an interface that has to be widened later, at every call site.
type Broadcaster interface {
	// Publish pushes a payload to everyone listening on a topic. It is
	// deliberately unable to block: a listener that has stopped reading must
	// not be able to hold up the request that is publishing.
	Publish(ctx context.Context, topic string, payload []byte) error

	// Subscribe returns the channel a listener reads and the function that
	// stops it listening. The channel is closed by that function and by
	// nothing else, so a reader that has cancelled cannot then block forever.
	Subscribe(ctx context.Context, topic string) (<-chan []byte, func(), error)
}

// Hub is the in-process Broadcaster: a map of topics to the listeners on them.
// One instance of the server needs nothing more.
type Hub struct {
	mu     sync.Mutex
	topics map[string]map[*listener]struct{}
}

func NewHub() *Hub {
	return &Hub{topics: make(map[string]map[*listener]struct{})}
}

// depth is how far behind a listener may fall before the hub starts throwing
// its backlog away. Small on purpose: every payload is a whole state rather
// than a delta, so a queue of them is a queue of stale answers, and the only
// one worth delivering is the last.
const depth = 8

type listener struct {
	ch chan []byte
	// Guards against a second call to the unsubscribe function closing an
	// already-closed channel.
	once sync.Once
}

func (h *Hub) Publish(_ context.Context, topic string, payload []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	for l := range h.topics[topic] {
		select {
		case l.ch <- payload:
		default:
			// This listener is not keeping up. Drop its oldest frame to make
			// room for this one rather than dropping this one: the payload is
			// the whole of the timer state, so the newest is the only one that
			// is still true, and an older frame delivered after it would be a
			// screen going backwards.
			select {
			case <-l.ch:
			default:
			}
			select {
			case l.ch <- payload:
			default:
			}
		}
	}
	return nil
}

func (h *Hub) Subscribe(_ context.Context, topic string) (<-chan []byte, func(), error) {
	l := &listener{ch: make(chan []byte, depth)}

	h.mu.Lock()
	if h.topics[topic] == nil {
		h.topics[topic] = make(map[*listener]struct{})
	}
	h.topics[topic][l] = struct{}{}
	h.mu.Unlock()

	return l.ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if listeners, ok := h.topics[topic]; ok {
			delete(listeners, l)
			// An empty topic is deleted rather than left behind, so a long
			// uptime does not accumulate one entry per person who has ever
			// opened a tab.
			if len(listeners) == 0 {
				delete(h.topics, topic)
			}
		}
		// Closed under the same lock that removed it from the topic, so no
		// publish can still be holding a reference to it and send on a closed
		// channel.
		l.once.Do(func() { close(l.ch) })
	}, nil
}

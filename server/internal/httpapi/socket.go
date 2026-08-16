package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/yazdanctx/pomodorus/server/internal/auth"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// The socket exists so that one timer can follow a person between devices.
//
// It carries facts in one direction and nothing in the other. Every mutation
// is still an ordinary POST with a client-minted id and a real status code, so
// there is nothing here that needs a correlation id, a timeout or an error to
// report — anything arriving from a client is read and discarded.
//
// What it pushes is the whole timer state rather than a nudge to go and ask.
// That is one round trip fewer at the moment both screens have to agree, and
// it makes a frame self-sufficient: it carries the server's `now` like every
// other answer, and every instant on it is absolute, so a frame that arrives
// late still says the same thing.

// frame is one pushed fact, named. Two kinds share this socket: your own timer,
// which only you receive, and the feed, which everybody does.
type frame struct {
	Type  string           `json:"type"`
	Timer *sessionResponse `json:"timer,omitempty"`
	Feed  *feedResponse    `json:"feed,omitempty"`
}

// timerChanged is "your timer changed" — started, cancelled, acknowledged, or
// running under edited intervals.
const timerChanged = "timer"

// socketWrite is how long a single frame may take to reach a device before
// that device is considered gone. Generous, because a phone on a bad connection
// is not a phone that should be hung up on; finite, because a socket blocked
// forever is a goroutine and a subscription that never come back.
const socketWrite = 10 * time.Second

// DefaultSocketPing is the keepalive interval. The hosting proxy drops idle
// sockets, and a timer that runs for twenty-five minutes without a word is
// exactly the traffic pattern it drops.
const DefaultSocketPing = 30 * time.Second

// topicFor is the person a fact belongs to. One topic per user is the whole of
// the delivery rule: you receive your own timer's changes and nobody else's.
func topicFor(user db.User) string {
	return uuid.UUID(user.ID.Bytes).String()
}

func (s *Server) socket(w http.ResponseWriter, r *http.Request) {
	// Who this is, if anybody.
	//
	// A visitor is welcome here: the feed is the public front door and has to
	// update live for somebody who has never signed in. So an unauthenticated
	// upgrade is accepted rather than refused, and simply hears less — which is
	// the whole of the rule below, expressed as which topics get subscribed to.
	//
	// Identity, when there is one, comes from the session cookie the browser
	// attaches to the upgrade by itself. A token in the query string would be
	// the same credential written into proxy logs, browser history and
	// referrers, which is why the session is a cookie at all.
	user, signedIn := s.currentUser(r)

	// Kept, because a socket outlives the request that opened it. An HTTP
	// handler re-reads the cookie every time and so cannot serve a withdrawn
	// session by more than one request; a socket held open for hours would
	// otherwise go on pushing this person's timer long after they signed out,
	// which is the one thing a revocable session is meant not to allow.
	var token string
	if signedIn {
		cookie, err := r.Cookie(sessionCookie)
		if err != nil {
			// currentUser resolved it, so this cannot happen — and if it
			// somehow did, the safe reading is "nobody".
			signedIn = false
		} else {
			token = cookie.Value
		}
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: s.socketOrigins(),
	})
	if err != nil {
		// Accept has already answered with the reason. A refused upgrade is a
		// client-side fact, not a server fault.
		s.log.Info("socket: upgrade refused", "error", err)
		return
	}
	defer conn.CloseNow()

	// Subscribed before the current state is read, so a change that lands
	// between the two is delivered rather than falling down the gap. The
	// duplicate that this can produce — the same state read and then pushed —
	// costs a frame, and a frame is idempotent.
	//
	// Everybody watches the feed, because everybody may.
	feed, unfeed, err := s.live.Subscribe(r.Context(), feedTopic)
	if err != nil {
		s.log.Error("socket: subscribe", "error", err)
		_ = conn.Close(websocket.StatusInternalError, "subscribe failed")
		return
	}
	defer unfeed()

	// Only you watch your own timer. A visitor subscribes to no user's topic at
	// all, which is a stronger guarantee than filtering on the way out: there
	// is no channel for a timer frame to arrive on, so no bug downstream can
	// put one there. `timers` stays nil for them, and a receive from a nil
	// channel blocks forever — so that arm of the select below is simply never
	// chosen.
	var timers <-chan []byte
	if signedIn {
		mine, unsubscribe, err := s.live.Subscribe(r.Context(), topicFor(user))
		if err != nil {
			s.log.Error("socket: subscribe", "error", err)
			_ = conn.Close(websocket.StatusInternalError, "subscribe failed")
			return
		}
		defer unsubscribe()
		timers = mine
	}

	// Nothing sent up this socket is a request. The read side exists only to
	// answer pings, notice a close and enforce the read limit; CloseRead does
	// all three and hands back a context that is cancelled when the connection
	// dies, which is what ends the loop below.
	ctx := conn.CloseRead(r.Context())

	// The opening frames are the resynchronisation. A page that has just
	// loaded, and one whose socket dropped in a tunnel and came back, are the
	// same case: neither knows anything, and neither should have to ask over
	// HTTP to find out.
	if payload, err := s.feedFrame(ctx); err != nil {
		s.log.Error("socket: read feed", "error", err)
		_ = conn.Close(websocket.StatusInternalError, "read failed")
		return
	} else if !send(ctx, conn, payload) {
		return
	}
	if signedIn {
		if payload, err := s.timerFrame(ctx, user); err != nil {
			s.log.Error("socket: read timer", "error", err)
			_ = conn.Close(websocket.StatusInternalError, "read failed")
			return
		} else if !send(ctx, conn, payload) {
			return
		}
	}

	keepalive := time.NewTicker(s.socketPing)
	defer keepalive.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case payload, open := <-feed:
			if !open {
				return
			}
			if !send(ctx, conn, payload) {
				return
			}
		case payload, open := <-timers:
			if !open {
				return
			}
			if !send(ctx, conn, payload) {
				return
			}
		case <-keepalive.C:
			// A ping that goes unanswered for a whole interval is a socket
			// that is gone whatever the operating system still believes.
			ping, cancel := context.WithTimeout(ctx, s.socketPing)
			err := conn.Ping(ping)
			cancel()
			if err != nil {
				return
			}
			// The same beat is where the session is checked again. Signing out
			// on this device, or anywhere else, hangs the socket up within one
			// interval rather than whenever the connection happens to break —
			// one indexed read per socket per interval, which is the price of
			// "revocable instantly" meaning it here too.
			//
			// A visitor has nothing to revoke, and asking the database about
			// them every interval would be a query per idle landing page.
			if signedIn && !s.stillSignedIn(ctx, token) {
				_ = conn.Close(websocket.StatusPolicyViolation, "signed out")
				return
			}
		}
	}
}

// socketOrigins is which origins may open a socket.
//
// Empty in production, which is the library's default: same origin only, since
// the binary serves the client itself and there is no second origin the app is
// ever reached from. In development Vite serves the client on its own port and
// proxies the upgrade here, so the browser's Origin is Vite's — and refusing it
// would mean the socket only ever worked in the built binary.
func (s *Server) socketOrigins() []string {
	if !s.cfg.IsDev() {
		return nil
	}
	return []string{"localhost:5174", "127.0.0.1:5174"}
}

// stillSignedIn asks whether the session this socket was opened on is still
// good. A database that cannot be reached answers yes: an outage is not a
// reason to hang up on everybody, and the socket only ever pushes what this
// person could read over HTTP anyway.
func (s *Server) stillSignedIn(ctx context.Context, token string) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := s.auth.User(ctx, token)
	if errors.Is(err, auth.ErrNoSession) {
		return false
	}
	if err != nil {
		s.log.Error("socket: resolve session", "error", err)
	}
	return true
}

// timerFrame reads what the timer is and encodes it as a pushed fact.
func (s *Server) timerFrame(ctx context.Context, user db.User) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	state, err := s.timerState(ctx, s.q, user, s.now())
	if err != nil {
		return nil, err
	}
	return encodeTimer(state)
}

func encodeTimer(state sessionResponse) ([]byte, error) {
	return json.Marshal(frame{Type: timerChanged, Timer: &state})
}

// feedFrame reads who is working and encodes it as a pushed fact.
func (s *Server) feedFrame(ctx context.Context) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	state, err := s.feed(ctx, s.now())
	if err != nil {
		return nil, err
	}
	return json.Marshal(frame{Type: feedChanged, Feed: &state})
}

// publishTimer pushes a timer that has just changed to the person's other
// devices — and, harmlessly, back to the one that changed it, which has the
// same state in its own response and applies it a second time to no effect.
//
// Best-effort by construction: the write already landed and the caller has
// already been answered, so a fan-out that fails costs a device one prompt
// update, never correctness. The countdown is computed from the session's own
// facts, and the next visible tab asks again anyway.
func (s *Server) publishTimer(ctx context.Context, user db.User, state sessionResponse) {
	payload, err := encodeTimer(state)
	if err != nil {
		s.log.Error("encode timer frame", "error", err)
		return
	}
	// Detached from the request's cancellation: the caller is being answered
	// right now, and their disconnecting is no reason for the other device not
	// to hear about it.
	if err := s.live.Publish(context.WithoutCancel(ctx), topicFor(user), payload); err != nil {
		s.log.Error("publish timer", "error", err)
	}
}

// send writes one frame, and reports whether the socket is still worth holding.
func send(ctx context.Context, conn *websocket.Conn, payload []byte) bool {
	ctx, cancel := context.WithTimeout(ctx, socketWrite)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, payload) == nil
}

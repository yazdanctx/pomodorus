package apitest

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// waitFor is how long a test will wait for a frame that should already be on
// its way. Long enough that a loaded machine does not fail the build, short
// enough that a genuine silence is not the whole test suite's problem.
const waitFor = 3 * time.Second

// quiet is how long a test watches to be sure nothing arrives. A frame that
// was going to be delivered was delivered by an in-process hub in microseconds.
const quiet = 150 * time.Millisecond

// Socket is a device holding a live connection.
//
// It carries the client's cookie jar, so the upgrade authenticates exactly as
// a browser's would — with the session cookie and nothing in the URL. It sends
// nothing, because the socket carries no requests: a test that wants to change
// the timer posts, like the app does.
type Socket struct {
	t      *testing.T
	conn   *websocket.Conn
	frames chan Frame
	cancel context.CancelFunc
}

// Frame is one pushed fact.
type Frame struct {
	t *testing.T
	// Type names what changed — "timer" so far.
	Type string
	// Timer is the timer state the frame carried, still encoded. Tests decode
	// it into their own shape, so this package never has to know one.
	Timer json.RawMessage
}

// Socket opens a connection as this device. It is closed when the test ends.
func (c *Client) Socket() *Socket {
	c.t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	dial, cancelDial := context.WithTimeout(ctx, waitFor)
	defer cancelDial()

	conn, _, err := websocket.Dial(dial, socketURL(c.base), &websocket.DialOptions{
		// The client's own, so the jar and — over TLS — the trust of the test
		// server's certificate both come along.
		HTTPClient: c.http,
	})
	if err != nil {
		cancel()
		c.t.Fatalf("open socket: %v", err)
	}

	s := &Socket{t: c.t, conn: conn, frames: make(chan Frame, 16), cancel: cancel}

	// Read in the background rather than on demand, because a test also has to
	// be able to assert that nothing arrived — and a read given a deadline
	// takes the connection down with it when that deadline passes.
	go func() {
		defer close(s.frames)
		for {
			_, payload, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var decoded struct {
				Type  string          `json:"type"`
				Timer json.RawMessage `json:"timer"`
			}
			if err := json.Unmarshal(payload, &decoded); err != nil {
				return
			}
			select {
			case s.frames <- Frame{t: c.t, Type: decoded.Type, Timer: decoded.Timer}:
			case <-ctx.Done():
				return
			}
		}
	}()

	c.t.Cleanup(s.Close)
	return s
}

// SocketRefused opens a connection expecting to be turned away, and returns
// the status the server answered the upgrade with.
//
// An origin may be given, which is how a page on another site asking for this
// person's timer is expressed: the browser would attach the cookie and say
// where the page came from, and the server has only the second of those to go
// on.
func (c *Client) SocketRefused(origin ...string) int {
	c.t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()

	headers := http.Header{}
	for _, from := range origin {
		headers.Set("Origin", from)
	}

	conn, res, err := websocket.Dial(ctx, socketURL(c.base), &websocket.DialOptions{
		HTTPClient: c.http,
		HTTPHeader: headers,
	})
	if err == nil {
		_ = conn.CloseNow()
		c.t.Fatal("the socket opened, and should have been refused")
	}
	if res == nil {
		c.t.Fatalf("the upgrade failed without an answer: %v", err)
	}
	return res.StatusCode
}

// Next waits for the next frame.
func (s *Socket) Next() Frame {
	s.t.Helper()
	select {
	case frame, open := <-s.frames:
		if !open {
			s.t.Fatal("the socket closed while a frame was expected")
		}
		return frame
	case <-time.After(waitFor):
		s.t.Fatal("no frame arrived")
		return Frame{}
	}
}

// NextTimer waits for the next frame and decodes the timer state it carried.
func (s *Socket) NextTimer(into any) {
	s.t.Helper()
	frame := s.Next()
	if frame.Type != "timer" {
		s.t.Fatalf("frame is %q, want %q", frame.Type, "timer")
	}
	frame.JSON(into)
}

// JSON decodes the frame's timer state.
func (f Frame) JSON(into any) {
	f.t.Helper()
	if err := json.Unmarshal(f.Timer, into); err != nil {
		f.t.Fatalf("frame carries no timer state: %v — %s", err, f.Timer)
	}
}

// ExpectNothing asserts that no frame arrives. This is how "a user only ever
// receives their own timer's changes" is stated: somebody else's whole gesture
// happens, and this socket stays silent.
func (s *Socket) ExpectNothing() {
	s.t.Helper()
	select {
	case frame, open := <-s.frames:
		if !open {
			s.t.Fatal("the socket closed, and should have stayed open and quiet")
		}
		s.t.Fatalf("a %q frame arrived, and nothing should have: %s", frame.Type, frame.Timer)
	case <-time.After(quiet):
	}
}

// ExpectClosed asserts that the server hung up, within a window the caller
// chooses. It is the only assertion here that reads the *absence* of a
// connection rather than the frames on one.
func (s *Socket) ExpectClosed(within time.Duration) {
	s.t.Helper()
	deadline := time.After(within)
	for {
		select {
		case _, open := <-s.frames:
			if !open {
				return
			}
			// A frame that arrived first is not a failure; keep watching.
		case <-deadline:
			s.t.Fatal("the socket is still open, and the server should have hung up")
		}
	}
}

// Close hangs up, the way closing a tab does.
func (s *Socket) Close() {
	_ = s.conn.CloseNow()
	s.cancel()
}

// SilentSocket is a device that stops answering: it holds the connection open
// at the operating system's level and never replies to a ping, which is what a
// laptop whose lid closed mid-tunnel looks like from the server.
//
// It reads nothing in the background on purpose. Reading is what sends a pong,
// so a socket that is being read is a socket that can never demonstrate the
// keepalive noticing anything.
type SilentSocket struct {
	t    *testing.T
	conn *websocket.Conn
}

// SilentSocket opens one, and reads the frame it opens onto so that the test
// starts from the same place every other one does.
func (c *Client) SilentSocket() *SilentSocket {
	c.t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, socketURL(c.base), &websocket.DialOptions{HTTPClient: c.http})
	if err != nil {
		c.t.Fatalf("open socket: %v", err)
	}
	if _, _, err := conn.Read(ctx); err != nil {
		c.t.Fatalf("read the opening frame: %v", err)
	}

	s := &SilentSocket{t: c.t, conn: conn}
	c.t.Cleanup(func() { _ = conn.CloseNow() })
	return s
}

// ExpectDropped asserts that the server gave up on a device that stopped
// answering. It reads only once it is done being silent, so the read reports
// what the keepalive already decided.
//
// A failed read is not on its own the evidence, which is the trap here: a read
// that simply waited and timed out fails in exactly the same way as one on a
// connection that was hung up. What tells them apart is how long it took — a
// dead connection reports at once, and a live one has to be given up on.
func (s *SilentSocket) ExpectDropped(after time.Duration) {
	s.t.Helper()
	time.Sleep(after)

	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()

	began := time.Now()
	_, payload, err := s.conn.Read(ctx)
	took := time.Since(began)

	if err == nil {
		s.t.Fatalf("the socket is still open after %s of silence, and delivered %s", after, payload)
	}
	if took > waitFor/4 {
		s.t.Fatalf("the socket was still open after %s of silence: reading it waited %s "+
			"to be given up on rather than reporting a connection that was already gone",
			after, took.Round(time.Millisecond))
	}
}

// socketURL is the same origin the client posts to, reached over the socket
// scheme — which is what keeps the cookie in play.
func socketURL(base string) string {
	if after, found := strings.CutPrefix(base, "https://"); found {
		return "wss://" + after + "/ws"
	}
	return "ws://" + strings.TrimPrefix(base, "http://") + "/ws"
}

// Package httpapi wires the HTTP surface: the JSON API, and behind it the
// embedded client.
//
// Every mutation is an ordinary POST with a real status code. Nothing here is
// RPC over a socket — the socket, when it arrives, only pushes facts.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yazdanctx/pomodorus/server/internal/auth"
	"github.com/yazdanctx/pomodorus/server/internal/clock"
	"github.com/yazdanctx/pomodorus/server/internal/config"
	"github.com/yazdanctx/pomodorus/server/internal/live"
	"github.com/yazdanctx/pomodorus/server/internal/mail"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
	"github.com/yazdanctx/pomodorus/server/internal/web"
)

// Deps is everything the server does not construct for itself. The clock and
// the mailer are here so that a test can drive both: advancing the clock is
// what makes the timer testable instantly, and an in-memory mailer is what
// makes the login flow readable end to end.
type Deps struct {
	Config config.Config
	DB     *pgxpool.Pool
	Log    *slog.Logger
	Clock  clock.Clock
	Mailer mail.Mailer

	// Live is fan-out to the sockets. It defaults to the in-process hub, which
	// is all a single instance needs; this field is the seam a second instance
	// would swap for Postgres LISTEN/NOTIFY, and the handlers would not notice.
	Live live.Broadcaster

	// Client is the built React client, defaulting to the one embedded in the
	// binary. It is a seam so that a test can stand up a shell and assert on
	// the HTML this server actually serves — in development it is empty and
	// Vite serves the client itself.
	Client fs.FS

	// SocketPing is the keepalive interval, defaulting to DefaultSocketPing. It
	// is real time rather than the injected clock — it is a fact about the
	// network and the proxy in front of it, not about the timer — so a test
	// that wants to watch a socket idle turns it down instead of moving a clock.
	SocketPing time.Duration
}

type Server struct {
	cfg        config.Config
	db         *pgxpool.Pool
	q          *db.Queries
	log        *slog.Logger
	clock      clock.Clock
	auth       *auth.Service
	live       live.Broadcaster
	socketPing time.Duration
	client     fs.FS
	mux        *http.ServeMux
}

func New(deps Deps) *Server {
	queries := db.New(deps.DB)
	s := &Server{
		cfg:        deps.Config,
		db:         deps.DB,
		q:          queries,
		log:        deps.Log,
		clock:      deps.Clock,
		auth:       auth.NewService(queries, deps.Clock, deps.Mailer),
		live:       deps.Live,
		socketPing: deps.SocketPing,
		client:     deps.Client,
		mux:        http.NewServeMux(),
	}
	if s.live == nil {
		s.live = live.NewHub()
	}
	if s.socketPing <= 0 {
		s.socketPing = DefaultSocketPing
	}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", s.health)

	s.mux.HandleFunc("POST /api/auth/request-code", s.requestCode)
	s.mux.HandleFunc("POST /api/auth/verify", s.verifyCode)
	s.mux.HandleFunc("POST /api/auth/sign-out", s.signOut)
	s.mux.HandleFunc("GET /api/me", s.me)
	s.mux.HandleFunc("POST /api/handle", s.claimHandle)

	s.mux.HandleFunc("GET /api/categories", s.listCategories)
	s.mux.HandleFunc("POST /api/categories", s.createCategory)
	s.mux.HandleFunc("POST /api/categories/{id}", s.updateCategory)
	s.mux.HandleFunc("POST /api/categories/{id}/delete", s.deleteCategory)

	// The intervals are read with the timer state rather than on their own —
	// they are part of what the timer is — so there is a write here and no read.
	s.mux.HandleFunc("POST /api/intervals", s.setIntervals)

	// The one public read in the app: who is working right now. No auth, because
	// it is the landing page's own content and most of its readers have never
	// signed in.
	s.mux.HandleFunc("GET /api/feed", s.getFeed)

	// A public, read-only page at a name somebody can send. No auth, for the
	// same reason the feed has none: a link that only works for its owner is
	// not a link.
	s.mux.HandleFunc("GET /api/profile/{handle}", s.getProfile)

	s.mux.HandleFunc("GET /api/session", s.getSession)
	s.mux.HandleFunc("POST /api/session/start", s.startSession)
	s.mux.HandleFunc("POST /api/session/{id}/cancel", s.cancelSession)
	s.mux.HandleFunc("POST /api/session/{id}/confirm", s.confirmSession)

	// The one route that is not HTTP-shaped, and it carries nothing upstream:
	// facts are pushed down it, and every change still arrives as one of the
	// posts above. Open to visitors, who receive the feed and nothing else.
	s.mux.HandleFunc("GET /ws", s.socket)

	// The client, and with it the only HTML this server writes: the public
	// routes carry link-preview tags injected into the shell on the way out.
	if h, ok := web.Handler(web.Options{
		Files:       s.client,
		Origin:      s.origin,
		KnownHandle: s.knownHandle,
	}); ok {
		s.mux.Handle("/", h)
	} else {
		s.mux.HandleFunc("/", s.noClient)
	}
}

// origin is the absolute base of a link to this server, as the caller reached
// it. The scheme is read off the connection the same way the session cookie's
// Secure flag is, so a link shared from behind the TLS proxy is https.
func (s *Server) origin(r *http.Request) string {
	scheme := "http"
	if s.isHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// knownHandle says whether a profile link points at somebody. A failed lookup
// is a no: the page renders either way, and the cost is a preview that
// describes the app instead of the person.
func (s *Server) knownHandle(ctx context.Context, handle string) bool {
	// A shorter budget than any handler's, deliberately: this query is not
	// what the reader came for, and a slow database should cost the preview
	// rather than hold the page open waiting to describe it.
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	name := handle
	if _, err := s.q.UserByHandle(ctx, &name); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			s.log.Error("preview lookup", "error", err)
		}
		return false
	}
	return true
}

// now is the instant handlers reason from and every response reports. It reads
// the injected clock, which is what makes the whole timer testable by moving
// one value — a handler that needs two timestamps to agree reads this once
// into a variable rather than calling it twice.
func (s *Server) now() time.Time { return s.clock.Now() }

type healthResponse struct {
	OK bool `json:"ok"`
	// The clock every client corrects against. The device's own clock is
	// trusted to measure elapsed time and never to say what time it is, so
	// every response that carries timestamps carries this too.
	ServerNow int64  `json:"serverNow"`
	Env       string `json:"env"`
	Database  string `json:"database"`
	Users     int64  `json:"users"`
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := timeout(r, 3*time.Second)
	defer cancel()

	res := healthResponse{
		OK:        true,
		ServerNow: s.now().UnixMilli(),
		Env:       s.cfg.Env,
		Database:  "up",
	}
	users, err := s.q.CountUsers(ctx)
	if err != nil {
		s.log.Error("health: database unreachable", "error", err)
		res.OK = false
		res.Database = "down"
		writeJSON(w, http.StatusServiceUnavailable, res)
		return
	}
	res.Users = users
	writeJSON(w, http.StatusOK, res)
}

// noClient stands in for the SPA when the binary was built without one, which
// is the normal state in development — Vite is serving the client itself.
func (s *Server) noClient(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusNotFound, map[string]string{
		"error": "no client is embedded in this binary",
		"hint":  "in development the client is served by Vite on :5174; run `make build` to embed it",
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		// The status line is already sent; there is nowhere left to report to.
		return
	}
}

// errorResponse carries a stable machine-readable code, never a sentence.
// Every word of Persian in the product lives in the client's copy.json, and a
// message written here would be a second place for it to live.
type errorResponse struct {
	Error     string `json:"error"`
	ServerNow int64  `json:"serverNow"`
}

func (s *Server) writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, errorResponse{Error: code, ServerNow: s.now().UnixMilli()})
}

// readJSON decodes a request body, refusing anything unreasonably large or
// carrying fields the handler does not know about — a typo in a field name
// should fail loudly rather than be silently ignored.
func readJSON(r *http.Request, into any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	return decoder.Decode(into)
}

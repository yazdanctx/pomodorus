// Package httpapi wires the HTTP surface: the JSON API, and behind it the
// embedded client.
//
// Every mutation is an ordinary POST with a real status code. Nothing here is
// RPC over a socket — the socket, when it arrives, only pushes facts.
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yazdanctx/pomodorus/server/internal/auth"
	"github.com/yazdanctx/pomodorus/server/internal/clock"
	"github.com/yazdanctx/pomodorus/server/internal/config"
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
}

type Server struct {
	cfg   config.Config
	db    *pgxpool.Pool
	q     *db.Queries
	log   *slog.Logger
	clock clock.Clock
	auth  *auth.Service
	mux   *http.ServeMux
}

func New(deps Deps) *Server {
	queries := db.New(deps.DB)
	s := &Server{
		cfg:   deps.Config,
		db:    deps.DB,
		q:     queries,
		log:   deps.Log,
		clock: deps.Clock,
		auth:  auth.NewService(queries, deps.Clock, deps.Mailer),
		mux:   http.NewServeMux(),
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

	if h, ok := web.Handler(); ok {
		s.mux.Handle("/", h)
	} else {
		s.mux.HandleFunc("/", s.noClient)
	}
}

// now is the instant every response reports and every handler reasons from,
// read once per request so a handler cannot see two different "now"s.
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

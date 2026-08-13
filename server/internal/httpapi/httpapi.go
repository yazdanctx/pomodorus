// Package httpapi wires the HTTP surface: the JSON API, and (in production)
// the embedded client behind it.
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yazdanctx/pomodorus/server/internal/config"
	"github.com/yazdanctx/pomodorus/server/internal/web"
)

type Server struct {
	cfg config.Config
	db  *pgxpool.Pool
	log *slog.Logger
	mux *http.ServeMux
}

func New(cfg config.Config, db *pgxpool.Pool, log *slog.Logger) *Server {
	s := &Server{cfg: cfg, db: db, log: log, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", s.health)

	if h, ok := web.Handler(); ok {
		s.mux.Handle("/", h)
	} else {
		s.mux.HandleFunc("/", s.noClient)
	}
}

type healthResponse struct {
	OK bool `json:"ok"`
	// ServerNow is the clock every client corrects against. The device's own
	// clock is trusted to measure elapsed time and never to say what time it
	// is, so every response that carries timestamps carries this too.
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
		ServerNow: time.Now().UnixMilli(),
		Env:       s.cfg.Env,
		Database:  "up",
	}
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&res.Users); err != nil {
		s.log.Error("health: database unreachable", "error", err)
		res.OK = false
		res.Database = "down"
		writeJSON(w, http.StatusServiceUnavailable, res)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// noClient stands in for the SPA when the binary was built without one, which
// is the normal state in development — Vite is serving the client itself.
func (s *Server) noClient(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusNotFound, map[string]string{
		"error": "no client is embedded in this binary",
		"hint":  "in development the client is served by Vite on :5173; run `make build` to embed it",
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

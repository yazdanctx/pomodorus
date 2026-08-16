package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yazdanctx/pomodorus/server/internal/store/db"
	"github.com/yazdanctx/pomodorus/server/internal/timer"
)

// session is what the client renders. Every instant on it is absolute epoch
// milliseconds — never "seconds remaining" — so a response that arrives late,
// or is read late, still says the same thing.
//
// There is deliberately no `state` field. The client derives running from
// ringing itself, by comparing endsAt against its own skew-corrected clock,
// which is what lets the bell go off without anything being pushed and what
// makes a dropped connection invisible.
type session struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	CategoryID   *string `json:"categoryId"`
	CategoryName *string `json:"categoryName"`
	StartedAt    int64   `json:"startedAt"`
	EndsAt       int64   `json:"endsAt"`
	// The nominal length, which is what gets credited. Under fast sessions it
	// is not endsAt - startedAt, and nothing may assume it is.
	DurationMs int64 `json:"durationMs"`
}

// sessionResponse always carries the field, null when there is no live
// session, so the client never has to tell "no timer" from "not asked yet".
type sessionResponse struct {
	Session   *session `json:"session"`
	ServerNow int64    `json:"serverNow"`
}

func asSession(row db.Session, categoryName *string) session {
	out := session{
		ID:           uuid.UUID(row.ID.Bytes).String(),
		Kind:         kindToJSON(row.Kind),
		CategoryName: categoryName,
		StartedAt:    row.StartedAt.Time.UnixMilli(),
		EndsAt:       row.EndsAt.Time.UnixMilli(),
		DurationMs:   row.DurationMs,
	}
	if row.CategoryID.Valid {
		id := uuid.UUID(row.CategoryID.Bytes).String()
		out.CategoryID = &id
	}
	return out
}

// The wire spells kinds the way the client does; the database spells them the
// way SQL does.
func kindToJSON(kind db.SessionKind) string {
	switch kind {
	case db.SessionKindShortBreak:
		return "shortBreak"
	case db.SessionKindLongBreak:
		return "longBreak"
	default:
		return "work"
	}
}

// liveSession reads the one session that has not been acknowledged or
// abandoned, or nil when there is none.
func (s *Server) liveSession(r *http.Request, userID pgtype.UUID) (*session, error) {
	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	row, err := s.q.LiveSessionForUser(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// A private task's name is nobody else's business, but this is the owner's
	// own timer — they see what they wrote.
	live := asSession(row.Session, row.CategoryName)
	return &live, nil
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	live, err := s.liveSession(r, user.ID)
	if err != nil {
		s.log.Error("read session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	writeJSON(w, http.StatusOK, sessionResponse{Session: live, ServerNow: s.now().UnixMilli()})
}

type startSessionRequest struct {
	ID         string `json:"id"`
	CategoryID string `json:"categoryId"`
	DurationMs int64  `json:"durationMs"`
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	var body startSessionRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	id, err := uuid.Parse(strings.TrimSpace(body.ID))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}
	categoryID, err := uuid.Parse(strings.TrimSpace(body.CategoryID))
	if err != nil {
		s.writeError(w, http.StatusNotFound, "category_not_found")
		return
	}
	duration := time.Duration(body.DurationMs) * time.Millisecond
	if !timer.IsWorkDuration(duration) {
		s.writeError(w, http.StatusBadRequest, "bad_duration")
		return
	}

	now := s.now()

	// Asking to start while one is live returns the live one rather than
	// erroring. That is what lets a second device open into the running timer
	// instead of offering a start button, and what makes a retried start safe.
	live, err := s.liveSession(r, user.ID)
	if err != nil {
		s.log.Error("read session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	if live != nil {
		writeJSON(w, http.StatusOK, sessionResponse{Session: live, ServerNow: now.UnixMilli()})
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	category, err := s.q.CategoryByID(ctx, db.CategoryByIDParams{ID: pgID(categoryID), UserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && category.DeletedAt.Valid) {
		s.writeError(w, http.StatusNotFound, "category_not_found")
		return
	}
	if err != nil {
		s.log.Error("read category", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	row, err := s.q.StartSession(ctx, db.StartSessionParams{
		ID:         pgID(id),
		UserID:     user.ID,
		Kind:       db.SessionKindWork,
		CategoryID: pgID(categoryID),
		StartedAt:  pgTime(now),
		DurationMs: body.DurationMs,
		// Fast sessions are decided here and nowhere else: a client able to
		// ask for one would be a client able to mint focus time, so the flag
		// is read from the server's own environment.
		EndsAt: pgTime(timer.Ends(now, duration, s.cfg.FastSessions)),
	})
	if err != nil {
		s.log.Error("start session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	if row.UserID != user.ID {
		s.writeError(w, http.StatusConflict, "session_not_found")
		return
	}

	started := asSession(row, &category.Name)
	writeJSON(w, http.StatusOK, sessionResponse{Session: &started, ServerNow: now.UnixMilli()})
}

func (s *Server) cancelSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.writeError(w, http.StatusNotFound, "session_not_found")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	now := s.now()
	// Refused once the bell has gone: the work was credited at its nominal
	// end, and credited work cannot be retracted. The database decides that
	// rather than a read-then-write, so the race at the boundary has one
	// answer.
	cancelled, err := s.q.CancelSession(ctx, db.CancelSessionParams{
		ID: pgID(id), UserID: user.ID, CancelledAt: pgTime(now),
	})
	if err != nil {
		s.log.Error("cancel session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	if cancelled == 0 {
		s.writeError(w, http.StatusConflict, "not_cancellable")
		return
	}

	// Answering with the state afterwards rather than with nothing: the caller
	// asked to change the timer and wants to know what the timer now is.
	writeJSON(w, http.StatusOK, sessionResponse{Session: nil, ServerNow: now.UnixMilli()})
}

// confirmSession acknowledges the bell.
//
// It is the one deliberate tap that ends a ring, and the only write a ringing
// session ever takes. Nothing else about the row moves: the work was credited
// at its exact nominal end, so a confirmation two hours late records what a
// confirmation two seconds late records.
func (s *Server) confirmSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.writeError(w, http.StatusNotFound, "session_not_found")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	now := s.now()
	// Refused before the bell: a running session is not something to
	// acknowledge, and letting it through would be a way to end a pomodoro
	// early and still be paid for it. As with cancelling, the database decides
	// the boundary rather than a read-then-write.
	confirmed, err := s.q.ConfirmSession(ctx, db.ConfirmSessionParams{
		ID: pgID(id), UserID: user.ID, ConfirmedAt: pgTime(now),
	})
	if err != nil {
		s.log.Error("confirm session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	if confirmed == 0 {
		s.writeError(w, http.StatusConflict, "nothing_ringing")
		return
	}

	// Nothing advances on its own: acknowledging leaves the timer idle rather
	// than starting anything.
	writeJSON(w, http.StatusOK, sessionResponse{Session: nil, ServerNow: now.UnixMilli()})
}

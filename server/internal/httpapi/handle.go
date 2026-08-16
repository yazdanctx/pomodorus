package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yazdanctx/pomodorus/server/internal/identity"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

type claimHandleRequest struct {
	Handle string `json:"handle"`
}

// claimHandle is the one irreversible thing anybody does in this app.
func (s *Server) claimHandle(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}
	if user.Handle != nil {
		// Not an error the client should ever provoke, but the answer has to
		// be something other than "taken" — it is your own.
		s.writeError(w, http.StatusConflict, "handle_already_set")
		return
	}

	var body claimHandleRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	handle := identity.NormalizeHandle(body.Handle)
	switch err := identity.ValidateHandle(handle); {
	case err == nil:
	case errors.Is(err, identity.ErrHandleFormat):
		s.writeError(w, http.StatusBadRequest, "handle_invalid")
		return
	case errors.Is(err, identity.ErrHandleProfane):
		s.writeError(w, http.StatusBadRequest, "handle_profane")
		return
	default:
		s.log.Error("validate handle", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	now := s.now()
	claimed, err := s.q.ClaimHandle(ctx, db.ClaimHandleParams{
		ID:          user.ID,
		Handle:      &handle,
		HandleSetAt: pgtype.Timestamptz{Time: now, Valid: true},
	})
	switch {
	case err == nil:
	case errors.Is(err, pgx.ErrNoRows):
		// Somebody claimed on another device between the read above and here.
		s.writeError(w, http.StatusConflict, "handle_already_set")
		return
	case isUniqueViolation(err):
		// Decided by the unique index rather than by a check-then-write, so
		// two people claiming the same handle at once cannot both win.
		s.writeError(w, http.StatusConflict, "handle_taken")
		return
	default:
		s.log.Error("claim handle", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	writeJSON(w, http.StatusOK, meResponse{Handle: claimed.Handle, ServerNow: now.UnixMilli()})
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

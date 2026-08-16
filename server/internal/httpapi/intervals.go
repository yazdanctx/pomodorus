package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/yazdanctx/pomodorus/server/internal/store/db"
	"github.com/yazdanctx/pomodorus/server/internal/timer"
)

// setIntervals edits what a break is worth and how long a cycle is.
//
// The request is the same shape the timer state answers with, decoded into the
// same type: all three, always. The dialog holds all three, so there is nothing
// to merge and no way for a stepper tapped on a phone to quietly revert what a
// laptop set a moment ago.
//
// It is idempotent by construction: the whole of the setting is sent and the
// whole of it is written, so a retry whose answer was lost lands on the same
// row it already wrote.
//
// The bands are checked here as well as by the steppers that walk them, for the
// same reason a work length is: a client is a claim. And they are checked again
// as a CHECK on the table, because that is the layer nothing can go around.
//
// What it answers with is the whole timer state, not just the intervals. This
// edit can change what the screen says about a session already running — a
// shorter cycle can turn the rest it is heading for into the long one — and the
// caller's next question would be exactly that.
func (s *Server) setIntervals(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	var body intervals
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	wanted := timer.Intervals{
		ShortBreak: time.Duration(body.ShortBreakMs) * time.Millisecond,
		LongBreak:  time.Duration(body.LongBreakMs) * time.Millisecond,
		PerCycle:   body.PerCycle,
	}
	if !wanted.Valid() {
		s.writeError(w, http.StatusBadRequest, "bad_interval")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	// Read back rather than assumed: what the timer state is answered from has
	// to be the row, not the request that hoped to become it.
	updated, err := s.q.SetIntervals(ctx, db.SetIntervalsParams{
		ID:           user.ID,
		ShortBreakMs: wanted.ShortBreak.Milliseconds(),
		LongBreakMs:  wanted.LongBreak.Milliseconds(),
		PerCycle:     int32(wanted.PerCycle),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// The account went away between resolving the cookie and this write.
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}
	if err != nil {
		s.log.Error("set intervals", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	s.writeTimerState(ctx, w, updated, s.now())
}

package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/yazdanctx/pomodorus/server/internal/identity"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
	"github.com/yazdanctx/pomodorus/server/internal/timer"
)

// A profile is public and read-only: a handle, and how much focus time that
// person has put in per day. It needs no account, because the whole point of a
// handle is that it makes a link somebody can send.
//
// Nothing here says anything about *what* was worked on. That is the day
// detail's business, and it is where the private/public distinction lives.

// chartRanges are the only ranges that may be asked for.
//
// Three presets and no custom picker, which is a design decision rather than a
// limitation — and they are enforced here as well as offered there, because a
// client is a claim: a request for ten thousand days would be a request to
// aggregate somebody's entire history on every keystroke.
var chartRanges = map[int]bool{7: true, 30: true, 90: true}

// defaultRange is what the page opens on.
const defaultRange = 7

type profileDay struct {
	// `YYYY-MM-DD` in Tehran. A day is a name here, not an instant — the client
	// resolves it at noon UTC, which is unambiguously inside the Tehran day
	// whatever the offset.
	Day     string `json:"day"`
	TotalMs int64  `json:"totalMs"`
}

type profileResponse struct {
	Handle string `json:"handle"`
	// Every day in the range, including the empty ones. A line drawn only
	// through the days somebody worked would read a fortnight off as flat
	// effort rather than as the absence it was.
	Days      []profileDay `json:"days"`
	ServerNow int64        `json:"serverNow"`
}

func (s *Server) getProfile(w http.ResponseWriter, r *http.Request) {
	// Normalised the way a handle always is, so a link typed with different
	// capitalisation reaches the same person. The column is citext and would
	// fold it anyway; doing it here means the answer echoes the canonical form
	// rather than whatever was in the URL.
	handle := identity.NormalizeHandle(r.PathValue("handle"))
	if err := identity.ValidateHandle(handle); err != nil {
		// A string that could not be anybody's handle is not a lookup worth
		// making, and "no such person" is the honest answer to it.
		s.writeError(w, http.StatusNotFound, "profile_not_found")
		return
	}

	days, err := chartDays(r)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_range")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	// Deliberately no auth: this is a link somebody sent to somebody else.
	user, err := s.q.UserByHandle(ctx, &handle)
	if errors.Is(err, pgx.ErrNoRows) {
		s.writeError(w, http.StatusNotFound, "profile_not_found")
		return
	}
	if err != nil {
		s.log.Error("read profile", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	now := s.now()
	chart, err := s.chart(ctx, user, days, now)
	if err != nil {
		s.log.Error("read chart", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	writeJSON(w, http.StatusOK, profileResponse{
		Handle:    *user.Handle,
		Days:      chart,
		ServerNow: now.UnixMilli(),
	})
}

// chartDays reads the requested range, defaulting when none is asked for.
func chartDays(r *http.Request) (int, error) {
	raw := r.URL.Query().Get("days")
	if raw == "" {
		return defaultRange, nil
	}
	days, err := strconv.Atoi(raw)
	if err != nil || !chartRanges[days] {
		return 0, errUnknownRange
	}
	return days, nil
}

var errUnknownRange = errors.New("httpapi: unknown chart range")

// chart is focus time per Tehran day over the last `days` days, ending today.
//
// The window runs from the start of the Tehran day `days-1` back, so a
// seven-day chart is seven columns with today as the last — not seven
// twenty-four-hour blocks measured back from this instant, which would put a
// partial day at each end and a boundary in the middle of a column.
func (s *Server) chart(ctx context.Context, user db.User, days int, now time.Time) ([]profileDay, error) {
	from := timer.DayStart(now).AddDate(0, 0, -(days - 1))

	rows, err := s.q.CreditedWorkBetween(ctx, db.CreditedWorkBetweenParams{
		UserID:   user.ID,
		FromTime: pgTime(from),
		ToTime:   pgTime(now),
	})
	if err != nil {
		return nil, err
	}

	credited := make([]timer.Credited, 0, len(rows))
	for _, row := range rows {
		credited = append(credited, timer.Credited{
			EndsAt: row.EndsAt.Time,
			Length: time.Duration(row.DurationMs) * time.Millisecond,
		})
	}

	out := make([]profileDay, 0, days)
	for _, day := range timer.Days(from, now, credited) {
		out = append(out, profileDay{Day: day.Key, TotalMs: day.Total.Milliseconds()})
	}
	return out, nil
}

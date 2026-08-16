package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/yazdanctx/pomodorus/server/internal/identity"
	"github.com/yazdanctx/pomodorus/server/internal/profanity"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
	"github.com/yazdanctx/pomodorus/server/internal/timer"
)

// A profile is public and read-only: a handle, how much focus time that person
// has put in per day, and what each day was made of. It needs no account,
// because the whole point of a handle is that it makes a link somebody can
// send.
//
// The day detail is where the private/public distinction lives, and it is the
// second place in the app — after the feed — where one person's writing is
// shown to strangers under their name. A private task's name never leaves the
// server: the rows are collapsed here, so there is nothing in the response for
// a later bug to leak, a network tab to reveal, or a proxy to cache.
//
// Reading a profile still does not *require* an account, but it does notice
// one: the owner is shown their own task names, because masking somebody's
// history from themselves would be the page lying to the only person entitled
// to it.

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
	// What the day was made of, largest first, and always an array: a day with
	// nothing in it has none rather than null, so the client tells "no detail"
	// from "not sent" by the total it already has.
	//
	// Sent with the chart rather than fetched per day, because pointing along
	// the line walks through days one per mouse move — a request per day would
	// be a scrub that stutters and a server that is asked ninety times for one
	// gesture.
	Tasks []profileTask `json:"tasks"`
}

// profileTask is one task's share of a day, as far as this reader may know it.
//
// The name is a nullable string rather than a name plus a flag, the way the
// feed carries one: for a private task there is no name to send, so there is no
// field for one to travel in. `kind` is what the client renders its own label
// from — the two nameless rows are not the same row, and one of them is not
// hiding anything.
type profileTask struct {
	Kind    string  `json:"kind"`
	Name    *string `json:"name"`
	TotalMs int64   `json:"totalMs"`
}

type profileResponse struct {
	Handle string `json:"handle"`
	// Every day in the range, including the empty ones. A line drawn only
	// through the days somebody worked would read a fortnight off as flat
	// effort rather than as the absence it was.
	Days []profileDay `json:"days"`
	// Whether this person has ever finished a pomodoro, which is a different
	// question from whether the selected range has anything in it.
	//
	// The page's empty state belongs to somebody who has never focused at all.
	// A week off is a flat line, and drawing it is the whole reason the days
	// are zero-filled — telling a long-standing user their profile is empty
	// because they took a holiday would be the chart lying about them.
	EverFocused bool `json:"everFocused"`
	// Whether this is the reader's own profile — which is to say whether the
	// task names above are the real ones. The client says so out loud on the
	// owner's page: seeing your own private tasks named is exactly the moment
	// you might think strangers can too.
	Owner     bool  `json:"owner"`
	ServerNow int64 `json:"serverNow"`
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

	// No auth *required*: this is a link somebody sent to somebody else, and it
	// reads the same for a visitor who has never signed in.
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

	// Whose page this is, to the person reading it. A signed-out visitor and
	// somebody signed in as anybody else are the same reader here; only the
	// owner is told what their own private time was spent on.
	reader, signedIn := s.currentUser(r)
	owner := signedIn && reader.ID == user.ID

	now := s.now()
	chart, err := s.chart(ctx, user, days, now, owner)
	if err != nil {
		s.log.Error("read chart", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	ever, err := s.q.HasCreditedWork(ctx, db.HasCreditedWorkParams{
		UserID: user.ID, EndsAt: pgTime(now),
	})
	if err != nil {
		s.log.Error("read profile", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	// The one read in the app whose body depends on who asked: the same URL
	// answers a stranger and the owner differently, and the difference is
	// somebody's private task names. Said out loud to anything in front of this
	// server, because a proxy that cached the owner's copy and handed it to the
	// next reader would be the one bug this endpoint cannot have.
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")

	writeJSON(w, http.StatusOK, profileResponse{
		Handle:      *user.Handle,
		Days:        chart,
		EverFocused: ever,
		Owner:       owner,
		ServerNow:   now.UnixMilli(),
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
func (s *Server) chart(ctx context.Context, user db.User, days int, now time.Time, owner bool) ([]profileDay, error) {
	// Counted back in Tehran rather than on the UTC instant, so the result is a
	// day boundary even if Iran ever restores daylight saving — the same care
	// `timer.Days` takes when it walks forward.
	from := timer.DayStart(timer.DayStart(now).In(timer.Tehran).AddDate(0, 0, -(days - 1)))

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
			// Decided here rather than in the domain package, because "what may
			// this reader be told" is an application question — the same split
			// the feed makes. What reaches `timer.Days` is already the reader's
			// view, so nothing downstream is carrying a name it must remember
			// not to send.
			Task: taskFor(row, owner),
		})
	}

	out := make([]profileDay, 0, days)
	for _, day := range timer.Days(from, now, credited) {
		out = append(out, profileDay{
			Day:     day.Key,
			TotalMs: day.Total.Milliseconds(),
			Tasks:   tasksOf(day.Slices),
		})
	}
	return out, nil
}

// taskFor is what one credited pomodoro's task looks like to this reader.
func taskFor(row db.CreditedWorkBetweenRow, owner bool) timer.Task {
	// No task on the row, or a category that has somehow gone missing: an
	// unmasked row of its own, because it is not hiding anything. Tombstoned
	// categories are not this — they are joined in and keep their name, so
	// deleting a task never rewrites the history recorded against it.
	if row.CategoryName == nil || row.CategoryIsPublic == nil {
		return timer.Task{Kind: timer.TaskUntasked}
	}
	if owner {
		return timer.Task{Kind: timer.TaskNamed, Name: *row.CategoryName}
	}
	// A stranger, so every private task becomes the one masked row: how long
	// somebody worked is public, and what they were doing is theirs.
	//
	// A public name that trips the wordlist is masked the same way, which is
	// the same late gate the feed keeps — the list is checked when a task is
	// named, and this catches what was added to it afterwards. Masked rather
	// than dropped: dropping it would make the rows disagree with the day's
	// total, and the total is not the offending part.
	if !*row.CategoryIsPublic || profanity.Contains(*row.CategoryName) {
		return timer.Task{Kind: timer.TaskPrivate}
	}
	return timer.Task{Kind: timer.TaskNamed, Name: *row.CategoryName}
}

// tasksOf is a day's breakdown on the wire, in the order it was sorted into.
func tasksOf(slices []timer.Slice) []profileTask {
	// Empty rather than null: a zero day has no detail, and the client should
	// not have to tell that from a field that was never sent.
	out := make([]profileTask, 0, len(slices))
	for _, slice := range slices {
		task := profileTask{Kind: string(slice.Task.Kind), TotalMs: slice.Total.Milliseconds()}
		if slice.Task.Kind == timer.TaskNamed {
			name := slice.Task.Name
			task.Name = &name
		}
		out = append(out, task)
	}
	return out
}

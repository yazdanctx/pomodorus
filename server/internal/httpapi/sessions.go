package httpapi

import (
	"context"
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

	// When the rest this pomodoro owes runs out. Null on a break, which owes
	// nothing.
	//
	// It is an absolute instant rather than a length for the same reason
	// everything else here is: the break is anchored at the nominal end, so
	// ring time is spent out of it, and a client that has this one number can
	// say — live, without asking again — whether confirming now still buys a
	// break or drops straight back to the start screen. Which of the two
	// breaks it would be is not sent, because nothing on screen says: the
	// button offers a chill, and the break itself arrives named.
	//
	// Under fast sessions the break that actually starts is shorter than this,
	// exactly as a session's `endsAt` is not `startedAt + durationMs`. It is
	// the deadline, not a promise about the length.
	BreakEndsAt *int64 `json:"breakEndsAt"`

	// What "another one" resumes, on a ringing break: the task the pomodoro
	// before it was on, and the length it ran for. Null on a pomodoro.
	//
	// Read off that pomodoro rather than left to the device, because the timer
	// belongs to the person: a second device that opens into a ringing break
	// has never picked anything, and would otherwise either refuse to continue
	// or continue onto whatever it last remembered — a different task.
	ResumeCategoryID *string `json:"resumeCategoryId"`
	ResumeDurationMs *int64  `json:"resumeDurationMs"`
}

// cycleState is how far into the cycle the user is. Derived from the sessions
// themselves on every read, never stored, so two devices cannot disagree about
// it and a restart cannot lose it.
//
// How long the cycle is belongs to the intervals rather than here: it is a
// setting, and one number spelled in two places on the wire is one number that
// can be read wrong.
type cycleState struct {
	Count int `json:"count"`
}

// intervals is the account's answer to what a break is worth and how many
// pomodoros make a set. Lengths cross the wire in milliseconds like every other
// duration; the count is a count.
type intervals struct {
	ShortBreakMs int64 `json:"shortBreakMs"`
	LongBreakMs  int64 `json:"longBreakMs"`
	PerCycle     int   `json:"perCycle"`
}

// sessionResponse always carries the session field, null when there is no live
// session, so the client never has to tell "no timer" from "not asked yet".
//
// The intervals ride along with it because they are read on the same screens
// and change what those screens say: a device that has the timer has, by the
// same payload, the settings the timer is running under.
type sessionResponse struct {
	Session   *session   `json:"session"`
	Cycle     cycleState `json:"cycle"`
	Intervals intervals  `json:"intervals"`
	ServerNow int64      `json:"serverNow"`
}

// intervalsOf is the account's intervals as the domain sees them.
func intervalsOf(user db.User) timer.Intervals {
	return timer.Intervals{
		ShortBreak: time.Duration(user.ShortBreakMs) * time.Millisecond,
		LongBreak:  time.Duration(user.LongBreakMs) * time.Millisecond,
		PerCycle:   int(user.PerCycle),
	}
}

func asIntervals(in timer.Intervals) intervals {
	return intervals{
		ShortBreakMs: in.ShortBreak.Milliseconds(),
		LongBreakMs:  in.LongBreak.Milliseconds(),
		PerCycle:     in.PerCycle,
	}
}

// owedBy is the intervals that decide the rest a pomodoro hands over, and it is
// deliberately assembled from two different moments.
//
// The lengths are the pomodoro's own, copied off the account when it started,
// so editing the dialog mid-session — or mid-ring — cannot change the break it
// already owes. A row that recorded none, written before sessions carried them,
// falls back to the account's current lengths: the closest thing to what it
// meant.
//
// The count is the account's now, because it describes the cycle rather than
// the session: shortening it is meant to be felt at the very next completion.
func owedBy(work db.Session, user db.User) timer.Intervals {
	in := intervalsOf(user)
	if work.ShortBreakMs != nil && work.LongBreakMs != nil {
		in.ShortBreak = time.Duration(*work.ShortBreakMs) * time.Millisecond
		in.LongBreak = time.Duration(*work.LongBreakMs) * time.Millisecond
	}
	return in
}

// cycleWindow is how far back the cycle counter looks. An hour of idleness
// ends a cycle and a long break ends a cycle, so no cycle can reach back
// further than a handful of hours; a day is many times over enough.
const cycleWindow = 24 * time.Hour

func asSession(row db.Session, categoryName *string) session {
	out := session{
		ID:           uuid.UUID(row.ID.Bytes).String(),
		Kind:         string(kindOf(row.Kind)),
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

// The domain and the wire spell kinds the same way; the database spells them
// the way SQL does.
func kindOf(kind db.SessionKind) timer.Kind {
	switch kind {
	case db.SessionKindShortBreak:
		return timer.ShortBreak
	case db.SessionKindLongBreak:
		return timer.LongBreak
	default:
		return timer.Work
	}
}

func storedKind(kind timer.Kind) db.SessionKind {
	switch kind {
	case timer.ShortBreak:
		return db.SessionKindShortBreak
	case timer.LongBreak:
		return db.SessionKindLongBreak
	default:
		return db.SessionKindWork
	}
}

// cycleCount walks the recent past into the number of pomodoros completed in
// the cycle that is current at `now`. The rule itself is in the timer package,
// with nothing but rows and an instant crossing into it.
func (s *Server) cycleCount(ctx context.Context, q *db.Queries, userID pgtype.UUID, now time.Time) (int, error) {
	rows, err := q.SessionsSince(ctx, db.SessionsSinceParams{
		UserID: userID, StartedAt: pgTime(now.Add(-cycleWindow)),
	})
	if err != nil {
		return 0, err
	}
	past := make([]timer.Session, 0, len(rows))
	for _, row := range rows {
		past = append(past, timer.Session{
			Kind:        kindOf(row.Kind),
			StartedAt:   row.StartedAt.Time,
			EndsAt:      row.EndsAt.Time,
			CancelledAt: row.CancelledAt.Time,
		})
	}
	return timer.Cycle(past, now), nil
}

// timerState is the whole answer to "what is my timer doing": the one live
// session if there is one, and the cycle it sits in.
//
// Both are reads. Nothing here decides anything — the session's state, the
// break it owes and the cycle it belongs to are all computed from stored rows
// plus this instant, which is what lets the same answer be given to every
// device without anything being pushed.
//
// It takes its queries rather than reaching for the server's, so the handler
// that confirms a bell can ask it from inside the transaction that started
// the break and see its own write.
func (s *Server) timerState(ctx context.Context, q *db.Queries, user db.User, now time.Time) (sessionResponse, error) {
	state := sessionResponse{
		Intervals: asIntervals(intervalsOf(user)),
		ServerNow: now.UnixMilli(),
	}

	count, err := s.cycleCount(ctx, q, user.ID, now)
	if err != nil {
		return state, err
	}
	state.Cycle.Count = count

	live, err := q.LiveSessionForUser(ctx, user.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return state, err
	}

	// A private task's name is nobody else's business, but this is the owner's
	// own timer — they see what they wrote.
	out := asSession(live.Session, live.CategoryName)
	if kindOf(live.Session.Kind) == timer.Work {
		// A pomodoro that is still running has not been counted yet but is
		// about to be, and the break it will owe is the one for the cycle it
		// is going to close. One that is ringing was credited at its bell and
		// is already in the count.
		completed := state.Cycle.Count
		if live.Session.EndsAt.Time.After(now) {
			completed++
		}
		_, length := timer.BreakAfter(completed, owedBy(live.Session, user))
		ends := timer.BreakDeadline(live.Session.EndsAt.Time, length).UnixMilli()
		out.BreakEndsAt = &ends
	} else if err := s.resumeHint(ctx, q, user.ID, live.Session, &out); err != nil {
		return state, err
	}
	state.Session = &out
	return state, nil
}

// resumeHint fills in what "another one" would resume from a break: the task
// and the length of the pomodoro that break was handed over from.
//
// A break that cannot find its pomodoro — one whose bell was rung by a build
// that anchored differently, or by hand — simply carries no hint, and the
// client falls back to whatever this device last picked.
func (s *Server) resumeHint(ctx context.Context, q *db.Queries, userID pgtype.UUID, rest db.Session, out *session) error {
	work, err := q.WorkBeforeBreak(ctx, db.WorkBeforeBreakParams{
		UserID: userID, EndsAt: rest.StartedAt,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if work.CategoryID.Valid {
		id := uuid.UUID(work.CategoryID.Bytes).String()
		out.ResumeCategoryID = &id
	}
	out.ResumeDurationMs = &work.DurationMs
	return nil
}

// liveSession reads the one session that has not been acknowledged or
// abandoned, or nil when there is none.
func (s *Server) liveSession(ctx context.Context, userID pgtype.UUID) (*session, error) {
	row, err := s.q.LiveSessionForUser(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	live := asSession(row.Session, row.CategoryName)
	return &live, nil
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	s.writeTimerState(ctx, w, user, s.now())
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

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	// Asking to start while one is live returns the live one rather than
	// erroring. That is what lets a second device open into the running timer
	// instead of offering a start button, and what makes a retried start safe.
	live, err := s.liveSession(ctx, user.ID)
	if err != nil {
		s.log.Error("read session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	if live != nil {
		s.writeTimerState(ctx, w, user, now)
		return
	}

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
		// The rest this pomodoro will owe, taken off the account now and never
		// read from it again. Editing the dialog while this runs — or while its
		// bell rings — cannot change the break it already earned.
		ShortBreakMs: &user.ShortBreakMs,
		LongBreakMs:  &user.LongBreakMs,
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

	s.writeTimerState(ctx, w, user, now)
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
	// One endpoint for two gestures that are the same fact: abandoning a
	// pomodoro, and skipping a break. Both say "this session is over and it
	// was not seen through", and the only difference — that skipping the long
	// break still closes the cycle — is read back out of the row afterwards
	// rather than decided here.
	//
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
	s.writeTimerState(ctx, w, user, now)
}

// confirmSession acknowledges the bell, and starts whatever break survived it.
//
// It is idempotent on the session it names: tapping twice, or retrying a
// request whose answer was lost, acknowledges nothing a second time and starts
// no second break — it just says what the timer is.
//
// It is the one deliberate tap that ends a ring, and the only write a ringing
// session ever takes. Nothing else about the row moves: the work was credited
// at its exact nominal end, so a confirmation two hours late records what a
// confirmation two seconds late records.
//
// What a late confirmation does change is the rest. The break is anchored at
// the pomodoro's nominal end rather than at this tap, so every second of
// ringing is a second of break already spent — and once the whole break has
// gone by there is nothing left to start, so acknowledging drops straight back
// to an idle timer. That is not a punishment: time away from the desk was rest
// whether or not it was labelled as such.
//
// Confirming a break starts nothing. Whether to go round again is the
// technique's own fork, and the client asks it as two buttons rather than
// having it answered here.
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

	// The acknowledgement and the break it starts are one transaction: the
	// partial unique index allows only one live session, so a break that
	// existed without its pomodoro being confirmed — or a confirmation whose
	// break never arrived — would leave the timer in a state no gesture
	// produces.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		s.log.Error("confirm session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	// Refused before the bell: a running session is not something to
	// acknowledge, and letting it through would be a way to end a pomodoro
	// early and still be paid for it. As with cancelling, the database decides
	// the boundary rather than a read-then-write.
	confirmed, err := q.ConfirmSession(ctx, db.ConfirmSessionParams{
		ID: pgID(id), UserID: user.ID, ConfirmedAt: pgTime(now),
	})
	if err != nil {
		s.log.Error("confirm session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	row, err := q.SessionByID(ctx, db.SessionByIDParams{ID: pgID(id), UserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		s.writeError(w, http.StatusConflict, "nothing_ringing")
		return
	}
	if err != nil {
		s.log.Error("confirm session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	switch {
	case confirmed == 1:
		if kindOf(row.Kind) == timer.Work {
			if err := s.startBreak(ctx, q, user, row, now); err != nil {
				s.log.Error("start break", "error", err)
				s.writeError(w, http.StatusInternalServerError, "server_error")
				return
			}
		}
	case row.ConfirmedAt.Valid:
		// This tap already landed — a double click, the other device catching
		// up, or a retry of a request whose answer was lost. The bell is not
		// rung twice and `confirmed_at` does not move; the caller is told what
		// the timer is, which on the retry is the break its first attempt
		// started. An idempotent POST is the whole reason a lost response is
		// safe to send again.
	default:
		// Still running, or abandoned. There is no bell here to acknowledge.
		s.writeError(w, http.StatusConflict, "nothing_ringing")
		return
	}

	state, err := s.timerState(ctx, q, user, now)
	if err != nil {
		s.log.Error("read session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.log.Error("confirm session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// startBreak begins the rest a just-acknowledged pomodoro owes, if any of it
// is left.
//
// The row it writes says the break began at the bell, not at the tap. That one
// choice is the whole of the ring-time rule: the countdown, the progress bar
// and the moment the break itself rings all fall out of it, and nothing
// downstream has to know that a ring happened at all.
//
// The break's id is minted here rather than by the client, because a break is
// not something anybody asked for by name: it is a consequence of the
// confirmation, and the transaction plus the one-live-session index are what
// make a retried tap unable to produce a second one.
func (s *Server) startBreak(ctx context.Context, q *db.Queries, user db.User, work db.Session, now time.Time) error {
	// The pomodoro was credited at its bell, so the count already includes it:
	// this is the cycle it closed, and the break owed is the one that cycle
	// earned — at the length that pomodoro recorded, over the cycle the account
	// asks for now.
	completed, err := s.cycleCount(ctx, q, user.ID, now)
	if err != nil {
		return err
	}
	kind, length := timer.BreakAfter(completed, owedBy(work, user))

	bell := work.EndsAt.Time
	ends, left := timer.BreakEnds(bell, length, now, s.cfg.FastSessions)
	if !left {
		// Rung through the whole of it. There is no break to start, and the
		// button that was just pressed said so before it was pressed.
		return nil
	}

	_, err = q.StartSession(ctx, db.StartSessionParams{
		ID:     pgID(uuid.New()),
		UserID: user.ID,
		Kind:   storedKind(kind),
		// A break is a break: it belongs to no task, and the schema says so.
		CategoryID: pgtype.UUID{},
		StartedAt:  pgTime(bell),
		// The nominal length, whole, exactly as a pomodoro records its own —
		// what was actually spent resting is `ends_at` minus now, and it is
		// nobody's job to store that.
		DurationMs: length.Milliseconds(),
		EndsAt:     pgTime(ends),
		// A break owes no break of its own, and the schema says so.
	})
	return err
}

// writeTimerState answers with what the timer is. Every read and every write
// ends this way rather than with nothing: the caller changed the timer, and
// the next thing it would ask is what the timer now is.
func (s *Server) writeTimerState(ctx context.Context, w http.ResponseWriter, user db.User, now time.Time) {
	state, err := s.timerState(ctx, s.q, user, now)
	if err != nil {
		s.log.Error("read session", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	writeJSON(w, http.StatusOK, state)
}

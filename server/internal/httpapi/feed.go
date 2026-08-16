package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/profanity"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
	"github.com/yazdanctx/pomodorus/server/internal/timer"
)

// The feed is the one public read in the app: who is working right now.
//
// It is what makes the landing page feel inhabited, and it is also the only
// place one person's writing is shown to strangers under their name — so it is
// the last gate on both privacy and profanity, after the ones at claim and at
// create.

// feedEntry is one person, working.
//
// The task is a nullable string rather than a name plus a flag, because the
// difference between "private" and "public" is not something a visitor is owed:
// a private task's name never leaves the server, so there is nothing here for
// it to be carried in. The client renders the generic label from its own copy.
type feedEntry struct {
	Handle string  `json:"handle"`
	Kind   string  `json:"kind"`
	Task   *string `json:"task"`
	// When this session's bell goes. Absolute, like every instant here, and
	// sent for a break as well as for work — the client does not show a break's
	// countdown, but it does use this to drop the row at the bell without being
	// told to.
	EndsAt int64 `json:"endsAt"`
}

// feedResponse always carries an array, empty rather than null when nobody is
// working: the landing holds a row's height either way, and a client should not
// have to tell "nobody" from "not asked yet" by the shape of a field.
type feedResponse struct {
	Entries   []feedEntry `json:"entries"`
	ServerNow int64       `json:"serverNow"`
}

// feedChanged is "somebody started or stopped".
const feedChanged = "feed"

// feedTopic is the one topic everybody shares. Unlike a timer's, it is not
// private to anybody — which is exactly why an anonymous socket may subscribe
// to it and to nothing else.
const feedTopic = "feed"

func (s *Server) getFeed(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	// Deliberately no auth: this is the public front door, read by visitors who
	// have never signed in and may never.
	state, err := s.feed(ctx, s.now())
	if err != nil {
		s.log.Error("read feed", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// feed reads who is working, and decides what a stranger may see of it.
func (s *Server) feed(ctx context.Context, now time.Time) (feedResponse, error) {
	rows, err := s.q.LiveFeed(ctx, pgTime(now))
	if err != nil {
		return feedResponse{}, err
	}

	entries := make([]feedEntry, 0, len(rows))
	for _, row := range rows {
		if entry, ok := feedEntryFor(row); ok {
			entries = append(entries, entry)
		}
	}
	return feedResponse{Entries: entries, ServerNow: now.UnixMilli()}, nil
}

// feedEntryFor is what one live session looks like to a stranger, and whether
// it may be shown to one at all.
func feedEntryFor(row db.LiveFeedRow) (feedEntry, bool) {
	// The query excludes these, so neither is reachable. Checked anyway,
	// because the cost of being wrong here is somebody's private task name on
	// the front page.
	if row.Handle == nil {
		return feedEntry{}, false
	}
	handle := *row.Handle

	// Dropped whole rather than masked. A row with the offending word starred
	// out is still a row that says somebody chose it, and there is nobody here
	// to report it to — the wordlist is checked at claim and at create, and
	// this catches what was added to the list after the fact.
	if profanity.Contains(handle) {
		return feedEntry{}, false
	}

	entry := feedEntry{
		Handle: handle,
		Kind:   string(kindOf(row.Kind)),
		EndsAt: row.EndsAt.Time.UnixMilli(),
	}

	// A break belongs to no task, and saying whose rest it is would be saying
	// what they had been working on.
	if kindOf(row.Kind) != timer.Work {
		return entry, true
	}

	// A private task, or one whose category has gone missing: the row still
	// shows — somebody is working, and that is the point of the feed — but the
	// name does not travel. Nothing about it reaches the client to be leaked by
	// a later bug, inspected in a network tab, or cached in a proxy.
	if row.CategoryName == nil || row.CategoryIsPublic == nil || !*row.CategoryIsPublic {
		return entry, true
	}

	// Public, so it is shown — and so it is checked. Only what would actually
	// be displayed is tested: a private name is never rendered anywhere a
	// stranger can see, so refusing somebody a place in the feed over one would
	// be a penalty for a word nobody was going to read.
	if profanity.Contains(*row.CategoryName) {
		return feedEntry{}, false
	}
	entry.Task = row.CategoryName
	return entry, true
}

// publishFeed pushes the feed to everybody watching it.
//
// Read fresh rather than handed the caller's own state, because this is a
// different question from "what is your timer": it spans every account, and the
// row that just changed is one line of it.
//
// Best-effort, like the timer's push. A visitor whose frame is lost sees a feed
// that is one session stale until the next change or the next reload, which is
// a cosmetic failure on a page that is itself a decoration.
func (s *Server) publishFeed(ctx context.Context, now time.Time) {
	ctx = context.WithoutCancel(ctx)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	state, err := s.feed(ctx, now)
	if err != nil {
		s.log.Error("read feed", "error", err)
		return
	}
	payload, err := json.Marshal(frame{Type: feedChanged, Feed: &state})
	if err != nil {
		s.log.Error("encode feed frame", "error", err)
		return
	}
	if err := s.live.Publish(ctx, feedTopic, payload); err != nil {
		s.log.Error("publish feed", "error", err)
	}
}

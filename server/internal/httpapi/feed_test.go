package httpapi_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// The feed is the only place one person's writing is shown to strangers under
// their name, and the only read in the app that needs no account. Most of what
// is worth asserting here is about what does *not* come out of it.

type feedEntry struct {
	Handle string  `json:"handle"`
	Kind   string  `json:"kind"`
	Task   *string `json:"task"`
	EndsAt int64   `json:"endsAt"`
}

type feedPayload struct {
	Entries   []feedEntry `json:"entries"`
	ServerNow int64       `json:"serverNow"`
}

func feed(t *testing.T, c *apitest.Client) feedPayload {
	t.Helper()
	var body feedPayload
	c.GET("/api/feed").ExpectStatus(http.StatusOK).JSON(&body)
	return body
}

// visitor is somebody who has never signed in — most of the feed's readers.
func visitor(h *apitest.Harness) *apitest.Client { return h.NewClient() }

// somebody signs a second person in, names them, and gives them a task.
func somebody(t *testing.T, h *apitest.Harness, address, handle, task string, public bool) (*apitest.Client, string) {
	t.Helper()
	client := h.SignIn(address)
	claim(client, handle).ExpectStatus(http.StatusOK)
	return client, createdCategory(t, createCategory(client, task, public)).ID
}

func TestTheFeedIsEmptyWhenNobodyIsWorking(t *testing.T) {
	h := apitest.New(t)
	signedIn(t, h)

	got := feed(t, visitor(h))
	// An array, not null: the landing holds a row's height either way, and a
	// client should not have to tell "nobody" from "not asked yet" by a shape.
	if got.Entries == nil {
		t.Fatal("the feed is null, and should be an empty array")
	}
	if len(got.Entries) != 0 {
		t.Errorf("the feed has %d entries, want none", len(got.Entries))
	}
}

func TestTheFeedNeedsNoAccount(t *testing.T) {
	h := apitest.New(t)
	worker, category := working(t, h)
	start(worker, category, pomodoro).ExpectStatus(http.StatusOK)

	// Never signed in, never will be. This is the front door.
	got := feed(t, visitor(h))
	if len(got.Entries) != 1 {
		t.Fatalf("a visitor sees %d entries, want 1", len(got.Entries))
	}
	if got.Entries[0].Handle != "yazdan" {
		t.Errorf("handle is %q, want yazdan", got.Entries[0].Handle)
	}
	if got.Entries[0].Task == nil || *got.Entries[0].Task != "درس" {
		t.Errorf("task is %v, want درس", got.Entries[0].Task)
	}
	if got.Entries[0].Kind != "work" {
		t.Errorf("kind is %q, want work", got.Entries[0].Kind)
	}
	// Absolute, so a row read late still says the same thing — and so the
	// client can drop it at the bell without being told to.
	if want := apitest.Origin.Add(25 * time.Minute).UnixMilli(); got.Entries[0].EndsAt != want {
		t.Errorf("endsAt is %d, want %d", got.Entries[0].EndsAt, want)
	}
}

// The privacy rule, and the strong form of it: the name does not reach the
// client at all, rather than reaching it and being hidden.
func TestAPrivateTasksNameNeverLeavesTheServer(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)
	secret := createdCategory(t, createCategory(client, "درمان", false)).ID
	start(client, secret, pomodoro).ExpectStatus(http.StatusOK)

	res := visitor(h).GET("/api/feed").ExpectStatus(http.StatusOK)
	// Asserted against the raw bytes, not the decoded struct: the claim is that
	// the name is not in the payload at all, and a field-by-field check would
	// pass on a payload that carried it somewhere else.
	if body := string(res.Body); strings.Contains(body, "درمان") {
		t.Fatalf("a private task's name is in the payload: %s", body)
	}

	var got feedPayload
	res.JSON(&got)
	if len(got.Entries) != 1 {
		t.Fatalf("the feed has %d entries, want 1 — a private task still shows somebody working", len(got.Entries))
	}
	if got.Entries[0].Task != nil {
		t.Errorf("task is %v, want null", got.Entries[0].Task)
	}
	if got.Entries[0].Handle != "yazdan" {
		t.Errorf("handle is %q, want yazdan", got.Entries[0].Handle)
	}
}

func TestABreakShowsWithoutATask(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	started := payload(t, start(client, category, pomodoro)).Session

	h.Clock.Advance(26 * time.Minute)
	client.POST("/api/session/"+started.ID+"/confirm", nil).ExpectStatus(http.StatusOK)

	got := feed(t, visitor(h))
	if len(got.Entries) != 1 {
		t.Fatalf("the feed has %d entries, want 1", len(got.Entries))
	}
	if got.Entries[0].Kind != "shortBreak" {
		t.Errorf("kind is %q, want shortBreak", got.Entries[0].Kind)
	}
	// A break belongs to no task, and naming one would be saying what the
	// person had been working on.
	if got.Entries[0].Task != nil {
		t.Errorf("a break carries a task: %v", got.Entries[0].Task)
	}
}

// Ring time is not work, so somebody leaves the feed at their bell rather than
// at the tap that acknowledges it.
func TestSomebodyLeavesTheFeedAtTheirBell(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	start(client, category, pomodoro).ExpectStatus(http.StatusOK)

	// A second before the bell: still working.
	h.Clock.Advance(25*time.Minute - time.Second)
	if got := feed(t, visitor(h)); len(got.Entries) != 1 {
		t.Fatalf("just before the bell the feed has %d entries, want 1", len(got.Entries))
	}

	// The bell. Nobody has touched anything, and the row is gone — a pomodoro
	// that finished twenty minutes ago must not still read as work in progress.
	h.Clock.Advance(2 * time.Second)
	if got := feed(t, visitor(h)); len(got.Entries) != 0 {
		t.Errorf("a ringing pomodoro is still in the feed: %+v", got.Entries)
	}
}

func TestAnAbandonedSessionLeavesTheFeed(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	started := payload(t, start(client, category, pomodoro)).Session

	client.POST("/api/session/"+started.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
	if got := feed(t, visitor(h)); len(got.Entries) != 0 {
		t.Errorf("an abandoned session is still in the feed: %+v", got.Entries)
	}
}

// An account exists from the moment a code is verified, before its owner has
// picked a name. There is nobody for the feed to name yet.
func TestSomebodyWithoutAHandleIsNotInTheFeed(t *testing.T) {
	h := apitest.New(t)
	nameless := h.SignIn("nameless@example.com")
	// No handle claimed, but a task and a session are still possible.
	category := createdCategory(t, createCategory(nameless, "درس", true)).ID
	start(nameless, category, pomodoro).ExpectStatus(http.StatusOK)

	if got := feed(t, visitor(h)); len(got.Entries) != 0 {
		t.Errorf("somebody with no handle is in the feed: %+v", got.Entries)
	}
}

func TestEverybodyWorkingIsInTheFeed(t *testing.T) {
	h := apitest.New(t)
	first, firstTask := working(t, h)
	second, secondTask := somebody(t, h, "second@example.com", "second", "ریاضی", true)

	start(first, firstTask, pomodoro).ExpectStatus(http.StatusOK)
	start(second, secondTask, pomodoro).ExpectStatus(http.StatusOK)

	got := feed(t, visitor(h))
	if len(got.Entries) != 2 {
		t.Fatalf("the feed has %d entries, want 2", len(got.Entries))
	}
	seen := map[string]bool{}
	for _, entry := range got.Entries {
		seen[entry.Handle] = true
	}
	if !seen["yazdan"] || !seen["second"] {
		t.Errorf("the feed is missing somebody: %+v", got.Entries)
	}
}

// The last gate.
//
// A profane handle or task cannot be created through the API — both are
// refused at claim and at create — so these rows are written straight to the
// database, which is exactly the case the gate exists for: a word added to the
// wordlist after somebody already had it.
func TestAProfaneRowIsDroppedWhole(t *testing.T) {
	h := apitest.New(t)
	clean, cleanTask := working(t, h)
	start(clean, cleanTask, pomodoro).ExpectStatus(http.StatusOK)

	// Never claimed through the API, because the API would refuse it. The
	// handle is written straight onto an account that has none — which the
	// immutability trigger allows, since it only refuses *changing* one.
	rude := h.SignIn("rude@example.com")
	rudeTask := createdCategory(t, createCategory(rude, "ریاضی", true)).ID
	start(rude, rudeTask, pomodoro).ExpectStatus(http.StatusOK)
	nameDirectly(t, h, "rude@example.com", "koskesh")

	got := feed(t, visitor(h))
	if len(got.Entries) != 1 {
		t.Fatalf("the feed has %d entries, want 1 — the profane row should be gone", len(got.Entries))
	}
	if got.Entries[0].Handle != "yazdan" {
		t.Errorf("the wrong row survived: %+v", got.Entries[0])
	}
	// Dropped whole rather than masked: a row with the word starred out still
	// says somebody chose it, and there is nobody here to report it to.
	if body := string(visitor(h).GET("/api/feed").Body); strings.Contains(body, "koskesh") {
		t.Errorf("the handle is still in the payload: %s", body)
	}
}

func TestAProfaneTaskDropsTheRow(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)
	start(client, category, pomodoro).ExpectStatus(http.StatusOK)

	renameCategory(t, h, category, "fuck")

	if got := feed(t, visitor(h)); len(got.Entries) != 0 {
		t.Errorf("a row with a profane task survived: %+v", got.Entries)
	}
}

// A private name is never rendered to a stranger, so a word in one is a word
// nobody was going to read — and taking somebody's place in the feed over it
// would be a penalty for nothing.
func TestAProfanePrivateTaskKeepsTheRow(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)
	secret := createdCategory(t, createCategory(client, "درمان", false)).ID
	start(client, secret, pomodoro).ExpectStatus(http.StatusOK)

	renameCategory(t, h, secret, "fuck")

	got := feed(t, visitor(h))
	if len(got.Entries) != 1 {
		t.Fatalf("the feed has %d entries, want 1", len(got.Entries))
	}
	if got.Entries[0].Task != nil {
		t.Errorf("a private task's name travelled: %v", got.Entries[0].Task)
	}
	if body := string(visitor(h).GET("/api/feed").Body); strings.Contains(body, "fuck") {
		t.Errorf("the private name is in the payload: %s", body)
	}
}

// nameDirectly writes a handle the API would refuse, onto an account that has
// not claimed one. A handle is immutable once set, so this is the only way such
// a row can exist at all — and it is how one really would: the word was added
// to the list after the name was taken.
func nameDirectly(t *testing.T, h *apitest.Harness, email, handle string) {
	t.Helper()
	exec(t, h, `UPDATE users SET handle = $2, handle_set_at = now() WHERE email = $1`, email, handle)
}

// renameCategory writes a task name the API would refuse.
func renameCategory(t *testing.T, h *apitest.Harness, id, name string) {
	t.Helper()
	exec(t, h, `UPDATE categories SET name = $2 WHERE id = $1`, id, name)
}

func exec(t *testing.T, h *apitest.Harness, sql string, args ...any) {
	t.Helper()
	if _, err := h.DB.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

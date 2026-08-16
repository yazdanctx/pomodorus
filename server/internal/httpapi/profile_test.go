package httpapi_test

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// A profile is a link somebody sent to somebody else, so almost everything here
// is asserted as a visitor who has never signed in.

type profileDay struct {
	Day     string        `json:"day"`
	TotalMs int64         `json:"totalMs"`
	Tasks   []profileTask `json:"tasks"`
}

// One row of a day's detail. The name is absent for the two rows that have
// none: a stranger's view of the private tasks, and work with no task at all.
type profileTask struct {
	Kind    string  `json:"kind"`
	Name    *string `json:"name"`
	TotalMs int64   `json:"totalMs"`
}

type profilePayload struct {
	Handle string       `json:"handle"`
	Days   []profileDay `json:"days"`
	// Whether this person has ever finished a pomodoro — a different question
	// from whether the selected range has anything in it.
	EverFocused bool `json:"everFocused"`
	// Whether this is the reader's own profile, which is to say whether the
	// task names in it are the real ones.
	Owner     bool  `json:"owner"`
	ServerNow int64 `json:"serverNow"`
}

func profileOf(t *testing.T, c *apitest.Client, handle string, query string) profilePayload {
	t.Helper()
	var body profilePayload
	c.GET("/api/profile/" + handle + query).ExpectStatus(http.StatusOK).JSON(&body)
	return body
}

// totals is the chart as a lookup, for asserting about one day at a time.
func totals(chart profilePayload) map[string]int64 {
	out := make(map[string]int64, len(chart.Days))
	for _, day := range chart.Days {
		out[day.Day] = day.TotalMs
	}
	return out
}

func TestAProfileIsReadableWithoutSigningIn(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)
	finish(t, h, owner, category, 25*time.Minute)

	got := profileOf(t, visitor(h), "yazdan", "")
	if got.Handle != "yazdan" {
		t.Errorf("handle is %q, want yazdan", got.Handle)
	}
	if totals(got)[apitest.OriginDay] != (25 * time.Minute).Milliseconds() {
		t.Errorf("today totals %d, want %d", totals(got)[apitest.OriginDay], (25 * time.Minute).Milliseconds())
	}
}

// The URL is typed by a person, and citext folds case — so a link that arrived
// capitalised finds the same profile and echoes the canonical name back.
func TestAHandleIsFoundWhateverItsCase(t *testing.T) {
	h := apitest.New(t)
	signedIn(t, h)

	got := profileOf(t, visitor(h), "YaZdAn", "")
	if got.Handle != "yazdan" {
		t.Errorf("handle is %q, want the canonical yazdan", got.Handle)
	}
}

func TestAnUnknownHandleIsNotFound(t *testing.T) {
	h := apitest.New(t)
	signedIn(t, h)

	// Not an empty chart: the page has to be able to say "no such person"
	// rather than draw a flat line for somebody who does not exist.
	visitor(h).GET("/api/profile/nobody").ExpectError(http.StatusNotFound, "profile_not_found")
	// And a string that could never be a handle is the same answer, without a
	// lookup being made at all.
	visitor(h).GET("/api/profile/x").ExpectError(http.StatusNotFound, "profile_not_found")
}

func TestTheChartDefaultsToSevenDays(t *testing.T) {
	h := apitest.New(t)
	signedIn(t, h)

	got := profileOf(t, visitor(h), "yazdan", "")
	if len(got.Days) != 7 {
		t.Errorf("the default chart has %d days, want 7", len(got.Days))
	}
	// Ending today, which is the column the eye goes to.
	if last := got.Days[len(got.Days)-1].Day; last != apitest.OriginDay {
		t.Errorf("the last column is %s, want today (%s)", last, apitest.OriginDay)
	}
}

func TestTheThreeRangesAreOffered(t *testing.T) {
	h := apitest.New(t)
	signedIn(t, h)

	for _, days := range []int{7, 30, 90} {
		got := profileOf(t, visitor(h), "yazdan", fmt.Sprintf("?days=%d", days))
		if len(got.Days) != days {
			t.Errorf("?days=%d returned %d columns, want %d", days, len(got.Days), days)
		}
	}
}

// A client is a claim. Aggregating ten thousand days on request is not a thing
// this endpoint will do.
func TestAnUnofferedRangeIsRefused(t *testing.T) {
	h := apitest.New(t)
	signedIn(t, h)

	for _, query := range []string{"?days=1", "?days=365", "?days=10000", "?days=0", "?days=-7", "?days=abc"} {
		visitor(h).GET("/api/profile/yazdan"+query).ExpectError(http.StatusBadRequest, "bad_range")
	}
}

func TestEmptyDaysAreZeroFilled(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)
	finish(t, h, owner, category, 25*time.Minute)

	got := profileOf(t, visitor(h), "yazdan", "")
	if len(got.Days) != 7 {
		t.Fatalf("the chart has %d days, want 7", len(got.Days))
	}
	// Six days of nothing and one of work — present as zeroes rather than
	// missing, because a line through only the worked days would read a week
	// off as flat effort.
	worked := 0
	for _, day := range got.Days {
		if day.TotalMs > 0 {
			worked++
		}
	}
	if worked != 1 {
		t.Errorf("%d days have focus time, want 1", worked)
	}
}

func TestOnlyCreditedWorkCounts(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)

	// One seen through.
	finish(t, h, owner, category, 25*time.Minute)

	// One abandoned, which is not credited and never will be.
	abandoned := payload(t, start(owner, category, pomodoro)).Session
	h.Clock.Advance(5 * time.Minute)
	owner.POST("/api/session/"+abandoned.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
	h.Clock.Advance(30 * time.Minute)

	// And a break, which is rest rather than focus.
	rested := payload(t, start(owner, category, pomodoro)).Session
	h.Clock.Advance(26 * time.Minute)
	owner.POST("/api/session/"+rested.ID+"/confirm", nil).ExpectStatus(http.StatusOK)
	h.Clock.Advance(10 * time.Minute)

	got := profileOf(t, visitor(h), "yazdan", "")
	// Two pomodoros of twenty-five minutes. The abandoned one and the break
	// are both absent.
	if want := (50 * time.Minute).Milliseconds(); totals(got)[apitest.OriginDay] != want {
		t.Errorf("today totals %d, want %d", totals(got)[apitest.OriginDay], want)
	}
}

func TestSomebodyElsesWorkIsNotOnThisChart(t *testing.T) {
	h := apitest.New(t)
	mine, category := working(t, h)
	finish(t, h, mine, category, 25*time.Minute)

	stranger, theirs := somebody(t, h, "second@example.com", "second", "ریاضی", true)
	finish(t, h, stranger, theirs, 30*time.Minute)
	finish(t, h, stranger, theirs, 30*time.Minute)

	if got := totals(profileOf(t, visitor(h), "yazdan", "")); got[apitest.OriginDay] != (25 * time.Minute).Milliseconds() {
		t.Errorf("my chart totals %d, want only my own 25m", got[apitest.OriginDay])
	}
	if got := totals(profileOf(t, visitor(h), "second", "")); got[apitest.OriginDay] != (60 * time.Minute).Milliseconds() {
		t.Errorf("their chart totals %d, want their own 60m", got[apitest.OriginDay])
	}
}

// Somebody who has never finished a pomodoro still has a profile — a real,
// well-formed, entirely empty chart, which is what the page's empty state is
// drawn from.
func TestAProfileWithNoFocusTimeIsStillAProfile(t *testing.T) {
	h := apitest.New(t)
	signedIn(t, h)

	got := profileOf(t, visitor(h), "yazdan", "")
	if len(got.Days) != 7 {
		t.Fatalf("the chart has %d days, want 7", len(got.Days))
	}
	for _, day := range got.Days {
		if day.TotalMs != 0 {
			t.Errorf("%s totals %d on an empty profile", day.Day, day.TotalMs)
		}
	}
}

// The columns are Tehran days, so a pomodoro either side of Tehran midnight
// lands in different ones — and neither is where UTC would have put it.
func TestColumnsAreTehranDays(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)

	// Ends at 23:50 Tehran on the origin's day.
	h.Clock.Set(tehranMidnight.Add(-35 * time.Minute))
	finish(t, h, owner, category, 25*time.Minute)

	// Ends at 00:20 Tehran, the next day — twenty minutes later by the clock,
	// and a different column.
	h.Clock.Set(tehranMidnight.Add(-5 * time.Minute))
	finish(t, h, owner, category, 25*time.Minute)

	got := totals(profileOf(t, visitor(h), "yazdan", ""))
	if got["2026-03-15"] != (25 * time.Minute).Milliseconds() {
		t.Errorf("the 15th totals %d, want 25m", got["2026-03-15"])
	}
	if got["2026-03-16"] != (25 * time.Minute).Milliseconds() {
		t.Errorf("the 16th totals %d, want 25m", got["2026-03-16"])
	}
}

// The empty state belongs to somebody who has never focused, not to a range
// that happens to be empty — which is the difference between "this person is
// new" and "this person took a week off".
func TestAWeekOffIsNotAnEmptyProfile(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)
	finish(t, h, owner, category, 25*time.Minute)

	// A fortnight later, with nothing in between.
	h.Clock.Advance(14 * 24 * time.Hour)

	got := profileOf(t, visitor(h), "yazdan", "")
	// The last seven days are all zero...
	for _, day := range got.Days {
		if day.TotalMs != 0 {
			t.Fatalf("%s has focus time, and the fortnight should be empty", day.Day)
		}
	}
	// ...and this person is still somebody who works. The chart draws a flat
	// line, which is what the zero-fill is for; the empty state would be a
	// claim about them rather than about the week.
	if !got.EverFocused {
		t.Error("a fortnight off reads as a profile that has never focused")
	}
}

func TestAProfileThatHasNeverFocusedSaysSo(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)

	if got := profileOf(t, visitor(h), "yazdan", ""); got.EverFocused {
		t.Error("a fresh account has focused")
	}

	// An abandoned pomodoro is not focus time, so it does not change the answer.
	abandoned := payload(t, start(owner, category, pomodoro)).Session
	owner.POST("/api/session/"+abandoned.ID+"/cancel", nil).ExpectStatus(http.StatusOK)
	if got := profileOf(t, visitor(h), "yazdan", ""); got.EverFocused {
		t.Error("an abandoned pomodoro counts as having focused")
	}

	// One seen through does.
	finish(t, h, owner, category, 25*time.Minute)
	if got := profileOf(t, visitor(h), "yazdan", ""); !got.EverFocused {
		t.Error("a finished pomodoro does not count as having focused")
	}
}

// Work older than the range still counts as having focused, which is the whole
// point of asking separately from the chart.
func TestEverFocusedLooksPastTheRange(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)
	finish(t, h, owner, category, 25*time.Minute)

	h.Clock.Advance(200 * 24 * time.Hour)

	got := profileOf(t, visitor(h), "yazdan", "?days=90")
	if !got.EverFocused {
		t.Error("work older than ninety days reads as never having focused")
	}
}

// The day detail: what one day on the chart was actually made of, and how much
// of it a stranger is entitled to.

// detail is one day's rows as `kind:name duration-in-minutes` strings, in the
// order they arrived — the order is part of what is being asserted.
func detail(chart profilePayload, day string) []string {
	for _, column := range chart.Days {
		if column.Day != day {
			continue
		}
		out := make([]string, 0, len(column.Tasks))
		for _, task := range column.Tasks {
			name := ""
			if task.Name != nil {
				name = *task.Name
			}
			out = append(out, fmt.Sprintf("%s:%s %dm", task.Kind, name, task.TotalMs/60_000))
		}
		return out
	}
	return nil
}

func TestADayBreaksDownByTaskLargestFirst(t *testing.T) {
	h := apitest.New(t)
	owner, drills := working(t, h)
	maths := createdCategory(t, createCategory(owner, "ریاضی", true)).ID

	finish(t, h, owner, drills, 25*time.Minute)
	finish(t, h, owner, maths, 30*time.Minute)
	// The same task twice is one row of fifty minutes, not two of twenty-five
	// — which is also what puts it above the longer single pomodoro.
	finish(t, h, owner, drills, 25*time.Minute)

	got := detail(profileOf(t, visitor(h), "yazdan", ""), apitest.OriginDay)
	want := []string{"task:درس 50m", "task:ریاضی 30m"}
	if !slices.Equal(got, want) {
		t.Errorf("the day reads %v, want %v", got, want)
	}
}

// The masking, which is the whole reason this endpoint has an opinion about
// who is reading it.
func TestAVisitorSeesOneMaskedRowForEveryPrivateTask(t *testing.T) {
	h := apitest.New(t)
	owner, shown := working(t, h)
	hidden := createdCategory(t, createCategory(owner, "درمان", false)).ID
	alsoHidden := createdCategory(t, createCategory(owner, "وکیل", false)).ID

	finish(t, h, owner, shown, 25*time.Minute)
	finish(t, h, owner, hidden, 30*time.Minute)
	finish(t, h, owner, alsoHidden, 20*time.Minute)

	// One row for all of them: how long somebody worked is public, and what
	// they were doing is theirs.
	got := detail(profileOf(t, visitor(h), "yazdan", ""), apitest.OriginDay)
	want := []string{"private: 50m", "task:درس 25m"}
	if !slices.Equal(got, want) {
		t.Errorf("a visitor reads %v, want %v", got, want)
	}

	// And the names are not in the response at all — not in a field the client
	// is trusted not to render, not anywhere. A private name that reaches the
	// browser is one bug, one network tab or one cache away from being read.
	body := string(visitor(h).GET("/api/profile/yazdan").Body)
	for _, name := range []string{"درمان", "وکیل"} {
		if strings.Contains(body, name) {
			t.Errorf("the private task %q reached the client: %s", name, body)
		}
	}
}

func TestTheOwnerSeesTheirOwnTaskNames(t *testing.T) {
	h := apitest.New(t)
	owner, shown := working(t, h)
	hidden := createdCategory(t, createCategory(owner, "درمان", false)).ID

	finish(t, h, owner, shown, 25*time.Minute)
	finish(t, h, owner, hidden, 30*time.Minute)

	got := profileOf(t, owner, "yazdan", "")
	// Masking somebody's own history from them would be the page lying to the
	// only person entitled to it.
	if want := []string{"task:درمان 30m", "task:درس 25m"}; !slices.Equal(detail(got, apitest.OriginDay), want) {
		t.Errorf("the owner reads %v, want %v", detail(got, apitest.OriginDay), want)
	}
	// And is told that this is the owner's view, which is what the page says
	// out loud: seeing your private tasks named is exactly the moment you
	// might think strangers can too.
	if !got.Owner {
		t.Error("the owner is not told it is their own profile")
	}
}

// Signed in is not the same as being the owner — everybody else reads the page
// exactly as a stranger does.
func TestSomebodyElseSignedInIsStillAVisitor(t *testing.T) {
	h := apitest.New(t)
	owner, hidden := working(t, h)
	renameCategory(t, h, hidden, "درمان")
	makePrivate(t, h, hidden)
	finish(t, h, owner, hidden, 25*time.Minute)

	stranger, _ := somebody(t, h, "second@example.com", "second", "ریاضی", true)

	got := profileOf(t, stranger, "yazdan", "")
	if got.Owner {
		t.Error("a stranger is told the profile is theirs")
	}
	if want := []string{"private: 25m"}; !slices.Equal(detail(got, apitest.OriginDay), want) {
		t.Errorf("a signed-in stranger reads %v, want %v", detail(got, apitest.OriginDay), want)
	}
	if got := profileOf(t, visitor(h), "yazdan", ""); got.Owner {
		t.Error("a visitor who has never signed in is told the profile is theirs")
	}
}

// Tidying a task list is not an edit to the history recorded against it.
func TestADeletedTaskKeepsItsNameInTheDetail(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)
	finish(t, h, owner, category, 25*time.Minute)

	owner.POST("/api/categories/"+category+"/delete", nil).ExpectStatus(http.StatusNoContent)

	// The tombstone keeps the name, and the row keeps pointing at it — for the
	// owner and for a stranger alike, since the task was public.
	for _, reader := range map[string]*apitest.Client{"the owner": owner, "a visitor": visitor(h)} {
		got := detail(profileOf(t, reader, "yazdan", ""), apitest.OriginDay)
		if want := []string{"task:درس 25m"}; !slices.Equal(got, want) {
			t.Errorf("%v, want %v", got, want)
		}
	}
}

// Work recorded against no task at all is its own row, shown to everybody
// alike: it is not masking anything, so calling it private would be a claim
// about it that is not true.
func TestUntaskedWorkIsOneUnmaskedRow(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)
	finish(t, h, owner, category, 25*time.Minute)
	finish(t, h, owner, category, 30*time.Minute)

	// The API will not start a pomodoro without a task, so the only way such a
	// row exists is directly — which is how one would arrive from a client
	// older than the rule, or a task list that lost a row.
	untask(t, h, 30*time.Minute)

	got := detail(profileOf(t, visitor(h), "yazdan", ""), apitest.OriginDay)
	if want := []string{"none: 30m", "task:درس 25m"}; !slices.Equal(got, want) {
		t.Errorf("the day reads %v, want %v", got, want)
	}
}

// A day nobody worked has no detail at all, rather than a detail that says
// zero — the panel is not rendered for one.
func TestAnEmptyDayHasNoDetail(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)
	finish(t, h, owner, category, 25*time.Minute)

	got := profileOf(t, visitor(h), "yazdan", "")
	for _, day := range got.Days {
		// An array either way, so the client tells "no detail" from "not sent"
		// by the total it already has rather than by a shape.
		if day.Tasks == nil {
			t.Errorf("%s carries a null detail, want an empty array", day.Day)
		}
		if day.TotalMs == 0 && len(day.Tasks) != 0 {
			t.Errorf("%s totals nothing but has %d rows", day.Day, len(day.Tasks))
		}
	}
}

// The last gate on profanity, as in the feed: the wordlist is checked when a
// task is named, and this catches what was added to the list afterwards.
func TestAProfanePublicTaskIsMaskedFromVisitors(t *testing.T) {
	h := apitest.New(t)
	owner, category := working(t, h)
	renameCategory(t, h, category, "koskesh")
	finish(t, h, owner, category, 25*time.Minute)

	got := profileOf(t, visitor(h), "yazdan", "")
	// Masked rather than dropped: the day's total is not the offending part,
	// and rows that did not add up to it would be a second bug.
	if want := []string{"private: 25m"}; !slices.Equal(detail(got, apitest.OriginDay), want) {
		t.Errorf("a visitor reads %v, want %v", detail(got, apitest.OriginDay), want)
	}
	if totals(got)[apitest.OriginDay] != (25 * time.Minute).Milliseconds() {
		t.Errorf("the day totals %d, want the work to still count", totals(got)[apitest.OriginDay])
	}
	if body := string(visitor(h).GET("/api/profile/yazdan").Body); strings.Contains(body, "koskesh") {
		t.Errorf("the profane task reached the client: %s", body)
	}
}

// makePrivate takes a task's name back out of public view, which the API does
// too — this is just shorter than a round trip through the picker.
func makePrivate(t *testing.T, h *apitest.Harness, id string) {
	t.Helper()
	exec(t, h, `UPDATE categories SET is_public = false WHERE id = $1`, id)
}

// untask strips the task off the most recent credited pomodoro of `length`.
func untask(t *testing.T, h *apitest.Harness, length time.Duration) {
	t.Helper()
	exec(t, h, `UPDATE sessions SET category_id = NULL
	            WHERE id = (SELECT id FROM sessions
	                        WHERE kind = 'work' AND duration_ms = $1
	                        ORDER BY ends_at DESC LIMIT 1)`, length.Milliseconds())
}

// The same URL answers a stranger and the owner differently, and the
// difference is somebody's private task names.
func TestAProfileIsNotCachedBetweenReaders(t *testing.T) {
	h := apitest.New(t)
	signedIn(t, h)

	res := visitor(h).GET("/api/profile/yazdan").ExpectStatus(http.StatusOK)
	if got := res.Header.Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("Cache-Control is %q, want private, no-store", got)
	}
	// Belt and braces for anything that stores it anyway: the cookie is what
	// the answer varies on.
	if got := res.Header.Get("Vary"); got != "Cookie" {
		t.Errorf("Vary is %q, want Cookie", got)
	}
}

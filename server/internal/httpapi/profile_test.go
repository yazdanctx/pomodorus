package httpapi_test

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// A profile is a link somebody sent to somebody else, so almost everything here
// is asserted as a visitor who has never signed in.

type profileDay struct {
	Day     string `json:"day"`
	TotalMs int64  `json:"totalMs"`
}

type profilePayload struct {
	Handle string       `json:"handle"`
	Days   []profileDay `json:"days"`
	// Whether this person has ever finished a pomodoro — a different question
	// from whether the selected range has anything in it.
	EverFocused bool  `json:"everFocused"`
	ServerNow   int64 `json:"serverNow"`
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

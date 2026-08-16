package timer_test

import (
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/timer"
)

// Tehran runs +03:30, so a Tehran day begins at 20:30 UTC the calendar day
// before. Every case here is written in UTC on purpose: that is what the
// database stores and what crosses the wire, and a test written in local time
// would agree with the implementation by sharing its assumption.
func TestDayStart(t *testing.T) {
	cases := []struct {
		name string
		at   string
		want string
	}{
		{
			// Midday in Tehran, comfortably inside the day.
			name: "midday",
			at:   "2026-03-15T09:00:00Z",
			want: "2026-03-14T20:30:00Z",
		},
		{
			// The boundary itself belongs to the day it opens.
			name: "the instant the day begins",
			at:   "2026-03-14T20:30:00Z",
			want: "2026-03-14T20:30:00Z",
		},
		{
			// One millisecond earlier is still the day before — this is the
			// case a UTC-bucketing implementation gets wrong.
			name: "a moment before the day begins",
			at:   "2026-03-14T20:29:59.999Z",
			want: "2026-03-13T20:30:00Z",
		},
		{
			// Midnight UTC is half past three in the morning in Tehran, which
			// is the same Tehran day that began the previous evening. A server
			// bucketing by its own midnight would put this in the wrong day.
			name: "midnight UTC is not a boundary",
			at:   "2026-03-15T00:00:00Z",
			want: "2026-03-14T20:30:00Z",
		},
		{
			// And across a Gregorian month end, where naive arithmetic on the
			// day number goes wrong.
			name: "across a month boundary",
			at:   "2026-03-31T21:00:00Z",
			want: "2026-03-31T20:30:00Z",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := timer.DayStart(parse(t, c.at))
			if want := parse(t, c.want); !got.Equal(want) {
				t.Errorf("DayStart(%s) = %s, want %s", c.at, got.Format(time.RFC3339Nano), c.want)
			}
			// Returned as UTC, so nothing downstream carries a location.
			if got.Location() != time.UTC {
				t.Errorf("DayStart returned a %s time, want UTC", got.Location())
			}
		})
	}
}

// A day is exactly a day: Iran has had no daylight saving since 2022, so
// nothing in the chart is ever twenty-three hours wide.
func TestADayIsTwentyFourHours(t *testing.T) {
	at := parse(t, "2026-03-15T09:00:00Z")
	for range 400 {
		start := timer.DayStart(at)
		next := timer.DayStart(start.Add(25 * time.Hour))
		if got := next.Sub(start); got != 24*time.Hour {
			t.Fatalf("the day beginning %s is %s long, want 24h", start, got)
		}
		at = at.Add(24 * time.Hour)
	}
}

// Two instants in the same Tehran day share a start, and the boundary is the
// only place that stops being true.
func TestDayStartIsStableWithinADay(t *testing.T) {
	morning := timer.DayStart(parse(t, "2026-03-14T20:30:00Z"))
	evening := timer.DayStart(parse(t, "2026-03-15T20:29:59.999Z"))
	if !morning.Equal(evening) {
		t.Errorf("the same Tehran day gave two starts: %s and %s", morning, evening)
	}

	// And one millisecond later is a different day.
	next := timer.DayStart(parse(t, "2026-03-15T20:30:00Z"))
	if next.Equal(morning) {
		t.Error("the day did not turn over at the boundary")
	}
}

func TestDayKey(t *testing.T) {
	cases := map[string]string{
		// Half past three in the morning Tehran, still the 15th there.
		"2026-03-15T00:00:00Z": "2026-03-15",
		// Eight in the evening UTC is half past eleven at night Tehran — the
		// last half hour of the Tehran day, and the case a UTC key gets wrong.
		"2026-03-15T20:00:00Z": "2026-03-15",
		// Half an hour later the day has turned.
		"2026-03-15T20:30:00Z": "2026-03-16",
	}
	for at, want := range cases {
		if got := timer.DayKey(parse(t, at)); got != want {
			t.Errorf("DayKey(%s) = %s, want %s", at, got, want)
		}
	}
}

func parse(t *testing.T, value string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return at.UTC()
}

// The chart's shape is the whole reason zero-filling matters, so these are
// mostly about the days nobody worked.
func TestDaysCoversEveryDayInTheRange(t *testing.T) {
	from := parse(t, "2026-03-10T09:00:00Z")
	to := parse(t, "2026-03-15T09:00:00Z")

	days := timer.Days(from, to, nil)

	// Six days inclusive, in order, none missing.
	want := []string{"2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15"}
	if len(days) != len(want) {
		t.Fatalf("got %d days, want %d: %+v", len(days), len(want), days)
	}
	for i, key := range want {
		if days[i].Key != key {
			t.Errorf("day %d is %s, want %s", i, days[i].Key, key)
		}
		// A day nobody worked is zero, not absent: a line drawn only through
		// the days somebody worked would read a fortnight off as flat effort.
		if days[i].Total != 0 {
			t.Errorf("day %s totals %s, want nothing", key, days[i].Total)
		}
	}
}

func TestDaysTotalsWhatWasCreditedInEach(t *testing.T) {
	from := parse(t, "2026-03-13T09:00:00Z")
	to := parse(t, "2026-03-15T09:00:00Z")

	days := timer.Days(from, to, []timer.Credited{
		{EndsAt: parse(t, "2026-03-13T10:00:00Z"), Length: 25 * time.Minute},
		{EndsAt: parse(t, "2026-03-13T11:00:00Z"), Length: 30 * time.Minute},
		// Nothing on the 14th.
		{EndsAt: parse(t, "2026-03-15T08:00:00Z"), Length: 25 * time.Minute},
	})

	got := map[string]time.Duration{}
	for _, day := range days {
		got[day.Key] = day.Total
	}
	for key, want := range map[string]time.Duration{
		"2026-03-13": 55 * time.Minute,
		"2026-03-14": 0,
		"2026-03-15": 25 * time.Minute,
	} {
		if got[key] != want {
			t.Errorf("%s totals %s, want %s", key, got[key], want)
		}
	}
}

// The boundary again, from the chart's side: a bell twenty minutes either side
// of Tehran midnight lands in different columns, and neither is where UTC
// would have put it.
func TestDaysBucketByTehranMidnight(t *testing.T) {
	from := parse(t, "2026-03-14T09:00:00Z")
	to := parse(t, "2026-03-16T09:00:00Z")

	days := timer.Days(from, to, []timer.Credited{
		// 20:20 UTC is 23:50 in Tehran on the 14th — the last of that day.
		{EndsAt: parse(t, "2026-03-14T20:20:00Z"), Length: 25 * time.Minute},
		// 20:40 UTC is 00:10 in Tehran, which is the 15th.
		{EndsAt: parse(t, "2026-03-14T20:40:00Z"), Length: 30 * time.Minute},
	})

	got := map[string]time.Duration{}
	for _, day := range days {
		got[day.Key] = day.Total
	}
	if got["2026-03-14"] != 25*time.Minute {
		t.Errorf("the 14th totals %s, want 25m", got["2026-03-14"])
	}
	if got["2026-03-15"] != 30*time.Minute {
		t.Errorf("the 15th totals %s, want 30m", got["2026-03-15"])
	}
}

// A single day is a range like any other, and the commonest one on the chart's
// shortest preset.
func TestDaysHandlesASingleDay(t *testing.T) {
	at := parse(t, "2026-03-15T09:00:00Z")
	days := timer.Days(at, at, []timer.Credited{{EndsAt: at, Length: 25 * time.Minute}})

	if len(days) != 1 {
		t.Fatalf("got %d days, want 1: %+v", len(days), days)
	}
	if days[0].Key != "2026-03-15" || days[0].Total != 25*time.Minute {
		t.Errorf("got %+v, want 2026-03-15 at 25m", days[0])
	}
}

// Ninety days is the longest preset, and the one where an off-by-one in the
// walk would show up as a missing column.
func TestDaysWalksALongRangeExactly(t *testing.T) {
	to := parse(t, "2026-06-15T09:00:00Z")
	from := to.Add(-89 * 24 * time.Hour)

	days := timer.Days(from, to, nil)
	if len(days) != 90 {
		t.Fatalf("got %d days over the ninety-day preset, want 90", len(days))
	}
	if days[0].Key != timer.DayKey(from) || days[89].Key != timer.DayKey(to) {
		t.Errorf("the range runs %s..%s, want %s..%s",
			days[0].Key, days[89].Key, timer.DayKey(from), timer.DayKey(to))
	}
}

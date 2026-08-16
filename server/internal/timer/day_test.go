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

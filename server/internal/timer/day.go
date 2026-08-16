package timer

import (
	"time"
	// Embedded rather than read from the host, because the host is a container
	// that may carry no zoneinfo at all. A missing database would not fail —
	// LoadLocation would hand back UTC and every day would silently bucket
	// three and a half hours early, which is a wrong chart rather than a
	// crash. This is the one import in the domain package that is about
	// deployment, and it is here because that is where the failure would land.
	_ "time/tzdata"
)

// Tehran is where a day begins and ends, for everyone.
//
// The app is Persian and its users are in Iran, so the day is theirs rather
// than the server's or the device's: a pomodoro at 00:30 Tehran belongs to the
// day that just started, whether the server is in Frankfurt and the reader on
// a laptop still set to UTC. Every other instant in this app is UTC epoch
// milliseconds, and this is the single point where a zone is consulted at all.
//
// Iran abolished daylight saving in 2022, so the offset is a flat +03:30 and a
// day is always twenty-four hours long. Nothing here relies on that — the
// zoneinfo is asked rather than assumed — but it is why no day in the chart
// will ever be twenty-three.
var Tehran = mustLoad("Asia/Tehran")

func mustLoad(name string) *time.Location {
	location, err := time.LoadLocation(name)
	if err != nil {
		// Unreachable with the embedded database above, and a panic rather
		// than a fallback on purpose: bucketing days by the wrong zone is a
		// quiet, permanent corruption of somebody's history, and refusing to
		// boot is the cheaper failure.
		panic("timer: cannot load " + name + ": " + err.Error())
	}
	return location
}

// DayStart is the instant the Tehran day containing `at` began.
//
// The returned instant is an ordinary UTC time like every other in this app —
// the zone is used to decide *where* the boundary falls and is then dropped,
// so nothing downstream has to carry a location around.
func DayStart(at time.Time) time.Time {
	local := at.In(Tehran)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, Tehran).UTC()
}

// Credited is one pomodoro's contribution to a day: when its bell went, and the
// nominal length that bell paid for.
//
// The length is carried rather than derived from the instants, because under
// fast sessions those are not the same number — the chart is built from what
// was credited, not from how long the row happened to be open.
type Credited struct {
	EndsAt time.Time
	Length time.Duration
}

// Day is one column of the chart: a Tehran day, and the focus time credited in
// it.
type Day struct {
	// Key is `YYYY-MM-DD`, in Tehran. A day is not a moment, and sending one as
	// an instant is how a chart ends up with a column in the wrong place.
	Key   string
	Total time.Duration
}

// Days totals focus time per Tehran day across a closed range, with every day
// in it present.
//
// Zero-filling is the point rather than a convenience. A line drawn only
// through the days somebody worked has no gaps in it, so a fortnight off reads
// as a flat stretch of effort instead of the absence it was — the shape of the
// chart would be a lie told by omission.
//
// The range is walked by day boundary rather than by adding twenty-four hours,
// so it stays correct if Iran ever restores daylight saving.
func Days(from, to time.Time, credited []Credited) []Day {
	totals := make(map[string]time.Duration, len(credited))
	for _, one := range credited {
		totals[DayKey(one.EndsAt)] += one.Length
	}

	days := make([]Day, 0, 1+int(to.Sub(from)/(24*time.Hour)))
	for at := DayStart(from); !at.After(to); at = DayStart(at.Add(36 * time.Hour)) {
		key := DayKey(at)
		days = append(days, Day{Key: key, Total: totals[key]})
	}
	return days
}

// DayKey is the Tehran day containing `at`, as `YYYY-MM-DD`.
//
// This is how a day is named on the wire and in a chart's axis: a bare key,
// not an instant, because a day is not a moment and rendering it as one is how
// a chart ends up with a column in the wrong place. The client resolves it
// back at noon UTC, which is unambiguously inside the Tehran day whatever the
// offset.
func DayKey(at time.Time) string {
	return at.In(Tehran).Format(time.DateOnly)
}

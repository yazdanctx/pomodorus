package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/yazdanctx/pomodorus/server/internal/profanity"
)

const wordlistPath = "../../internal/profanity/profanity.json"

func checkedIn(t *testing.T) profanity.Wordlist {
	t.Helper()
	body, err := os.ReadFile(wordlistPath)
	if err != nil {
		t.Fatal(err)
	}
	var w profanity.Wordlist
	if err := json.Unmarshal(body, &w); err != nil {
		t.Fatal(err)
	}
	return w
}

// asSources feeds a wordlist back in as though the public sources had
// published exactly it. Everything in it is already folded and already
// curated, so a faithful generator must hand back the same list — which is
// what makes this a test of idempotence and not merely of sorting.
func asSources(w profanity.Wordlist) inputs {
	return inputs{
		persian: w.Fa,
		english: append(append([]string{}, w.LatinWords...), w.LatinParts...),
	}
}

func TestRegenerationIsIdempotent(t *testing.T) {
	want := checkedIn(t)
	got := assemble(asSources(want))

	if !reflect.DeepEqual(got, want) {
		t.Errorf("regenerating the checked-in wordlist changed it:\n%s", diff(want, got))
	}
}

func TestRegenerationIsStableAcrossRuns(t *testing.T) {
	in := asSources(checkedIn(t))

	first := assemble(in)
	second := assemble(asSources(first))

	if !reflect.DeepEqual(first, second) {
		t.Errorf("a second pass changed the list:\n%s", diff(first, second))
	}
}

// The generated file is written by the command and never by hand, so the bytes
// on disk have to be exactly what the command would write. A hand-edit shows
// up here rather than surviving until the next rebuild silently undoes it.
func TestTheFileOnDiskIsWhatTheCommandWrites(t *testing.T) {
	want, err := os.ReadFile(wordlistPath)
	if err != nil {
		t.Fatal(err)
	}

	out := filepath.Join(t.TempDir(), "profanity.json")
	if err := write(out, checkedIn(t)); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}

	if string(got) != string(want) {
		t.Error("profanity.json is not in the shape the command writes; run `make profanity`")
	}
}

func TestCurationListsFoldToThemselves(t *testing.T) {
	// A curated term that is not already in normal form would silently never
	// match: the matcher only ever sees folded text.
	for _, term := range terms(extraFa) {
		if folded := profanity.Normalize(term); folded != term {
			t.Errorf("extraFa %q folds to %q; write it folded", term, folded)
		}
	}
	for _, term := range fields(extraLatinWords + " " + extraLatinParts) {
		if folded := profanity.Normalize(term); folded != term {
			t.Errorf("latin %q folds to %q; write it folded", term, folded)
		}
	}
}

func TestLatinTermsAreSortedByLength(t *testing.T) {
	w := checkedIn(t)

	// The split is what stops `rapist` eating every *therapist*: only terms
	// long enough that nothing innocent contains them may match anywhere.
	for _, term := range w.LatinParts {
		if len([]rune(term)) < latinSubstringMin {
			t.Errorf("latinParts %q is shorter than %d and would match inside real names",
				term, latinSubstringMin)
		}
	}
	for _, term := range fields(latinTokenOnly) {
		for _, part := range w.LatinParts {
			if part == term {
				t.Errorf("%q is matched anywhere but is meant to be whole-token only", term)
			}
		}
	}
}

func diff(want, got profanity.Wordlist) string {
	out := ""
	for _, field := range []struct {
		name      string
		want, got []string
	}{
		{"fa", want.Fa, got.Fa},
		{"faBlocked", want.FaBlocked, got.FaBlocked},
		{"faAllow", want.FaAllow, got.FaAllow},
		{"latinWords", want.LatinWords, got.LatinWords},
		{"latinParts", want.LatinParts, got.LatinParts},
	} {
		for _, term := range missing(field.want, field.got) {
			out += field.name + ": lost " + term + "\n"
		}
		for _, term := range missing(field.got, field.want) {
			out += field.name + ": gained " + term + "\n"
		}
	}
	return out
}

func missing(from, in []string) []string {
	have := map[string]bool{}
	for _, item := range in {
		have[item] = true
	}
	var out []string
	for _, item := range from {
		if !have[item] {
			out = append(out, item)
		}
	}
	return out
}

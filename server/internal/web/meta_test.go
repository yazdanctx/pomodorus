package web

import (
	"strings"
	"testing"
)

func TestRenderCarriesBothVocabularies(t *testing.T) {
	block := defaultTags.render("https://pomodorus.app")

	for _, want := range []string{
		`<meta property="og:title" content="Pomodorus">`,
		`<meta property="og:url" content="https://pomodorus.app/">`,
		`<meta property="og:image" content="https://pomodorus.app/icon-512.png">`,
		`<meta name="twitter:card" content="summary">`,
		`<meta name="twitter:title" content="Pomodorus">`,
	} {
		if !strings.Contains(block, want) {
			t.Errorf("rendered block is missing %s\n%s", want, block)
		}
	}
}

func TestProfileTagsNameTheirPerson(t *testing.T) {
	block := profileTags("yazdan").render("https://pomodorus.app")

	if !strings.Contains(block, "yazdan") {
		t.Errorf("profile tags do not name the handle:\n%s", block)
	}
	if !strings.Contains(block, `content="https://pomodorus.app/u/yazdan"`) {
		t.Errorf("profile tags do not point at the profile:\n%s", block)
	}
}

// A handle is [a-z0-9_] by construction and an unknown one never reaches here,
// so this is the belt to that pair of braces: whatever ends up in a tag is
// escaped, and cannot close the attribute it sits in.
func TestRenderEscapesEveryValue(t *testing.T) {
	block := profileTags(`x"><script>alert(1)</script>`).render(`https://pomodorus.app/"`)

	if strings.Contains(block, "<script>") {
		t.Errorf("rendered markup out of a hostile handle:\n%s", block)
	}
	if strings.Count(block, `"`)%2 != 0 {
		t.Errorf("an attribute was left open:\n%s", block)
	}
}

func TestInjectPutsTheBlockInTheHead(t *testing.T) {
	shell := []byte("<!doctype html><html><head><title>x</title></head><body></body></html>")

	got := string(inject(shell, "<meta name=\"twitter:card\" content=\"summary\">"))

	head := strings.Index(got, "</head>")
	if at := strings.Index(got, "twitter:card"); at == -1 || at > head {
		t.Errorf("the block did not land inside the head:\n%s", got)
	}
	if !strings.HasSuffix(got, "<body></body></html>") {
		t.Errorf("the body was disturbed:\n%s", got)
	}
}

// A shell without a head is not a reason to serve nothing: the page still has
// to render, and a link to it merely previews as whatever it already said.
func TestInjectLeavesAHeadlessShellAlone(t *testing.T) {
	shell := []byte("<!doctype html><html><body></body></html>")

	if got := string(inject(shell, "<meta>")); got != string(shell) {
		t.Errorf("headless shell was rewritten: %s", got)
	}
}

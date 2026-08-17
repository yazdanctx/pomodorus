package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// The link preview: what an unfurler that never runs the bundle can read off
// the page. Asserted on the HTML the server actually served, because the whole
// point is that these tags are there before any JavaScript is.

// shell stands in for the built client, which a test binary never embeds. It
// is the real one's shape: a head with something already in it, and a body the
// client boots into.
const shell = `<!doctype html>
<html lang="fa" dir="rtl">
  <head>
    <meta charset="UTF-8">
    <title>Pomodorus</title>
  </head>
  <body><div id="root"></div><script type="module" src="/assets/app.js"></script></body>
</html>`

func page(t *testing.T, c *apitest.Client, path string) string {
	t.Helper()
	res := c.GET(path).ExpectStatus(http.StatusOK)
	if kind := res.Header.Get("Content-Type"); !strings.HasPrefix(kind, "text/html") {
		t.Fatalf("GET %s: served %s, want HTML", path, kind)
	}
	return string(res.Body)
}

// head is everything before </head>, which is the only part an unfurler reads.
func head(t *testing.T, html string) string {
	t.Helper()
	at := strings.Index(html, "</head>")
	if at < 0 {
		t.Fatalf("served a page with no head:\n%s", html)
	}
	return html[:at]
}

func expectMeta(t *testing.T, html, attribute, name, want string) {
	t.Helper()
	tag := `<meta ` + attribute + `="` + name + `" content="` + want + `">`
	if !strings.Contains(head(t, html), tag) {
		t.Errorf("page does not carry %s\n%s", tag, html)
	}
}

func TestTheLandingCarriesTheAppsOwnTags(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell))

	html := page(t, h.Client, "/")

	expectMeta(t, html, "property", "og:title", "Pomodorus")
	expectMeta(t, html, "name", "twitter:card", "summary")
	if !strings.Contains(head(t, html), `property="og:description"`) {
		t.Errorf("the landing has no description to preview:\n%s", html)
	}
}

func TestAProfileLinkPreviewsAsItsPerson(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell))
	claim(h.SignIn(address), "yazdan").ExpectStatus(http.StatusOK)

	html := page(t, h.Client, "/u/yazdan")

	for _, tag := range []string{`property="og:title"`, `name="twitter:title"`} {
		line := lineWith(t, head(t, html), tag)
		if !strings.Contains(line, "yazdan") {
			t.Errorf("%s does not name the person: %s", tag, line)
		}
	}
	expectMeta(t, html, "property", "og:url", h.URL()+"/u/yazdan")
}

// A link typed with different capitalisation reaches the same person, and
// previews as the name they actually chose.
func TestAProfilePreviewIsSpelledCanonically(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell))
	claim(h.SignIn(address), "yazdan").ExpectStatus(http.StatusOK)

	html := page(t, h.Client, "/u/YAZDAN")

	expectMeta(t, html, "property", "og:url", h.URL()+"/u/yazdan")
}

// A handle nobody has is a mistyped or stale link. It still renders — the
// client says so in Persian — but it does not advertise a profile that is not
// there.
func TestAnUnknownHandleFallsBackToTheAppsTags(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell))

	html := page(t, h.Client, "/u/nobody")

	expectMeta(t, html, "property", "og:title", "Pomodorus")
	expectMeta(t, html, "property", "og:url", h.URL()+"/")
}

// Every other route is the app behind a login or a path that means nothing,
// and describes itself as the app.
func TestEveryOtherRouteKeepsTheDefaultTags(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell))

	for _, path := range []string{"/login", "/app", "/offline", "/u/", "/nope"} {
		html := page(t, h.Client, path)
		expectMeta(t, html, "property", "og:title", "Pomodorus")
	}
}

// A handle that could not be anybody's is never looked up, and whatever is in
// it never reaches the page as markup.
func TestAHandleCannotInjectMarkup(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell))

	html := page(t, h.Client, "/u/%22%3E%3Cscript%3Ealert(1)%3C/script%3E")

	if strings.Contains(head(t, html), "<script>") {
		t.Errorf("a handle wrote markup into the head:\n%s", html)
	}
	expectMeta(t, html, "property", "og:title", "Pomodorus")
}

// Injection adds to the head and touches nothing else: the same shell, with
// the same script tag, still boots the same client.
func TestInjectionLeavesThePageItselfAlone(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell))

	html := page(t, h.Client, "/")

	body := html[strings.Index(html, "</head>"):]
	if want := shell[strings.Index(shell, "</head>"):]; body != want {
		t.Errorf("the page below the head changed:\n%s", body)
	}
	if !strings.Contains(html, "<title>Pomodorus</title>") {
		t.Errorf("the shell's own head was disturbed:\n%s", html)
	}
}

// A preview URL is absolute, and it is the URL the reader would have to open —
// which over TLS is the https one, not whatever scheme the server thinks it is.
func TestAPreviewPointsBackOverTheSchemeItWasReachedOn(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell), apitest.OverTLS())

	html := page(t, h.Client, "/")

	if !strings.Contains(head(t, html), `content="`+h.URL()+`/"`) {
		t.Errorf("the preview does not point back over https:\n%s", html)
	}
	if !strings.HasPrefix(h.URL(), "https://") {
		t.Fatalf("the harness was not serving TLS: %s", h.URL())
	}
}

func lineWith(t *testing.T, html, needle string) string {
	t.Helper()
	for _, line := range strings.Split(html, "\n") {
		if strings.Contains(line, needle) {
			return strings.TrimSpace(line)
		}
	}
	t.Fatalf("no line carries %s:\n%s", needle, html)
	return ""
}

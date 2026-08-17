package web

import (
	"bytes"
	"html"
	"strings"
)

// The link preview: what Telegram, Twitter or anything else with an unfurler
// shows when somebody pastes a URL into it.
//
// Those crawlers do not run JavaScript, so tags the client sets after it boots
// are tags they never see. The server therefore writes them into the shell on
// the way out — which is not server-side rendering: the page itself is still
// rendered entirely on the client, and nothing here is read back by it.
//
// The Persian in this file is the one exception to copy living in the client's
// copy.json. It is markup for machines rather than words on a screen — no
// reader of the app ever sees it — and the alternative is the server reading
// the client's bundle at request time to preview a link.

const (
	siteName = "Pomodorus"

	// A square icon rather than a wide banner, which is why the Twitter card
	// below is `summary` and not `summary_large_image`: the app has no artwork
	// of its own, and a stretched icon in a large card looks like a mistake.
	previewImage = "/icon-512.png"
)

// tags are one page's preview.
type tags struct {
	Title       string
	Description string
	// Path is the canonical path of the page, which is not always the path
	// that was asked for: a profile is spelled the way the handle is stored,
	// so /u/Yazdan advertises itself as /u/yazdan.
	Path string
}

// defaultTags describe the app, and stand in for any page that is not one of
// the two public ones — including a handle nobody has, which is advertised as
// the app rather than as a profile that is not there.
var defaultTags = tags{
	Title:       siteName,
	Description: "یه اپ پومودوروی ساده",
	Path:        "/",
}

func profileTags(handle string) tags {
	return tags{
		Title:       "پروفایل " + handle,
		Description: "ببین " + handle + " این روزا چقدر تمرکز کرده",
		Path:        "/u/" + handle,
	}
}

// render is the block of markup, absolute against the origin the request
// arrived on — every unfurler wants whole URLs, and the server does not know
// its own name until somebody asks it something.
func (t tags) render(origin string) string {
	url := origin + t.Path
	var b strings.Builder
	for _, tag := range []struct{ property, name, content string }{
		{property: "og:type", content: "website"},
		{property: "og:site_name", content: siteName},
		{property: "og:locale", content: "fa_IR"},
		{property: "og:title", content: t.Title},
		{property: "og:description", content: t.Description},
		{property: "og:url", content: url},
		{property: "og:image", content: origin + previewImage},
		{name: "twitter:card", content: "summary"},
		{name: "twitter:title", content: t.Title},
		{name: "twitter:description", content: t.Description},
		{name: "twitter:image", content: origin + previewImage},
	} {
		b.WriteString("\n    <meta ")
		if tag.property != "" {
			b.WriteString(`property="` + escape(tag.property) + `"`)
		} else {
			b.WriteString(`name="` + escape(tag.name) + `"`)
		}
		b.WriteString(` content="` + escape(tag.content) + `">`)
	}
	return b.String()
}

// escape is applied to every value without asking where it came from. A handle
// is [a-z0-9_] by construction and one that is not is never looked up, so this
// guards a door that should already be locked — which is the point: the day
// something else is interpolated in here, it is escaped too.
func escape(value string) string { return html.EscapeString(value) }

// inject writes the block into the shell's head.
//
// A shell with no head is served exactly as it is: the tags are a preview, and
// a preview is never worth failing a page over.
func inject(shell []byte, block string) []byte {
	const closing = "</head>"
	at := bytes.Index(shell, []byte(closing))
	if at < 0 {
		return shell
	}
	out := make([]byte, 0, len(shell)+len(block))
	out = append(out, shell[:at]...)
	out = append(out, block...)
	return append(out, shell[at:]...)
}

// Package web serves the built React client out of the Go binary.
//
// The client is embedded rather than shipped beside the binary so that a
// deploy is one artifact: no CDN, no nginx, no chance of the HTML and the API
// being different versions of the app.
//
// In development this is empty and unused — Vite serves the client on its own
// port and proxies /api and /ws here, which keeps the browser on a single
// origin so session cookies behave exactly as they will in production.
package web

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/yazdanctx/pomodorus/server/internal/identity"
)

//go:embed all:dist
var embedded embed.FS

// Options are the facts about the deployment the client is served into, none
// of which this package can work out for itself.
type Options struct {
	// Files is the built client. Nil means the one embedded in this binary,
	// which is what production always wants; a test supplies its own shell so
	// that what is asserted on is HTML the server actually served.
	Files fs.FS

	// Origin is the absolute base of a link to this server — "https://host",
	// no trailing slash — for the request that is being answered. Required:
	// the server does not know its own name until somebody asks it something,
	// and behind a proxy only the caller knows whether that was TLS.
	Origin func(*http.Request) string

	// KnownHandle reports whether a handle belongs to somebody, so a profile
	// link previews as that person and a mistyped one previews as the app.
	// Required. A lookup that fails is a false: a database that is down costs
	// a link preview, never the page.
	KnownHandle func(ctx context.Context, handle string) bool
}

// Handler serves the SPA: real files are served as themselves, and anything
// else falls back to index.html so client-side routes survive a hard refresh.
//
// Returns ok=false when no client has been built into the binary, so the
// caller can mount something useful instead of a wall of 404s.
func Handler(o Options) (h http.Handler, ok bool) {
	files := o.Files
	if files == nil {
		dist, err := fs.Sub(embedded, "dist")
		if err != nil {
			return nil, false
		}
		files = dist
	}
	if _, err := fs.Stat(files, "index.html"); err != nil {
		return nil, false
	}
	return &spa{
		files:       http.FS(files),
		fsys:        files,
		origin:      o.Origin,
		knownHandle: o.KnownHandle,
	}, true
}

type spa struct {
	files http.FileSystem
	fsys  fs.FS

	origin      func(*http.Request) string
	knownHandle func(ctx context.Context, handle string) bool
}

func (s *spa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" || name == "." {
		s.index(w, r)
		return
	}

	f, err := s.files.Open("/" + name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// A client-side route, not a missing asset.
			s.index(w, r)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	if info, err := f.Stat(); err == nil && info.IsDir() {
		s.index(w, r)
		return
	}

	// Vite fingerprints everything under /assets, so those may be cached hard.
	// Nothing else may: index.html is how a client learns there is a new build.
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.FileServer(s.files).ServeHTTP(w, r)
}

func (s *spa) index(w http.ResponseWriter, r *http.Request) {
	body, err := fs.ReadFile(s.fsys, "index.html")
	if err != nil {
		http.Error(w, "client not built", http.StatusInternalServerError)
		return
	}
	// The one thing the server writes into the page. Every unfurler reads the
	// head and none of them runs the bundle, so the tags have to be here
	// before it is sent; nothing the client does depends on them.
	body = inject(body, s.tagsFor(r).render(s.origin(r)))

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// tagsFor is the preview for the route that was asked for.
//
// Two routes are public and worth a preview of their own — the landing, and a
// profile that exists. Everything else is the app behind a login or a link
// that goes nowhere, and describes itself as the app.
func (s *spa) tagsFor(r *http.Request) tags {
	clean := path.Clean(r.URL.Path)
	rest, isProfile := strings.CutPrefix(clean, "/u/")
	if !isProfile {
		return defaultTags
	}

	// Normalised the way every other lookup normalises it, so /u/Yazdan
	// previews as the person it opens.
	handle := identity.NormalizeHandle(rest)
	if err := identity.ValidateHandle(handle); err != nil {
		return defaultTags
	}
	if !s.knownHandle(r.Context(), handle) {
		// A handle nobody has. Advertising a profile that is not there would
		// be a preview promising a page the tap then contradicts.
		return defaultTags
	}
	return profileTags(handle)
}

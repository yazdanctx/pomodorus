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
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var embedded embed.FS

// Handler serves the SPA: real files are served as themselves, and anything
// else falls back to index.html so client-side routes survive a hard refresh.
//
// Returns ok=false when no client has been built into the binary, so the
// caller can mount something useful instead of a wall of 404s.
func Handler() (h http.Handler, ok bool) {
	dist, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil, false
	}
	if _, err := fs.Stat(dist, "index.html"); err != nil {
		return nil, false
	}
	return &spa{files: http.FS(dist), fsys: dist}, true
}

type spa struct {
	files http.FileSystem
	fsys  fs.FS
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
	// TODO(milestone 5): inject OG/Twitter meta for / and /u/{handle} here, so
	// a shared profile link previews without needing server-side rendering.
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

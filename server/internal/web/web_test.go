package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// A client the size of the real one's shape: a shell, a fingerprinted asset,
// and the manifest that makes the app installable.
func built() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             &fstest.MapFile{Data: []byte("<html><head></head><body></body></html>")},
		"manifest.webmanifest":   &fstest.MapFile{Data: []byte(`{"name":"Pomodorus"}`)},
		"assets/index-abc123.js": &fstest.MapFile{Data: []byte("console.log(1)")},
	}
}

func serve(t *testing.T, path string) *http.Response {
	t.Helper()
	h, ok := Handler(Options{
		Files:       built(),
		Origin:      func(*http.Request) string { return "https://pomodorus.app" },
		KnownHandle: func(context.Context, string) bool { return false },
	})
	if !ok {
		t.Fatal("no client was mounted")
	}
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder.Result()
}

// The manifest is the file that decides whether the app can be installed at
// all, and it is the one file Go's own table has no type for.
func TestTheManifestIsServedAsAManifest(t *testing.T) {
	res := serve(t, "/manifest.webmanifest")

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", res.StatusCode)
	}
	if got := res.Header.Get("Content-Type"); got != "application/manifest+json" {
		t.Errorf("served the manifest as %q", got)
	}
}

// The manifest is not fingerprinted, so it may not be cached hard: it is how a
// browser learns the installed app changed.
func TestTheManifestIsNotCachedHard(t *testing.T) {
	if got := serve(t, "/manifest.webmanifest").Header.Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control %q, want no-cache", got)
	}
}

func TestFingerprintedAssetsAreCachedForever(t *testing.T) {
	if got := serve(t, "/assets/index-abc123.js").Header.Get("Cache-Control"); got == "no-cache" {
		t.Errorf("a fingerprinted asset is served %q", got)
	}
}

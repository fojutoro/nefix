package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// A built frontend, in memory. The real one is gitignored and only exists
// after `make dist`, so a test reading it would pass or fail depending on
// whether somebody had run the build, which is not a test.
func built() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             {Data: []byte("<!doctype html><title>nefix</title>")},
		"assets/index-abc123.js": {Data: []byte("console.log(1)")},
		"sw.js":                  {Data: []byte("// service worker")},
	}
}

func get(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))

	return rec
}

func TestServesIndexAtRoot(t *testing.T) {
	rec := get(t, handlerFor(built()), "/")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != "<!doctype html><title>nefix</title>" {
		t.Errorf("body = %q, want the index", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want %q", got, "no-cache")
	}
}

// A deep link, or a reload on one. Without this the app is unusable at any
// address but the root.
func TestServesIndexAtAnUnknownPath(t *testing.T) {
	rec := get(t, handlerFor(built()), "/notes/0192f0a1-3c4d-7e8f-9a0b-1c2d3e4f5a6b")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != "<!doctype html><title>nefix</title>" {
		t.Errorf("body = %q, want the index", got)
	}
}

// The one place the fallback must not apply: HTML in answer to a request for
// JavaScript produces a MIME error that says nothing about the real cause.
func TestMissingAssetIsNotFound(t *testing.T) {
	rec := get(t, handlerFor(built()), "/assets/index-deadbeef.js")

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestHashedAssetsAreCachedForever(t *testing.T) {
	rec := get(t, handlerFor(built()), "/assets/index-abc123.js")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != forever {
		t.Errorf("Cache-Control = %q, want %q", got, forever)
	}
}

// The worker names the hashed files, so a cached one would pin the app to an
// old build.
func TestServiceWorkerIsRevalidated(t *testing.T) {
	rec := get(t, handlerFor(built()), "/sw.js")

	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want %q", got, "no-cache")
	}
}

func TestDirectoryIsNotListed(t *testing.T) {
	rec := get(t, handlerFor(built()), "/assets/")

	// Falls through to the index rather than listing what is in there.
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != "<!doctype html><title>nefix</title>" {
		t.Errorf("body = %q, want the index", got)
	}
}

// What `make build` without `make dist` produces. It has to be legible
// rather than an empty page or a panic at startup.
func TestUnbuiltFrontendSaysSo(t *testing.T) {
	rec := get(t, handlerFor(fstest.MapFS{".gitkeep": {}}), "/")

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

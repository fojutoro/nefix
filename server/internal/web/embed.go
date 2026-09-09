// Package web serves the built frontend from inside the binary, so a release
// is one file rather than a binary plus a directory of assets.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// all: because go:embed otherwise skips names beginning with a dot or an
// underscore, and the build output holds both. The directory is gitignored
// and filled by `make dist`; a fresh clone has only .gitkeep in it, which is
// what keeps `go build ./...` working with no frontend built.
//
//go:embed all:dist
var embedded embed.FS

const index = "index.html"

// Vite puts a content hash in every name under assets/, so a given URL's
// bytes never change and the browser need never ask again. index.html is the
// one file that must be revalidated, because it is what names the hashed
// ones.
const forever = "public, max-age=31536000, immutable"

func Handler() http.Handler {
	dist, err := fs.Sub(embedded, "dist")
	if err != nil {
		return notBuilt()
	}

	return handlerFor(dist)
}

func notBuilt() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "the frontend was not built into this binary", http.StatusServiceUnavailable)
	})
}

func handlerFor(dist fs.FS) http.Handler {
	// Checked once, at startup: a binary built without `make dist` says so on
	// every request instead of serving an empty page, and /health and the API
	// keep working so the deploy can still report what went wrong.
	if _, err := fs.Stat(dist, index); err != nil {
		return notBuilt()
	}

	files := http.FileServer(http.FS(dist))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")

		info, err := fs.Stat(dist, name)
		// A directory is not a page: serving one would hand back a listing.
		if name == "" || err != nil || info.IsDir() {
			// A path with an extension asked for an asset, and an asset that
			// is not here is a 404. Answering with index.html would hand the
			// browser HTML where it asked for JavaScript, and the MIME error
			// that follows says nothing about the real cause.
			if name != "" && path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
			// Anything else is a client route: a deep link, or a reload on
			// one. The app boots and its router sorts it out.
			serveIndex(w, r, dist)
			return
		}

		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", forever)
		} else {
			// The service worker and the manifest name the hashed files too,
			// so they are revalidated for the same reason index.html is.
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, dist fs.FS) {
	body, err := fs.ReadFile(dist, index)
	if err != nil {
		notBuilt().ServeHTTP(w, r)
		return
	}

	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(body)
}

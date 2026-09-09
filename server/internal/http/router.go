package http

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/fojutoro/nefix/server/internal/store"
	"github.com/fojutoro/nefix/server/internal/web"
)

type health struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

type apiRoute struct {
	Method  string
	Pattern string
	Handler http.Handler
}

// A list rather than a sequence of Handle calls, so a test can walk exactly
// what the router was built from. A route added here is a route the cache
// header test covers, with no second list to keep in step.
func (s *server) apiRoutes(limit *limiter) []apiRoute {
	return []apiRoute{
		// The only two rate limited: they are the only two that run argon2
		// for an unauthenticated caller.
		{"POST", "/api/v1/register", limit.limit(http.HandlerFunc(s.register))},
		{"POST", "/api/v1/login", limit.limit(http.HandlerFunc(s.login))},
		{"POST", "/api/v1/logout", http.HandlerFunc(s.logout)},
		{"GET", "/api/v1/me", requireUser(http.HandlerFunc(s.me))},
		{"POST", "/api/v1/sync/push", requireUser(http.HandlerFunc(s.push))},
		{"GET", "/api/v1/sync/pull", requireUser(http.HandlerFunc(s.pull))},
	}
}

// The context bounds the rate limiter's sweep goroutine: it is what stops
// the server leaving one behind on shutdown, and what keeps a test from
// leaving one per call.
func New(ctx context.Context, version, commit string, db *store.DB, cfg CookieConfig) http.Handler {
	srv := &server{db: db, cfg: cfg}

	limit := newLimiter(loginRate, loginBurst, bucketIdle)
	limit.run(ctx, sweepEvery)

	api := http.NewServeMux()
	for _, route := range srv.apiRoutes(limit) {
		api.Handle(route.Method+" "+route.Pattern, route.Handler)
	}

	mux := http.NewServeMux()

	// Outside withUser: /health answers the same whoever asks.
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(health{
			Status:  "ok",
			Version: version,
			Commit:  commit,
		})
	})

	// requireCSRF inside withUser, because it needs to know whether the
	// request carries a session before it decides there is anything to
	// protect. Wrapping the whole mux rather than each route: a route added
	// to the list above is covered without anyone remembering to do it.
	mux.Handle("/api/v1/", srv.withUser(srv.requireCSRF(api)))

	devEnabled := os.Getenv("NEFIX_DEV_PAGE") == "true"
	if devEnabled {
		slog.Warn("dev page enabled at /dev, development only", "env", "NEFIX_DEV_PAGE=true")
		mux.HandleFunc("GET /dev", devPage)
	}

	// A prefix check rather than a "/" pattern on the same mux. Registered as
	// a pattern, "/" would answer a POST to /health, because "GET /health"
	// does not match it and the catch-all does — turning a 405 into a page.
	frontend := web.Handler()
	root := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if served(r.URL.Path, devEnabled) {
			mux.ServeHTTP(w, r)
			return
		}

		frontend.ServeHTTP(w, r)
	})

	return noStore(root)
}

// The paths the server answers itself. Everything else belongs to the client,
// including paths that exist only in its router.
func served(path string, devEnabled bool) bool {
	return path == "/health" ||
		strings.HasPrefix(path, "/api/") ||
		(devEnabled && path == "/dev")
}

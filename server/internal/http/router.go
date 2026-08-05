package http

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"

	"github.com/fojutoro/nefix/server/internal/store"
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
func (s *server) apiRoutes() []apiRoute {
	return []apiRoute{
		{"POST", "/api/v1/register", http.HandlerFunc(s.register)},
		{"POST", "/api/v1/login", http.HandlerFunc(s.login)},
		{"POST", "/api/v1/logout", http.HandlerFunc(s.logout)},
		{"GET", "/api/v1/me", requireUser(http.HandlerFunc(s.me))},
		{"POST", "/api/v1/sync/push", requireUser(http.HandlerFunc(s.push))},
		{"GET", "/api/v1/sync/pull", requireUser(http.HandlerFunc(s.pull))},
	}
}

func New(version, commit string, db *store.DB, cfg CookieConfig) http.Handler {
	srv := &server{db: db, cfg: cfg}

	api := http.NewServeMux()
	for _, route := range srv.apiRoutes() {
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

	mux.Handle("/api/v1/", srv.withUser(api))

	if os.Getenv("NEFIX_DEV_PAGE") == "true" {
		slog.Warn("dev page enabled at /dev, development only", "env", "NEFIX_DEV_PAGE=true")
		mux.HandleFunc("GET /dev", devPage)
	}

	return noStore(mux)
}

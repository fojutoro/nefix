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

func New(version, commit string, db *store.DB, cfg CookieConfig) http.Handler {
	srv := &server{db: db, cfg: cfg}

	api := http.NewServeMux()
	api.HandleFunc("POST /api/v1/register", srv.register)
	api.HandleFunc("POST /api/v1/login", srv.login)
	api.HandleFunc("POST /api/v1/logout", srv.logout)
	api.Handle("GET /api/v1/me", requireUser(http.HandlerFunc(srv.me)))

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

	return mux
}

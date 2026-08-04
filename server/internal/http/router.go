package http

import (
	"encoding/json"
	"net/http"

	"github.com/fojutoro/nefix/server/internal/store"
)

type health struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

// db and cfg are taken now and consumed when the first authenticated route
// lands; /health needs neither and stays outside withUser.
func New(version, commit string, db *store.DB, cfg CookieConfig) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(health{
			Status:  "ok",
			Version: version,
			Commit:  commit,
		})
	})

	return mux
}

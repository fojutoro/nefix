package http

import (
	"encoding/json"
	"net/http"
)

type health struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

func New(version, commit string) http.Handler {
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

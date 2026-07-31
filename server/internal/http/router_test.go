package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealth(t *testing.T) {
	rec := httptest.NewRecorder()
	New("v0.1.0", "abc1234").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want %d", res.StatusCode, http.StatusOK)
	}
	if got := res.Header.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want %q", got, "application/json")
	}

	var got health
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decoding body: %v", err)
	}
	want := health{Status: "ok", Version: "v0.1.0", Commit: "abc1234"}
	if got != want {
		t.Errorf("body = %+v, want %+v", got, want)
	}
}

func TestHealthRejectsPost(t *testing.T) {
	rec := httptest.NewRecorder()
	New("v0.1.0", "abc1234").ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/health", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestUnknownPath(t *testing.T) {
	rec := httptest.NewRecorder()
	New("v0.1.0", "abc1234").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/unknown_path", nil))

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealth(t *testing.T) {
	rec := httptest.NewRecorder()
	New("v0.1.0", "abc1234", nil, CookieConfig{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

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
	New("v0.1.0", "abc1234", nil, CookieConfig{}).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/health", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

// An unknown path used to be a 404. It is a client route now: the frontend
// owns everything the API does not, so that a deep link and a reload both
// reach the app. Whether the answer is the app shell or "not built" depends
// on whether `make dist` ran before this binary was compiled, which is not
// what this test is about — that the API did not claim it, is.
func TestUnknownPathGoesToTheFrontend(t *testing.T) {
	rec := httptest.NewRecorder()
	New("v0.1.0", "abc1234", nil, CookieConfig{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/unknown_path", nil))

	if rec.Code == http.StatusNotFound {
		t.Errorf("status = %d, want the path handed to the frontend", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); strings.HasPrefix(got, "application/json") {
		t.Errorf("Content-Type = %q, want a response from the frontend", got)
	}
}

// The frontend is a catch-all, and a catch-all that swallowed /health would
// take the deploy's only health signal with it.
func TestFrontendDoesNotShadowTheAPI(t *testing.T) {
	handler := New("v0.1.0", "abc1234", nil, CookieConfig{})

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("/health status = %d, want %d", rec.Code, http.StatusOK)
	}

	// No cookie, so this is the 401 the contract promises rather than the app
	// shell with a 200 on it.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/me", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("/api/v1/me status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want %q", got, "no-store")
	}
}

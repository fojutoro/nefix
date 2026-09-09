package http

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// An unknown address, so every attempt costs the same dummy verification a
// real guessing run would.
func loginFrom(t *testing.T, h http.Handler, remoteAddr, forwarded string) *httptest.ResponseRecorder {
	t.Helper()

	body, err := json.Marshal(map[string]string{
		"email":    "nobody@example.sk",
		"password": goodPassword,
	})
	if err != nil {
		t.Fatalf("encoding body: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/login", bytes.NewReader(body))
	req.RemoteAddr = remoteAddr
	if forwarded != "" {
		req.Header.Set("X-Forwarded-For", forwarded)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	return rec
}

func TestEleventhLoginFromOneIPIsRateLimited(t *testing.T) {
	api := newAPI(t)

	for i := 1; i <= 10; i++ {
		if rec := loginFrom(t, api, "203.0.113.7:5000", ""); rec.Code == http.StatusTooManyRequests {
			t.Fatalf("attempt %d was limited, want the first ten through", i)
		}
	}

	rec := loginFrom(t, api, "203.0.113.7:5000", "")

	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}
	after, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if err != nil {
		t.Fatalf("Retry-After = %q, want a number of seconds", rec.Header().Get("Retry-After"))
	}
	if after < 1 {
		t.Errorf("Retry-After = %d, want at least 1: retrying at once is refused again", after)
	}
}

func TestSeparateIPsGetSeparateBuckets(t *testing.T) {
	api := newAPI(t)

	for range 11 {
		loginFrom(t, api, "203.0.113.7:5000", "")
	}
	if rec := loginFrom(t, api, "203.0.113.7:5000", ""); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("the first address was not limited: status = %d", rec.Code)
	}

	if rec := loginFrom(t, api, "203.0.113.8:5000", ""); rec.Code == http.StatusTooManyRequests {
		t.Error("a second address was refused, so both share one bucket")
	}
}

// The one that decides whether the limiter works at all. A client that reaches
// the server directly can put anything in this header, and a limiter that
// believes it is keyed by a value the attacker chooses — which is no limiter.
func TestForgedForwardedForFromANonLoopbackClientIsIgnored(t *testing.T) {
	api := newAPI(t)

	var last *httptest.ResponseRecorder
	for i := range 11 {
		last = loginFrom(t, api, "203.0.113.7:5000", fmt.Sprintf("198.51.100.%d", i))
	}

	if last.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want %d: a forged X-Forwarded-For walked past the limit",
			last.Code, http.StatusTooManyRequests)
	}
}

// The other half of the same rule: behind nginx the header is the only way to
// tell two users apart, and ignoring it would put the whole user base in one
// bucket.
func TestForwardedForIsTrustedFromLoopback(t *testing.T) {
	api := newAPI(t)

	for range 11 {
		loginFrom(t, api, "127.0.0.1:5000", "198.51.100.1")
	}
	if rec := loginFrom(t, api, "127.0.0.1:5000", "198.51.100.1"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("the forwarded client was not limited: status = %d", rec.Code)
	}

	if rec := loginFrom(t, api, "127.0.0.1:5000", "198.51.100.2"); rec.Code == http.StatusTooManyRequests {
		t.Error("a second forwarded client was refused, so the header is being ignored")
	}
}

func TestSweepEvictsIdleBuckets(t *testing.T) {
	limit := newLimiter(loginRate, loginBurst, bucketIdle)
	now := time.Now()

	limit.allow("198.51.100.1", now)
	limit.allow("198.51.100.2", now.Add(9*time.Minute))

	limit.sweep(now.Add(10 * time.Minute))

	if _, ok := limit.buckets["198.51.100.1"]; ok {
		t.Error("a bucket idle for ten minutes survived the sweep")
	}
	if _, ok := limit.buckets["198.51.100.2"]; !ok {
		t.Error("a bucket used one minute ago was evicted")
	}
}

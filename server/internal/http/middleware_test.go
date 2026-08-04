package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/fojutoro/nefix/server/internal/store"
)

// Reports whether a user reached the handler, and the handler's own status.
func probe(t *testing.T, h func(http.Handler) http.Handler, req *http.Request) (*httptest.ResponseRecorder, *store.User) {
	t.Helper()

	var seen *store.User
	rec := httptest.NewRecorder()
	h(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, ok := userFrom(r.Context()); ok {
			seen = user
		}
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(rec, req)

	return rec, seen
}

func newServer(t *testing.T) (*server, *store.DB) {
	t.Helper()

	db, err := store.Open(filepath.Join(t.TempDir(), "nefix.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	return &server{db: db, cfg: CookieConfig{Secure: true}}, db
}

func newSession(t *testing.T, db *store.DB) (*store.User, string) {
	t.Helper()

	ctx := context.Background()
	user, err := db.CreateUser(ctx, "jozef", "Jozef", "jozef@example.sk", "hash")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, _, err := db.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	return user, token
}

func request(token string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
	}

	return req
}

func TestWithUserAnonymous(t *testing.T) {
	srv, _ := newServer(t)

	tests := []struct {
		name  string
		token string
	}{
		{"no cookie", ""},
		{"garbage cookie", "not-a-real-token"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec, seen := probe(t, srv.withUser, request(tt.token))
			if rec.Code != http.StatusOK {
				t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if seen != nil {
				t.Errorf("got user %v, want none", seen)
			}
		})
	}
}

func TestWithUserValidCookie(t *testing.T) {
	srv, db := newServer(t)
	user, token := newSession(t, db)

	rec, seen := probe(t, srv.withUser, request(token))
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if seen == nil {
		t.Fatal("no user in the context")
	}
	if seen.ID != user.ID {
		t.Errorf("user id = %d, want %d", seen.ID, user.ID)
	}
}

func TestWithUserSlidingExpiry(t *testing.T) {
	tests := []struct {
		name      string
		expiresIn string
		wantSet   bool
	}{
		{"near expiry is extended", "+1 hour", true},
		{"far from expiry is left alone", "+29 days", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv, db := newServer(t)
			_, token := newSession(t, db)

			// No WHERE: this test has exactly one session, and the column now
			// holds a hash that only the store package can compute.
			if _, err := db.ExecContext(context.Background(),
				`UPDATE sessions SET expires_at = datetime('now',?)`, tt.expiresIn,
			); err != nil {
				t.Fatalf("setting expiry: %v", err)
			}

			before, err := db.SessionExpiresAt(context.Background(), token)
			if err != nil {
				t.Fatalf("SessionExpiresAt: %v", err)
			}

			rec, seen := probe(t, srv.withUser, request(token))
			if seen == nil {
				t.Fatal("no user in the context")
			}

			cookies := rec.Result().Cookies()
			if got := len(cookies) > 0; got != tt.wantSet {
				t.Errorf("cookie re-set = %v, want %v", got, tt.wantSet)
			}

			after, err := db.SessionExpiresAt(context.Background(), token)
			if err != nil {
				t.Fatalf("SessionExpiresAt: %v", err)
			}
			if extended := after.After(before); extended != tt.wantSet {
				t.Errorf("expiry extended = %v, want %v", extended, tt.wantSet)
			}
		})
	}
}

func TestRequireUser(t *testing.T) {
	srv, db := newServer(t)
	_, token := newSession(t, db)

	t.Run("anonymous", func(t *testing.T) {
		rec, _ := probe(t, func(next http.Handler) http.Handler {
			return srv.withUser(requireUser(next))
		}, request(""))

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
		}
		if got := rec.Header().Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want %q", got, "application/json")
		}

		var body map[string]string
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("decoding body: %v", err)
		}
		if body["error"] == "" {
			t.Errorf("body = %v, want an error message", body)
		}
	})

	t.Run("authenticated", func(t *testing.T) {
		rec, seen := probe(t, func(next http.Handler) http.Handler {
			return srv.withUser(requireUser(next))
		}, request(token))

		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
		}
		if seen == nil {
			t.Error("no user in the context")
		}
	})
}

func TestClearSessionCookieMatchesSetAttributes(t *testing.T) {
	cfg := CookieConfig{Secure: true}

	set := httptest.NewRecorder()
	setSessionCookie(set, "token", time.Now().Add(store.SessionLifetime), cfg)
	cleared := httptest.NewRecorder()
	clearSessionCookie(cleared, cfg)

	before, after := set.Result().Cookies()[0], cleared.Result().Cookies()[0]
	if before.Name != after.Name || before.Path != after.Path ||
		before.Secure != after.Secure || before.HttpOnly != after.HttpOnly ||
		before.SameSite != after.SameSite {
		t.Errorf("attributes differ, so the browser will keep the cookie:\nset   %+v\nclear %+v", before, after)
	}
	if after.MaxAge != -1 {
		t.Errorf("MaxAge = %d, want -1", after.MaxAge)
	}
}

package http

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/fojutoro/nefix/server/internal/store"
)

// An unexported struct type, so no other package can build a colliding key.
type contextKey struct{}

var userKey contextKey

// The only way to read the user off a request.
func userFrom(ctx context.Context) (*store.User, bool) {
	user, ok := ctx.Value(userKey).(*store.User)

	return user, ok
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// Holds what the middleware needs; withUser keeps the signature the routes use.
type server struct {
	db  *store.DB
	cfg CookieConfig
}

// withUser attaches the session's user when there is one and rejects nothing.
// An anonymous request passes straight through.
func (s *server) withUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookieName)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}

		user, err := s.db.SessionUser(r.Context(), cookie.Value)
		if err != nil {
			// A wedged database must not turn a public page into a 500.
			if !errors.Is(err, store.ErrNotFound) {
				slog.Error("session lookup failed", "error", err)
			}
			next.ServeHTTP(w, r)
			return
		}

		s.slide(w, r, cookie.Value)

		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
	})
}

// Extend only past the halfway mark, so a read does not become a write on
// every request.
func (s *server) slide(w http.ResponseWriter, r *http.Request, token string) {
	expiresAt, err := s.db.SessionExpiresAt(r.Context(), token)
	if err != nil {
		return
	}
	if time.Until(expiresAt) > store.SessionLifetime/2 {
		return
	}

	extended, err := s.db.TouchSession(r.Context(), token)
	if err != nil {
		slog.Error("extending session failed", "error", err)
		return
	}

	setSessionCookie(w, token, extended, s.cfg)
}

// The client's service worker declares /api/ NetworkOnly, but a response
// carrying no freshness directive can still be cached heuristically by the
// browser's own HTTP cache underneath the worker, and by anything between the
// client and the origin. Saying no-store binds all of them at once, and Vary
// keeps a shared cache from serving one session's answer to another.
//
// Set on the way in, because a header written after the status line is
// ignored. Wrapped outside the router, so an unrouted /api/ path answers 404
// with the header too.
func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Vary", "Cookie")
		}

		next.ServeHTTP(w, r)
	})
}

// requireUser must run after withUser.
func requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := userFrom(r.Context()); !ok {
			writeError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		next.ServeHTTP(w, r)
	})
}

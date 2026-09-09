package http

import (
	"context"
	"crypto/subtle"
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

		// A session from before this cookie existed, or one whose readable
		// half the browser dropped. Minted here rather than forcing a fresh
		// login: the value is derived, so it can be handed out again at any
		// time, and an existing session heals on its next request.
		if csrf, err := r.Cookie(csrfCookieName); err != nil || csrf.Value != csrfTokenFor(cookie.Value) {
			if expiresAt, err := s.db.SessionExpiresAt(r.Context(), cookie.Value); err == nil {
				setCSRFCookie(w, cookie.Value, expiresAt, s.cfg)
			}
		}

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

const csrfHeaderName = "X-CSRF-Token"

// Exempt because there is no session to protect yet. Demanding a token here
// would also make the first request of a browser's life impossible, and would
// lock out anyone holding a session cookie whose readable half went missing.
var csrfExempt = map[string]bool{
	"/api/v1/login":    true,
	"/api/v1/register": true,
}

// requireCSRF must run after withUser, which is what decides whether there is
// a session at all.
func (s *server) requireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)

			return
		}

		if csrfExempt[r.URL.Path] {
			next.ServeHTTP(w, r)

			return
		}

		// No session is no authenticated state to forge a request against,
		// which is the same reason login and register are exempt. It is also
		// what keeps logout idempotent for a caller with no cookie at all.
		if _, ok := userFrom(r.Context()); !ok {
			next.ServeHTTP(w, r)

			return
		}

		cookie, err := r.Cookie(sessionCookieName)
		if err != nil {
			writeError(w, http.StatusForbidden, "missing or invalid CSRF token")

			return
		}

		// Against the value derived from the session, not against the cookie:
		// the cookie is only how the client was told what to send, and a
		// comparison of the two halves the client controls proves nothing.
		want := []byte(csrfTokenFor(cookie.Value))
		if subtle.ConstantTimeCompare(want, []byte(r.Header.Get(csrfHeaderName))) != 1 {
			writeError(w, http.StatusForbidden, "missing or invalid CSRF token")

			return
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

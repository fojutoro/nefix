package http

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"time"
)

const sessionCookieName = "nefix_session"

const csrfCookieName = "nefix_csrf"

type CookieConfig struct {
	Secure bool
}

func setSessionCookie(w http.ResponseWriter, token string, expires time.Time, cfg CookieConfig) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(time.Until(expires).Seconds()),
		HttpOnly: true,
		Secure:   cfg.Secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// The attributes have to match the ones used when setting, or the browser
// treats this as a different cookie and keeps the original.
func clearSessionCookie(w http.ResponseWriter, cfg CookieConfig) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   cfg.Secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// Derived from the session token rather than stored beside it. A column on the
// session row would put both halves in one database; this needs no column, no
// migration and no state, because the server recomputes the value from the
// session cookie the browser already sent. SHA-256 is one-way, so the readable
// CSRF cookie gives away nothing about the session token it came from.
//
// The binding is what a stateless double submit lacks: an attacker who can set
// cookies on the victim's browser can forge a matching cookie and header pair
// against a server that only compares those two, but cannot produce one that
// matches a session token they do not hold.
func csrfTokenFor(sessionToken string) string {
	sum := sha256.Sum256([]byte("nefix-csrf:" + sessionToken))

	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// Not HttpOnly, unlike the session cookie: the client has to read this one and
// echo it in a header, which is the entire mechanism. Every other attribute
// matches, so the two cookies travel together and expire together.
func setCSRFCookie(w http.ResponseWriter, sessionToken string, expires time.Time, cfg CookieConfig) {
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookieName,
		Value:    csrfTokenFor(sessionToken),
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(time.Until(expires).Seconds()),
		HttpOnly: false,
		Secure:   cfg.Secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func clearCSRFCookie(w http.ResponseWriter, cfg CookieConfig) {
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: false,
		Secure:   cfg.Secure,
		SameSite: http.SameSiteLaxMode,
	})
}

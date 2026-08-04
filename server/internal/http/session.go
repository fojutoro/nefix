package http

import (
	"net/http"
	"time"
)

const sessionCookieName = "nefix_session"

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

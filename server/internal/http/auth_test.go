package http

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fojutoro/nefix/server/internal/store"
)

const goodPassword = "hunter2hunter2"

func newAPI(t *testing.T) http.Handler {
	t.Helper()

	db, err := store.Open(filepath.Join(t.TempDir(), "nefix.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	return New("v0.1.0", "abc1234", db, CookieConfig{})
}

func call(t *testing.T, h http.Handler, method, path string, body any, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()

	var reader io.Reader
	if body != nil {
		switch b := body.(type) {
		case string:
			reader = strings.NewReader(b)
		default:
			encoded, err := json.Marshal(b)
			if err != nil {
				t.Fatalf("encoding body: %v", err)
			}
			reader = bytes.NewReader(encoded)
		}
	}

	req := httptest.NewRequest(method, path, reader)
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	return rec
}

func registerBody(username, email string) map[string]string {
	return map[string]string{
		"username":     username,
		"display_name": "Jozef Novák",
		"email":        email,
		"password":     goodPassword,
	}
}

func sessionCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()

	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == sessionCookieName && cookie.Value != "" {
			return cookie
		}
	}
	t.Fatal("no session cookie was set")

	return nil
}

func TestRegisterThenMe(t *testing.T) {
	api := newAPI(t)

	rec := call(t, api, http.MethodPost, "/api/v1/register", registerBody("jozef", "jozef@example.sk"))
	if rec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, want %d (body %s)", rec.Code, http.StatusCreated, rec.Body)
	}

	var created userResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decoding register body: %v", err)
	}
	if created.Username != "jozef" || created.Email != "jozef@example.sk" {
		t.Errorf("register returned %+v", created)
	}
	if created.Role != "student" {
		t.Errorf("role = %q, want %q", created.Role, "student")
	}

	me := call(t, api, http.MethodGet, "/api/v1/me", nil, sessionCookie(t, rec))
	if me.Code != http.StatusOK {
		t.Fatalf("me status = %d, want %d (body %s)", me.Code, http.StatusOK, me.Body)
	}

	var self userResponse
	if err := json.Unmarshal(me.Body.Bytes(), &self); err != nil {
		t.Fatalf("decoding me body: %v", err)
	}
	if self != created {
		t.Errorf("me = %+v, want %+v", self, created)
	}
}

// The 409 must not say which field collided, or it becomes an enumeration
// oracle: an attacker learns whether an address is registered.
func TestRegisterDuplicateIsGeneric(t *testing.T) {
	api := newAPI(t)
	call(t, api, http.MethodPost, "/api/v1/register", registerBody("jozef", "jozef@example.sk"))

	sameEmail := call(t, api, http.MethodPost, "/api/v1/register", registerBody("different", "jozef@example.sk"))
	sameUsername := call(t, api, http.MethodPost, "/api/v1/register", registerBody("jozef", "different@example.sk"))

	for _, rec := range []*httptest.ResponseRecorder{sameEmail, sameUsername} {
		if rec.Code != http.StatusConflict {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusConflict)
		}
	}
	if sameEmail.Body.String() != sameUsername.Body.String() {
		t.Errorf("the two collisions differ:\nemail    %s\nusername %s", sameEmail.Body, sameUsername.Body)
	}
}

func TestRegisterValidation(t *testing.T) {
	tests := []struct {
		name string
		body map[string]string
	}{
		{"username too short", map[string]string{"username": "ab", "display_name": "A", "email": "a@b.sk", "password": goodPassword}},
		{"username too long", map[string]string{"username": strings.Repeat("a", 33), "display_name": "A", "email": "a@b.sk", "password": goodPassword}},
		{"username bad characters", map[string]string{"username": "jozef!", "display_name": "A", "email": "a@b.sk", "password": goodPassword}},
		{"display name empty", map[string]string{"username": "jozef", "display_name": "   ", "email": "a@b.sk", "password": goodPassword}},
		{"display name too long", map[string]string{"username": "jozef", "display_name": strings.Repeat("a", 65), "email": "a@b.sk", "password": goodPassword}},
		{"email no at", map[string]string{"username": "jozef", "display_name": "A", "email": "nope.sk", "password": goodPassword}},
		{"email two ats", map[string]string{"username": "jozef", "display_name": "A", "email": "a@b@c.sk", "password": goodPassword}},
		{"email empty local", map[string]string{"username": "jozef", "display_name": "A", "email": "@b.sk", "password": goodPassword}},
		{"email empty domain", map[string]string{"username": "jozef", "display_name": "A", "email": "a@", "password": goodPassword}},
		{"email too long", map[string]string{"username": "jozef", "display_name": "A", "email": strings.Repeat("a", 250) + "@b.sk", "password": goodPassword}},
		{"password too short", map[string]string{"username": "jozef", "display_name": "A", "email": "a@b.sk", "password": "short"}},
		{"password too long", map[string]string{"username": "jozef", "display_name": "A", "email": "a@b.sk", "password": strings.Repeat("a", 129)}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := call(t, newAPI(t), http.MethodPost, "/api/v1/register", tt.body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body)
			}

			var body map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decoding body: %v", err)
			}
			if body["error"] == "" {
				t.Errorf("body = %v, want an error message", body)
			}
		})
	}
}

func TestLoginSucceeds(t *testing.T) {
	api := newAPI(t)
	call(t, api, http.MethodPost, "/api/v1/register", registerBody("jozef", "jozef@example.sk"))

	rec := call(t, api, http.MethodPost, "/api/v1/login", map[string]string{
		"email": "jozef@example.sk", "password": goodPassword,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusOK, rec.Body)
	}

	me := call(t, api, http.MethodGet, "/api/v1/me", nil, sessionCookie(t, rec))
	if me.Code != http.StatusOK {
		t.Errorf("me after login = %d, want %d", me.Code, http.StatusOK)
	}
}

// A wrong password and an unknown address must be indistinguishable.
func TestLoginFailuresAreIdentical(t *testing.T) {
	api := newAPI(t)
	call(t, api, http.MethodPost, "/api/v1/register", registerBody("jozef", "jozef@example.sk"))

	wrongPassword := call(t, api, http.MethodPost, "/api/v1/login", map[string]string{
		"email": "jozef@example.sk", "password": "not-the-password",
	})
	unknownEmail := call(t, api, http.MethodPost, "/api/v1/login", map[string]string{
		"email": "nobody@example.sk", "password": goodPassword,
	})

	if wrongPassword.Code != http.StatusUnauthorized || unknownEmail.Code != http.StatusUnauthorized {
		t.Errorf("statuses = %d and %d, want both %d",
			wrongPassword.Code, unknownEmail.Code, http.StatusUnauthorized)
	}
	if wrongPassword.Body.String() != unknownEmail.Body.String() {
		t.Errorf("bodies differ:\nwrong password %s\nunknown email  %s", wrongPassword.Body, unknownEmail.Body)
	}
	for _, rec := range []*httptest.ResponseRecorder{wrongPassword, unknownEmail} {
		if len(rec.Result().Cookies()) != 0 {
			t.Error("a failed login set a cookie")
		}
	}
}

func TestMeWithoutCookie(t *testing.T) {
	rec := call(t, newAPI(t), http.MethodGet, "/api/v1/me", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestLogout(t *testing.T) {
	api := newAPI(t)
	registered := call(t, api, http.MethodPost, "/api/v1/register", registerBody("jozef", "jozef@example.sk"))
	cookie := sessionCookie(t, registered)

	out := call(t, api, http.MethodPost, "/api/v1/logout", nil, cookie)
	if out.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, want %d", out.Code, http.StatusNoContent)
	}
	if out.Body.Len() != 0 {
		t.Errorf("logout body = %q, want empty", out.Body)
	}

	me := call(t, api, http.MethodGet, "/api/v1/me", nil, cookie)
	if me.Code != http.StatusUnauthorized {
		t.Errorf("me after logout = %d, want %d", me.Code, http.StatusUnauthorized)
	}

	// Idempotent.
	again := call(t, api, http.MethodPost, "/api/v1/logout", nil)
	if again.Code != http.StatusNoContent {
		t.Errorf("logout with no session = %d, want %d", again.Code, http.StatusNoContent)
	}
}

func TestBodyDecoding(t *testing.T) {
	tests := []struct {
		name string
		body string
		want int
	}{
		{"unknown field", `{"username":"jozef","bogus":true}`, http.StatusBadRequest},
		{"not json", `{`, http.StatusBadRequest},
		{"empty", ``, http.StatusBadRequest},
		{"over 8 KB", `{"username":"` + strings.Repeat("a", 9000) + `"}`, http.StatusRequestEntityTooLarge},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := call(t, newAPI(t), http.MethodPost, "/api/v1/register", tt.body)
			if rec.Code != tt.want {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, tt.want, rec.Body)
			}
		})
	}
}

func TestResponsesNeverCarryTheSecret(t *testing.T) {
	api := newAPI(t)

	registered := call(t, api, http.MethodPost, "/api/v1/register", registerBody("jozef", "jozef@example.sk"))
	loggedIn := call(t, api, http.MethodPost, "/api/v1/login", map[string]string{
		"email": "jozef@example.sk", "password": goodPassword,
	})
	self := call(t, api, http.MethodGet, "/api/v1/me", nil, sessionCookie(t, registered))

	for name, rec := range map[string]*httptest.ResponseRecorder{
		"register": registered, "login": loggedIn, "me": self,
	} {
		raw := rec.Body.Bytes()
		if bytes.Contains(raw, []byte(goodPassword)) {
			t.Errorf("%s response contains the password: %s", name, raw)
		}
		if bytes.Contains(raw, []byte("$argon2id$")) || bytes.Contains(raw, []byte("password_hash")) {
			t.Errorf("%s response contains the hash: %s", name, raw)
		}
	}
}

func TestDevPageOffByDefault(t *testing.T) {
	rec := call(t, newAPI(t), http.MethodGet, "/dev", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestHealthIsUnaffected(t *testing.T) {
	rec := call(t, newAPI(t), http.MethodGet, "/health", nil)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want %q", got, "application/json")
	}
}

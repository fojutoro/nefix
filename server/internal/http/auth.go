package http

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/fojutoro/nefix/server/internal/password"
	"github.com/fojutoro/nefix/server/internal/store"
)

const maxBodyBytes = 8 << 10

const usernameChars = "abcdefghijklmnopqrstuvwxyz0123456789_-"

// Login verifies against this when the email is unknown, so a missing user and
// a wrong password take the same time.
var dummyHash = newDummyHash()

func newDummyHash() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic("reading randomness for the dummy hash: " + err.Error())
	}

	hash, err := password.Hash(base64.RawStdEncoding.EncodeToString(raw))
	if err != nil {
		panic("hashing the dummy password: " + err.Error())
	}

	return hash
}

// What a user looks like on the wire. The hash has no field, so it cannot leak.
type userResponse struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	Role        string `json:"role"`
}

func newUserResponse(user *store.User) userResponse {
	return userResponse{
		ID:          user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		Email:       user.Email,
		Role:        user.Role,
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeBodyLimit(w, r, dst, maxBodyBytes)
}

// Sync pushes a batch and needs a ceiling of its own; everything else stays
// at 8 KB.
func decodeBodyLimit(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return false
		}
		writeError(w, http.StatusBadRequest, "malformed request body")
		return false
	}

	return true
}

type registerRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	Password    string `json:"password"`
}

// Normalises in place and returns the message to send back, empty when valid.
func (req *registerRequest) validate() string {
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	if n := utf8.RuneCountInString(req.Username); n < 3 || n > 32 {
		return "username must be 3 to 32 characters"
	}
	for _, r := range req.Username {
		if !strings.ContainsRune(usernameChars, r) {
			return "username may contain only letters, digits, underscore and hyphen"
		}
	}

	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if n := utf8.RuneCountInString(req.DisplayName); n < 1 || n > 64 {
		return "display name must be 1 to 64 characters"
	}

	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if len(req.Email) > 254 {
		return "email must be at most 254 characters"
	}
	local, domain, found := strings.Cut(req.Email, "@")
	if !found || local == "" || domain == "" || strings.Contains(domain, "@") {
		return "email must contain exactly one @ with text either side"
	}

	// Bounded because argon2 allocates 64 MiB per hash.
	if n := len(req.Password); n < 8 || n > 128 {
		return "password must be 8 to 128 bytes"
	}

	return ""
}

func (s *server) register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if message := req.validate(); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}

	hash, err := password.Hash(req.Password)
	if err != nil {
		slog.Error("hashing password failed", "error", err)
		writeError(w, http.StatusInternalServerError, "could not create the account")
		return
	}

	user, err := s.db.CreateUser(r.Context(), req.Username, req.DisplayName, req.Email, hash)
	if errors.Is(err, store.ErrDuplicate) {
		// Never which one: saying so would confirm an address is registered.
		writeError(w, http.StatusConflict, "username or email already taken")
		return
	}
	if err != nil {
		slog.Error("creating user failed", "error", err)
		writeError(w, http.StatusInternalServerError, "could not create the account")
		return
	}

	if !s.startSession(w, r, user) {
		return
	}

	writeJSON(w, http.StatusCreated, newUserResponse(user))
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !decodeBody(w, r, &req) {
		return
	}

	user, err := s.db.UserByEmail(r.Context(), req.Email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		slog.Error("looking up user failed", "error", err)
		writeError(w, http.StatusInternalServerError, "could not sign in")
		return
	}

	// Always verify, even with no user, so the two paths cost the same.
	hash := dummyHash
	if user != nil {
		hash = user.PasswordHash
	}
	ok, needsRehash, err := password.Verify(hash, req.Password)
	if err != nil {
		slog.Error("verifying password failed", "error", err)
	}
	if !ok || user == nil {
		writeError(w, http.StatusUnauthorized, "wrong email or password")
		return
	}

	if needsRehash {
		s.rehash(r, user, req.Password)
	}

	if !s.startSession(w, r, user) {
		return
	}

	writeJSON(w, http.StatusOK, newUserResponse(user))
}

// The user is authenticated either way, so a failure here is logged, not fatal.
func (s *server) rehash(r *http.Request, user *store.User, plain string) {
	hash, err := password.Hash(plain)
	if err == nil {
		err = s.db.UpdatePasswordHash(r.Context(), user.ID, hash)
	}
	if err != nil {
		slog.Error("rehashing password failed", "user", user.ID, "error", err)
	}
}

func (s *server) startSession(w http.ResponseWriter, r *http.Request, user *store.User) bool {
	token, expiresAt, err := s.db.CreateSession(r.Context(), user.ID)
	if err != nil {
		slog.Error("creating session failed", "error", err)
		writeError(w, http.StatusInternalServerError, "could not start a session")
		return false
	}
	setSessionCookie(w, token, expiresAt, s.cfg)

	return true
}

// Idempotent: logging out without a session is still a successful logout.
func (s *server) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		if err := s.db.DeleteSession(r.Context(), cookie.Value); err != nil {
			slog.Error("deleting session failed", "error", err)
		}
	}

	clearSessionCookie(w, s.cfg)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) me(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	writeJSON(w, http.StatusOK, newUserResponse(user))
}

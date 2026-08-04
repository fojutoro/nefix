package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

const SessionLifetime = 30 * 24 * time.Hour

// What datetime('now') produces. Every timestamp in the schema uses it, so
// SQL comparisons against datetime('now') work without conversion.
const timestampLayout = "2006-01-02 15:04:05"

func formatTime(t time.Time) string {
	return t.UTC().Format(timestampLayout)
}

func parseTime(s string) (time.Time, error) {
	t, err := time.Parse(timestampLayout, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parsing timestamp %q: %w", s, err)
	}

	return t.UTC(), nil
}

// Only the hash is stored, so a leaked database yields no usable tokens. The
// raw token is 32 random bytes, so a plain digest is enough: there is nothing
// to guess and no need for a slow KDF.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))

	return hex.EncodeToString(sum[:])
}

// Stored at second precision, so callers are told the value that landed.
func sessionExpiry() time.Time {
	return time.Now().UTC().Add(SessionLifetime).Truncate(time.Second)
}

func (db *DB) CreateSession(ctx context.Context, userID int64) (string, time.Time, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, fmt.Errorf("reading session token: %w", err)
	}
	// URL-safe because this value goes into a cookie.
	token := base64.RawURLEncoding.EncodeToString(raw)

	expiresAt := sessionExpiry()
	_, err := db.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
		hashToken(token), userID, formatTime(expiresAt))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("inserting session: %w", err)
	}

	// The raw token goes to the caller and nowhere else.
	return token, expiresAt, nil
}

// An unknown token and an expired one are the same answer, so a caller cannot
// tell them apart. Expiry is compared in SQL, where the data is.
func (db *DB) SessionUser(ctx context.Context, token string) (*User, error) {
	return scanUser(db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM sessions
		JOIN users ON users.id = sessions.user_id
		WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')`, hashToken(token)))
}

func (db *DB) SessionExpiresAt(ctx context.Context, token string) (time.Time, error) {
	var raw string
	err := db.QueryRowContext(ctx,
		`SELECT expires_at FROM sessions
		WHERE token_hash = ? AND expires_at > datetime('now')`, hashToken(token)).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, ErrNotFound
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("reading session expiry: %w", err)
	}

	return parseTime(raw)
}

func (db *DB) TouchSession(ctx context.Context, token string) (time.Time, error) {
	expiresAt := sessionExpiry()

	result, err := db.ExecContext(ctx,
		`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`, formatTime(expiresAt), hashToken(token))
	if err != nil {
		return time.Time{}, fmt.Errorf("extending session: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return time.Time{}, fmt.Errorf("reading rows affected: %w", err)
	}
	if affected == 0 {
		return time.Time{}, ErrNotFound
	}

	return expiresAt, nil
}

// Deleting a token that is not there is success: logout is idempotent.
func (db *DB) DeleteSession(ctx context.Context, token string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, hashToken(token)); err != nil {
		return fmt.Errorf("deleting session: %w", err)
	}

	return nil
}

func (db *DB) DeleteUserSessions(ctx context.Context, userID int64) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("deleting sessions for user %d: %w", userID, err)
	}

	return nil
}

func (db *DB) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	result, err := db.ExecContext(ctx,
		`DELETE FROM sessions WHERE expires_at <= datetime('now')`)
	if err != nil {
		return 0, fmt.Errorf("deleting expired sessions: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("reading rows affected: %w", err)
	}

	return affected, nil
}

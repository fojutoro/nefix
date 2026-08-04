package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func createSession(t *testing.T, db *DB, userID int64) string {
	t.Helper()

	token, _, err := db.CreateSession(context.Background(), userID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	return token
}

func TestCreateSessionAndLookUpUser(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()

	user := createUser(t, db, "jozef", "jozef@example.sk")
	token, expiresAt, err := db.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if token == "" {
		t.Error("empty token")
	}
	if remaining := time.Until(expiresAt); remaining < SessionLifetime-time.Minute {
		t.Errorf("expires in %v, want about %v", remaining, SessionLifetime)
	}

	found, err := db.SessionUser(ctx, token)
	if err != nil {
		t.Fatalf("SessionUser: %v", err)
	}
	if found.ID != user.ID {
		t.Errorf("user id = %d, want %d", found.ID, user.ID)
	}
	if found.Email != user.Email {
		t.Errorf("email = %q, want %q", found.Email, user.Email)
	}
}

func TestSessionTokensDiffer(t *testing.T) {
	db := openTemp(t)
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if first, second := createSession(t, db, user.ID), createSession(t, db, user.ID); first == second {
		t.Error("two sessions got the same token")
	}
}

func TestSessionUserRejects(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	expired := createSession(t, db, user.ID)
	if _, err := db.ExecContext(ctx,
		`UPDATE sessions SET expires_at = datetime('now','-1 hour') WHERE token_hash = ?`, hashToken(expired),
	); err != nil {
		t.Fatalf("expiring session: %v", err)
	}

	tests := []struct {
		name  string
		token string
	}{
		{"unknown token", "nosuchtoken"},
		{"expired session", expired},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := db.SessionUser(ctx, tt.token); !errors.Is(err, ErrNotFound) {
				t.Errorf("error = %v, want %v", err, ErrNotFound)
			}
		})
	}
}

func TestTouchSessionExtendsExpiry(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")
	token := createSession(t, db, user.ID)

	if _, err := db.ExecContext(ctx,
		`UPDATE sessions SET expires_at = datetime('now','+1 hour') WHERE token_hash = ?`, hashToken(token),
	); err != nil {
		t.Fatalf("shortening session: %v", err)
	}

	extended, err := db.TouchSession(ctx, token)
	if err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	if remaining := time.Until(extended); remaining < SessionLifetime-time.Minute {
		t.Errorf("extended to %v away, want about %v", remaining, SessionLifetime)
	}

	stored, err := db.SessionExpiresAt(ctx, token)
	if err != nil {
		t.Fatalf("SessionExpiresAt: %v", err)
	}
	if !stored.Equal(extended) {
		t.Errorf("stored expiry = %v, want %v", stored, extended)
	}

	if _, err := db.TouchSession(ctx, "nosuchtoken"); !errors.Is(err, ErrNotFound) {
		t.Errorf("touching an unknown token: error = %v, want %v", err, ErrNotFound)
	}
}

func TestDeleteSession(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")
	token := createSession(t, db, user.ID)

	if err := db.DeleteSession(ctx, token); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, err := db.SessionUser(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Errorf("after delete: error = %v, want %v", err, ErrNotFound)
	}

	// Logout is idempotent.
	if err := db.DeleteSession(ctx, token); err != nil {
		t.Errorf("deleting twice: %v", err)
	}
}

func TestDeleteUserSessions(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")
	first, second := createSession(t, db, user.ID), createSession(t, db, user.ID)

	if err := db.DeleteUserSessions(ctx, user.ID); err != nil {
		t.Fatalf("DeleteUserSessions: %v", err)
	}

	for _, token := range []string{first, second} {
		if _, err := db.SessionUser(ctx, token); !errors.Is(err, ErrNotFound) {
			t.Errorf("session survived: error = %v, want %v", err, ErrNotFound)
		}
	}
}

func TestDeleteExpiredSessions(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	live := createSession(t, db, user.ID)
	expired := createSession(t, db, user.ID)
	if _, err := db.ExecContext(ctx,
		`UPDATE sessions SET expires_at = datetime('now','-1 hour') WHERE token_hash = ?`, hashToken(expired),
	); err != nil {
		t.Fatalf("expiring session: %v", err)
	}

	deleted, err := db.DeleteExpiredSessions(ctx)
	if err != nil {
		t.Fatalf("DeleteExpiredSessions: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted %d rows, want 1", deleted)
	}
	if _, err := db.SessionUser(ctx, live); err != nil {
		t.Errorf("the live session was removed: %v", err)
	}
}

func TestRawTokenIsNotStored(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")
	token := createSession(t, db, user.ID)

	var stored string
	if err := db.QueryRowContext(ctx, `SELECT token_hash FROM sessions`).Scan(&stored); err != nil {
		t.Fatalf("reading token_hash: %v", err)
	}
	if stored == token {
		t.Fatal("the raw token is in the table")
	}
	if stored != hashToken(token) {
		t.Errorf("token_hash = %q, want %q", stored, hashToken(token))
	}

	// Nothing anywhere in the row carries the raw value.
	var matches int
	if err := db.QueryRowContext(ctx,
		`SELECT count(*) FROM sessions
		WHERE token_hash = ?1 OR user_id = ?1 OR expires_at = ?1 OR created_at = ?1`,
		token).Scan(&matches); err != nil {
		t.Fatalf("scanning for the raw token: %v", err)
	}
	if matches != 0 {
		t.Errorf("%d rows contain the raw token", matches)
	}
}

// Proves ON DELETE CASCADE is active, which needs foreign_keys=ON.
func TestDeletingUserCascadesToSessions(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")
	token := createSession(t, db, user.ID)

	if _, err := db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, user.ID); err != nil {
		t.Fatalf("deleting user: %v", err)
	}

	var count int
	if err := db.QueryRowContext(ctx,
		`SELECT count(*) FROM sessions WHERE token_hash = ?`, hashToken(token)).Scan(&count); err != nil {
		t.Fatalf("counting sessions: %v", err)
	}
	if count != 0 {
		t.Error("the session outlived its user, so ON DELETE CASCADE is not active")
	}
}

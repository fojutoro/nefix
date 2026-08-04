package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	sqlite "modernc.org/sqlite"
	sqlitelib "modernc.org/sqlite/lib"
)

var (
	ErrNotFound  = errors.New("store: not found")
	ErrDuplicate = errors.New("store: already exists")
)

type User struct {
	ID           int64
	Username     string
	DisplayName  string
	Email        string
	PasswordHash string
	Role         string
	FacultyID    *int64
	CreatedAt    string
}

// SQLite UNIQUE is case-sensitive, so every write and every lookup goes
// through this. Otherwise a lookup misses the row its own insert created.
func normalise(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

const userColumns = `id, username, display_name, email, password_hash, role, faculty_id, created_at`

func scanUser(row *sql.Row) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email,
		&u.PasswordHash, &u.Role, &u.FacultyID, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("scanning user: %w", err)
	}

	return &u, nil
}

// Callers get ErrDuplicate rather than having to match on SQLite error text.
func isUniqueViolation(err error) bool {
	var sqliteErr *sqlite.Error
	if !errors.As(err, &sqliteErr) {
		return false
	}

	return sqliteErr.Code() == sqlitelib.SQLITE_CONSTRAINT_UNIQUE ||
		sqliteErr.Code() == sqlitelib.SQLITE_CONSTRAINT_PRIMARYKEY
}

func (db *DB) CreateUser(ctx context.Context, username, displayName, email, passwordHash string) (*User, error) {
	result, err := db.ExecContext(ctx,
		`INSERT INTO users (username, display_name, email, password_hash) VALUES (?, ?, ?, ?)`,
		normalise(username), displayName, normalise(email), passwordHash)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrDuplicate
		}
		return nil, fmt.Errorf("inserting user: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("reading new user id: %w", err)
	}

	return db.UserByID(ctx, id)
}

func (db *DB) UserByID(ctx context.Context, id int64) (*User, error) {
	return scanUser(db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

func (db *DB) UserByEmail(ctx context.Context, email string) (*User, error) {
	return scanUser(db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE email = ?`, normalise(email)))
}

func (db *DB) UpdatePasswordHash(ctx context.Context, id int64, hash string) error {
	result, err := db.ExecContext(ctx,
		`UPDATE users SET password_hash = ? WHERE id = ?`, hash, id)
	if err != nil {
		return fmt.Errorf("updating password hash: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("reading rows affected: %w", err)
	}
	if affected == 0 {
		return ErrNotFound
	}

	return nil
}

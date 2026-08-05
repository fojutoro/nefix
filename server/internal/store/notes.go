package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var (
	ErrVersionConflict = errors.New("store: version conflict")
	ErrForbidden       = errors.New("store: forbidden")
)

type Note struct {
	ID           string
	AuthorID     int64
	ClassID      *int64
	Title        string
	BodyMd       string
	Visibility   string
	ForkedFromID *string
	Version      int64
	Seq          int64
	CreatedAt    time.Time
	UpdatedAt    time.Time
	DeletedAt    *time.Time
}

// What a client may set. Not id-plus-Note: the server owns seq, the
// timestamps and the version it hands back, and a caller must not be able to
// pass them in.
type NoteInput struct {
	ID           string
	ClassID      *int64
	Title        string
	BodyMd       string
	Visibility   string
	ForkedFromID *string
	Version      int64
	DeletedAt    *time.Time
}

const noteColumns = `id, author_id, class_id, title, body_md, visibility,
	forked_from_id, version, seq, created_at, updated_at, deleted_at`

// Satisfied by both *sql.Row and *sql.Rows, so one scan serves the single
// lookups and the pull.
type row interface {
	Scan(dest ...any) error
}

func scanNote(r row) (*Note, error) {
	var n Note
	var createdAt, updatedAt string
	var deletedAt sql.NullString

	err := r.Scan(&n.ID, &n.AuthorID, &n.ClassID, &n.Title, &n.BodyMd, &n.Visibility,
		&n.ForkedFromID, &n.Version, &n.Seq, &createdAt, &updatedAt, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("scanning note: %w", err)
	}

	if n.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, err
	}
	if n.UpdatedAt, err = parseTime(updatedAt); err != nil {
		return nil, err
	}
	if deletedAt.Valid {
		t, err := parseTime(deletedAt.String)
		if err != nil {
			return nil, err
		}
		n.DeletedAt = &t
	}

	return &n, nil
}

// Every timestamp in the schema is written by formatTime or datetime('now'),
// so a nil stays NULL and a value never enters the column in another shape.
func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}

	return formatTime(*t)
}

// Runs in the caller's transaction and never on the pool. The read-back must
// see the increment this transaction wrote and no other: two pushes that both
// read the old value would hand out one seq twice, and a pull whose cursor
// lands between them would skip a note permanently. That is the failure the
// sequence exists to prevent, so it cannot depend on SetMaxOpenConns(1).
func nextSeq(ctx context.Context, tx *sql.Tx, userID int64) (int64, error) {
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET last_seq = last_seq + 1 WHERE id = ?`, userID); err != nil {
		return 0, fmt.Errorf("incrementing last_seq: %w", err)
	}

	var seq int64
	if err := tx.QueryRowContext(ctx,
		`SELECT last_seq FROM users WHERE id = ?`, userID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("reading last_seq: %w", err)
	}

	return seq, nil
}

// Optimistic concurrency. The caller sends the version it last saw: equal
// means accept, anything else means the stored note comes back with
// ErrVersionConflict and the client decides. The server never merges and
// never forks on its own.
func (db *DB) UpsertNote(ctx context.Context, userID int64, in NoteInput) (*Note, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()

	existing, err := scanNote(tx.QueryRowContext(ctx,
		`SELECT `+noteColumns+` FROM notes WHERE id = ?`, in.ID))
	switch {
	case errors.Is(err, ErrNotFound):
		existing = nil
	case err != nil:
		return nil, err
	case existing.AuthorID != userID:
		// The note is not returned. A client that guessed an id learns only
		// that it may not write there.
		return nil, ErrForbidden
	case existing.Version != in.Version:
		return existing, ErrVersionConflict
	}

	seq, err := nextSeq(ctx, tx, userID)
	if err != nil {
		return nil, err
	}

	if existing == nil {
		_, err = tx.ExecContext(ctx,
			`INSERT INTO notes (id, author_id, class_id, title, body_md, visibility,
				forked_from_id, version, seq, deleted_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			in.ID, userID, in.ClassID, in.Title, in.BodyMd, in.Visibility,
			in.ForkedFromID, seq, nullTime(in.DeletedAt))
	} else {
		_, err = tx.ExecContext(ctx,
			`UPDATE notes SET class_id = ?, title = ?, body_md = ?, visibility = ?,
				forked_from_id = ?, version = version + 1, seq = ?,
				updated_at = datetime('now'), deleted_at = ?
			WHERE id = ?`,
			in.ClassID, in.Title, in.BodyMd, in.Visibility,
			in.ForkedFromID, seq, nullTime(in.DeletedAt), in.ID)
	}
	if err != nil {
		return nil, fmt.Errorf("writing note %s: %w", in.ID, err)
	}

	saved, err := scanNote(tx.QueryRowContext(ctx,
		`SELECT `+noteColumns+` FROM notes WHERE id = ?`, in.ID))
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	return saved, nil
}

// Soft-deleted rows are included on purpose: a delete that did not reach the
// other device would leave the note there for ever.
func (db *DB) NotesSince(ctx context.Context, userID, since int64, limit int) ([]Note, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT `+noteColumns+` FROM notes
		WHERE author_id = ? AND seq > ? ORDER BY seq LIMIT ?`, userID, since, limit)
	if err != nil {
		return nil, fmt.Errorf("selecting notes since %d: %w", since, err)
	}
	defer rows.Close()

	notes := make([]Note, 0, limit)
	for rows.Next() {
		note, err := scanNote(rows)
		if err != nil {
			return nil, err
		}
		notes = append(notes, *note)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading notes: %w", err)
	}

	return notes, nil
}

func (db *DB) NoteByID(ctx context.Context, id string) (*Note, error) {
	return scanNote(db.QueryRowContext(ctx,
		`SELECT `+noteColumns+` FROM notes WHERE id = ?`, id))
}

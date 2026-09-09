package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type Class struct {
	ID       string
	AuthorID int64
	Name     string
	Code     *string
	Colour   *string
	Semester *string
	// Archived is not deleted. The row and everything under it stays
	// reachable; only the client's listing hides it.
	ArchivedAt *time.Time
	Version    int64
	Seq        int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
	DeletedAt  *time.Time
}

// What a client may set, as NoteInput is: the server owns seq, the timestamps
// and the version it hands back, and a caller must not be able to pass them
// in.
type ClassInput struct {
	ID         string
	Name       string
	Code       *string
	Colour     *string
	Semester   *string
	ArchivedAt *time.Time
	Version    int64
	DeletedAt  *time.Time
}

const classColumns = `id, author_id, name, code, colour, semester, archived_at,
	version, seq, created_at, updated_at, deleted_at`

// Three nullable timestamps across the two new tables, so the read is a
// function rather than the same six lines each time.
func nullableTime(s sql.NullString) (*time.Time, error) {
	if !s.Valid {
		return nil, nil
	}

	t, err := parseTime(s.String)
	if err != nil {
		return nil, err
	}

	return &t, nil
}

func scanClass(r row) (*Class, error) {
	var c Class
	var createdAt, updatedAt string
	var archivedAt, deletedAt sql.NullString

	err := r.Scan(&c.ID, &c.AuthorID, &c.Name, &c.Code, &c.Colour, &c.Semester,
		&archivedAt, &c.Version, &c.Seq, &createdAt, &updatedAt, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("scanning class: %w", err)
	}

	if c.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, err
	}
	if c.UpdatedAt, err = parseTime(updatedAt); err != nil {
		return nil, err
	}
	if c.ArchivedAt, err = nullableTime(archivedAt); err != nil {
		return nil, err
	}
	if c.DeletedAt, err = nullableTime(deletedAt); err != nil {
		return nil, err
	}

	return &c, nil
}

// Optimistic concurrency, exactly as UpsertNote: the caller sends the version
// it last saw, equal means accept, anything else means the stored class comes
// back with ErrVersionConflict. What the client does with that conflict
// differs from a note's, and that difference lives on the client.
func (db *DB) UpsertClass(ctx context.Context, userID int64, in ClassInput) (*Class, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()

	existing, err := scanClass(tx.QueryRowContext(ctx,
		`SELECT `+classColumns+` FROM classes WHERE id = ?`, in.ID))
	switch {
	case errors.Is(err, ErrNotFound):
		existing = nil
	case err != nil:
		return nil, err
	case existing.AuthorID != userID:
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
			`INSERT INTO classes (id, author_id, name, code, colour, semester,
				archived_at, version, seq, deleted_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			in.ID, userID, in.Name, in.Code, in.Colour, in.Semester,
			nullTime(in.ArchivedAt), seq, nullTime(in.DeletedAt))
	} else {
		_, err = tx.ExecContext(ctx,
			`UPDATE classes SET name = ?, code = ?, colour = ?, semester = ?,
				archived_at = ?, version = version + 1, seq = ?,
				updated_at = datetime('now'), deleted_at = ?
			WHERE id = ?`,
			in.Name, in.Code, in.Colour, in.Semester,
			nullTime(in.ArchivedAt), seq, nullTime(in.DeletedAt), in.ID)
	}
	if err != nil {
		return nil, fmt.Errorf("writing class %s: %w", in.ID, err)
	}

	saved, err := scanClass(tx.QueryRowContext(ctx,
		`SELECT `+classColumns+` FROM classes WHERE id = ?`, in.ID))
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	return saved, nil
}

// Archived classes are included, and so are soft-deleted ones. The pull
// carries the whole stream and the client decides what to show.
func (db *DB) ClassesSince(ctx context.Context, userID, since int64, limit int) ([]Class, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT `+classColumns+` FROM classes
		WHERE author_id = ? AND seq > ? ORDER BY seq LIMIT ?`, userID, since, limit)
	if err != nil {
		return nil, fmt.Errorf("selecting classes since %d: %w", since, err)
	}
	defer rows.Close()

	classes := make([]Class, 0, limit)
	for rows.Next() {
		class, err := scanClass(rows)
		if err != nil {
			return nil, err
		}
		classes = append(classes, *class)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading classes: %w", err)
	}

	return classes, nil
}

func (db *DB) ClassByID(ctx context.Context, id string) (*Class, error) {
	return scanClass(db.QueryRowContext(ctx,
		`SELECT `+classColumns+` FROM classes WHERE id = ?`, id))
}

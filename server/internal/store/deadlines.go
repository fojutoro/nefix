package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type Deadline struct {
	ID       string
	AuthorID int64
	// Nil for a loose deadline, which belongs to no class and is allowed. It
	// may also name a class the server has not been given yet, so nothing
	// here resolves it.
	ClassID *string
	Title   string
	// 'test', 'assignment' or 'other'. Validated at the handler rather than
	// by the column, so an unknown kind from a newer client is a 400 and not
	// a constraint failure that breaks its sync.
	Kind string
	// A date. The time component is midnight UTC and is not meaningful: a
	// test is on Friday, not at 14:30. What "today" means is the client's
	// question, against the reader's own calendar, and is never decided here.
	DueAt time.Time
	Note  *string
	// The client's topics for this deadline, as the JSON text it sent.
	// Opaque here: this package stores and returns the bytes and never reads
	// them. Nil is a deadline with no topics.
	Topics *string
	// Set means ticked off. Not deleted_at: a finished deadline is still a
	// deadline and still comes back from a pull.
	DoneAt    *time.Time
	Version   int64
	Seq       int64
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt *time.Time
}

type DeadlineInput struct {
	ID        string
	ClassID   *string
	Title     string
	Kind      string
	DueAt     time.Time
	Note      *string
	Topics    *string
	DoneAt    *time.Time
	Version   int64
	DeletedAt *time.Time
}

const deadlineColumns = `id, author_id, class_id, title, kind, due_at, note,
	topics, done_at, version, seq, created_at, updated_at, deleted_at`

func scanDeadline(r row) (*Deadline, error) {
	var d Deadline
	var dueAt, createdAt, updatedAt string
	var doneAt, deletedAt sql.NullString

	err := r.Scan(&d.ID, &d.AuthorID, &d.ClassID, &d.Title, &d.Kind, &dueAt, &d.Note,
		&d.Topics, &doneAt, &d.Version, &d.Seq, &createdAt, &updatedAt, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("scanning deadline: %w", err)
	}

	if d.DueAt, err = parseTime(dueAt); err != nil {
		return nil, err
	}
	if d.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, err
	}
	if d.UpdatedAt, err = parseTime(updatedAt); err != nil {
		return nil, err
	}
	if d.DoneAt, err = nullableTime(doneAt); err != nil {
		return nil, err
	}
	if d.DeletedAt, err = nullableTime(deletedAt); err != nil {
		return nil, err
	}

	return &d, nil
}

func (db *DB) UpsertDeadline(ctx context.Context, userID int64, in DeadlineInput) (*Deadline, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()

	existing, err := scanDeadline(tx.QueryRowContext(ctx,
		`SELECT `+deadlineColumns+` FROM deadlines WHERE id = ?`, in.ID))
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

	// A client that predates a kind sends none, and the column is NOT NULL.
	// Defaulted here, the one place that writes it, so binding an empty
	// string cannot defeat the column default the way a plain pass through
	// would. Same as UpsertNotebook.
	kind := in.Kind
	if kind == "" {
		kind = "other"
	}

	if existing == nil {
		_, err = tx.ExecContext(ctx,
			`INSERT INTO deadlines (id, author_id, class_id, title, kind, due_at, note,
				topics, done_at, version, seq, deleted_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			in.ID, userID, in.ClassID, in.Title, kind, formatTime(in.DueAt), in.Note,
			in.Topics, nullTime(in.DoneAt), seq, nullTime(in.DeletedAt))
	} else {
		_, err = tx.ExecContext(ctx,
			`UPDATE deadlines SET class_id = ?, title = ?, kind = ?, due_at = ?, note = ?,
				topics = ?, done_at = ?, version = version + 1, seq = ?,
				updated_at = datetime('now'), deleted_at = ?
			WHERE id = ?`,
			in.ClassID, in.Title, kind, formatTime(in.DueAt), in.Note,
			in.Topics, nullTime(in.DoneAt), seq, nullTime(in.DeletedAt), in.ID)
	}
	if err != nil {
		return nil, fmt.Errorf("writing deadline %s: %w", in.ID, err)
	}

	saved, err := scanDeadline(tx.QueryRowContext(ctx,
		`SELECT `+deadlineColumns+` FROM deadlines WHERE id = ?`, in.ID))
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	return saved, nil
}

func (db *DB) DeadlinesSince(ctx context.Context, userID, since int64, limit int) ([]Deadline, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT `+deadlineColumns+` FROM deadlines
		WHERE author_id = ? AND seq > ? ORDER BY seq LIMIT ?`, userID, since, limit)
	if err != nil {
		return nil, fmt.Errorf("selecting deadlines since %d: %w", since, err)
	}
	defer rows.Close()

	deadlines := make([]Deadline, 0, limit)
	for rows.Next() {
		deadline, err := scanDeadline(rows)
		if err != nil {
			return nil, err
		}
		deadlines = append(deadlines, *deadline)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading deadlines: %w", err)
	}

	return deadlines, nil
}

func (db *DB) DeadlineByID(ctx context.Context, id string) (*Deadline, error) {
	return scanDeadline(db.QueryRowContext(ctx,
		`SELECT `+deadlineColumns+` FROM deadlines WHERE id = ?`, id))
}

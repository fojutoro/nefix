package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type Notebook struct {
	ID       string
	AuthorID int64
	// Nil for a notebook that belongs to no class, which is allowed. It may
	// also name a class the server has not been given yet, so nothing here
	// resolves it.
	ClassID *string
	Name    string
	// The notebook created with its class. Renameable but not deletable, and
	// that rule lives in the UI: nothing in this package or the schema
	// enforces it.
	IsGeneral bool
	// 'notes' or 'collegebook'. Validated at the handler rather than by the
	// column, so an unknown kind from a newer client is a 400 and not a
	// constraint failure that breaks its sync.
	Kind      string
	Version   int64
	Seq       int64
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt *time.Time
}

type NotebookInput struct {
	ID        string
	ClassID   *string
	Name      string
	IsGeneral bool
	Kind      string
	Version   int64
	DeletedAt *time.Time
}

const notebookColumns = `id, author_id, class_id, name, is_general, kind,
	version, seq, created_at, updated_at, deleted_at`

func scanNotebook(r row) (*Notebook, error) {
	var n Notebook
	var createdAt, updatedAt string
	var deletedAt sql.NullString

	err := r.Scan(&n.ID, &n.AuthorID, &n.ClassID, &n.Name, &n.IsGeneral, &n.Kind,
		&n.Version, &n.Seq, &createdAt, &updatedAt, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("scanning notebook: %w", err)
	}

	if n.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, err
	}
	if n.UpdatedAt, err = parseTime(updatedAt); err != nil {
		return nil, err
	}
	if n.DeletedAt, err = nullableTime(deletedAt); err != nil {
		return nil, err
	}

	return &n, nil
}

func (db *DB) UpsertNotebook(ctx context.Context, userID int64, in NotebookInput) (*Notebook, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()

	existing, err := scanNotebook(tx.QueryRowContext(ctx,
		`SELECT `+notebookColumns+` FROM notebooks WHERE id = ?`, in.ID))
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

	// A client that predates collegebooks sends no kind at all, and the column
	// is NOT NULL. Defaulted here, the one place that writes it, so binding an
	// empty string cannot defeat the column default the way a plain pass
	// through would.
	kind := in.Kind
	if kind == "" {
		kind = "notes"
	}

	if existing == nil {
		_, err = tx.ExecContext(ctx,
			`INSERT INTO notebooks (id, author_id, class_id, name, is_general, kind,
				version, seq, deleted_at)
			VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			in.ID, userID, in.ClassID, in.Name, in.IsGeneral, kind,
			seq, nullTime(in.DeletedAt))
	} else {
		_, err = tx.ExecContext(ctx,
			`UPDATE notebooks SET class_id = ?, name = ?, is_general = ?, kind = ?,
				version = version + 1, seq = ?,
				updated_at = datetime('now'), deleted_at = ?
			WHERE id = ?`,
			in.ClassID, in.Name, in.IsGeneral, kind, seq, nullTime(in.DeletedAt), in.ID)
	}
	if err != nil {
		return nil, fmt.Errorf("writing notebook %s: %w", in.ID, err)
	}

	saved, err := scanNotebook(tx.QueryRowContext(ctx,
		`SELECT `+notebookColumns+` FROM notebooks WHERE id = ?`, in.ID))
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	return saved, nil
}

func (db *DB) NotebooksSince(ctx context.Context, userID, since int64, limit int) ([]Notebook, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT `+notebookColumns+` FROM notebooks
		WHERE author_id = ? AND seq > ? ORDER BY seq LIMIT ?`, userID, since, limit)
	if err != nil {
		return nil, fmt.Errorf("selecting notebooks since %d: %w", since, err)
	}
	defer rows.Close()

	notebooks := make([]Notebook, 0, limit)
	for rows.Next() {
		notebook, err := scanNotebook(rows)
		if err != nil {
			return nil, err
		}
		notebooks = append(notebooks, *notebook)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading notebooks: %w", err)
	}

	return notebooks, nil
}

func (db *DB) NotebookByID(ctx context.Context, id string) (*Notebook, error) {
	return scanNotebook(db.QueryRowContext(ctx,
		`SELECT `+notebookColumns+` FROM notebooks WHERE id = ?`, id))
}

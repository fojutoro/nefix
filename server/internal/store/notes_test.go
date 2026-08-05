package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"
)

// Shaped like the client's UUIDv7 without pretending to be one: the server
// checks the shape and never the version.
func noteID(n int) string {
	return fmt.Sprintf("0192f0a1-0000-7000-8000-%012d", n)
}

func noteInput(id string) NoteInput {
	return NoteInput{
		ID:         id,
		Title:      "Diskrétna matematika",
		BodyMd:     "# Množiny",
		Visibility: "private",
	}
}

func ids(notes []Note) []string {
	out := make([]string, 0, len(notes))
	for _, note := range notes {
		out = append(out, note.ID)
	}

	return out
}

// The ORDER BY in NotesSince, on its own. Two other things can return rows in
// seq order without it, and both have to be taken away or the test proves
// nothing: rowid order, which is insertion order and normally matches seq,
// and idx_notes_author_seq, which the planner picks for this exact WHERE
// clause and which walks seq ascending by itself. So the seqs are scrambled
// and the index is dropped. What is left is a table scan in rowid order,
// which is now the wrong order, and only the clause corrects it.
func TestNotesSinceOrdersBySeqAndNothingElse(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	for i := 1; i <= 5; i++ {
		if _, err := db.UpsertNote(ctx, user.ID, noteInput(noteID(i))); err != nil {
			t.Fatalf("UpsertNote %d: %v", i, err)
		}
	}

	if _, err := db.ExecContext(ctx, `DROP INDEX idx_notes_author_seq`); err != nil {
		t.Fatalf("dropping the index: %v", err)
	}

	// Insertion order is 1, 2, 3, 4, 5. Ascending seq becomes 2, 4, 5, 3, 1,
	// a permutation that leaves no note where it was written.
	scrambled := map[int]int64{1: 50, 2: 10, 3: 40, 4: 20, 5: 30}
	for note, seq := range scrambled {
		if _, err := db.ExecContext(ctx,
			`UPDATE notes SET seq = ? WHERE id = ?`, seq, noteID(note)); err != nil {
			t.Fatalf("scrambling the seq of note %d: %v", note, err)
		}
	}
	// Left above every seq in the table, so a later write cannot reuse one.
	if _, err := db.ExecContext(ctx,
		`UPDATE users SET last_seq = 50 WHERE id = ?`, user.ID); err != nil {
		t.Fatalf("raising last_seq: %v", err)
	}

	want := []string{noteID(2), noteID(4), noteID(5), noteID(3), noteID(1)}

	whole, err := db.NotesSince(ctx, user.ID, 0, 10)
	if err != nil {
		t.Fatalf("NotesSince: %v", err)
	}
	if got := ids(whole); !slices.Equal(got, want) {
		t.Errorf("order = %v,\n want   %v", got, want)
	}

	// Paged the way the pull handler pages, taking the cursor from the last
	// row of the page just read. Out of order this skips notes and repeats
	// others, which is the silent loss the sequence exists to prevent.
	var seen []string
	for cursor := int64(0); ; {
		page, err := db.NotesSince(ctx, user.ID, cursor, 2)
		if err != nil {
			t.Fatalf("NotesSince from %d: %v", cursor, err)
		}
		if len(page) == 0 {
			break
		}
		for _, note := range page {
			seen = append(seen, note.ID)
			cursor = note.Seq
		}
		if len(seen) > len(want) {
			t.Fatalf("paging returned %d notes for %d rows, so it is repeating: %v", len(seen), len(want), seen)
		}
	}
	if !slices.Equal(seen, want) {
		t.Errorf("paged = %v,\n want  %v", seen, want)
	}
}

func TestNextSeqRollsBackWithItsTransaction(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}

	seq, err := nextSeq(ctx, tx, user.ID)
	if err != nil {
		t.Fatalf("nextSeq: %v", err)
	}
	if seq != 1 {
		t.Errorf("seq = %d, want 1", seq)
	}

	if err := tx.Rollback(); err != nil {
		t.Fatalf("Rollback: %v", err)
	}

	// The whole point: an increment that survives its caller's rollback ran
	// on the pool, and two pushes could then be handed the same seq.
	var lastSeq int64
	if err := db.QueryRow(`SELECT last_seq FROM users WHERE id = ?`, user.ID).Scan(&lastSeq); err != nil {
		t.Fatalf("reading last_seq: %v", err)
	}
	if lastSeq != 0 {
		t.Errorf("last_seq = %d after rollback, want 0: nextSeq wrote outside the caller's transaction", lastSeq)
	}
}

func TestUpsertNoteInsertsThenUpdates(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	created, err := db.UpsertNote(ctx, user.ID, noteInput(noteID(1)))
	if err != nil {
		t.Fatalf("UpsertNote: %v", err)
	}
	if created.Version != 1 || created.Seq != 1 {
		t.Errorf("version, seq = %d, %d, want 1, 1", created.Version, created.Seq)
	}
	if created.AuthorID != user.ID {
		t.Errorf("author_id = %d, want %d", created.AuthorID, user.ID)
	}
	if created.DeletedAt != nil {
		t.Errorf("deleted_at = %v, want nil", created.DeletedAt)
	}

	next := noteInput(noteID(1))
	next.Version = 1
	next.Title = "Diskrétna matematika 2"

	updated, err := db.UpsertNote(ctx, user.ID, next)
	if err != nil {
		t.Fatalf("UpsertNote update: %v", err)
	}
	if updated.Version != 2 || updated.Seq != 2 {
		t.Errorf("version, seq = %d, %d, want 2, 2", updated.Version, updated.Seq)
	}
	if updated.Title != "Diskrétna matematika 2" {
		t.Errorf("title = %q, want the updated one", updated.Title)
	}
	if !updated.CreatedAt.Equal(created.CreatedAt) {
		t.Errorf("created_at moved from %v to %v", created.CreatedAt, updated.CreatedAt)
	}
}

func TestUpsertNoteConflictReturnsTheStoredCopy(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if _, err := db.UpsertNote(ctx, user.ID, noteInput(noteID(1))); err != nil {
		t.Fatalf("UpsertNote: %v", err)
	}

	stale := noteInput(noteID(1))
	stale.Version = 0
	stale.Title = "written against a version the server has moved past"

	stored, err := db.UpsertNote(ctx, user.ID, stale)
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("error = %v, want ErrVersionConflict", err)
	}
	if stored == nil {
		t.Fatal("no stored copy returned with the conflict")
	}
	if stored.Title != "Diskrétna matematika" {
		t.Errorf("title = %q, want the stored one", stored.Title)
	}
	if stored.Version != 1 {
		t.Errorf("version = %d, want 1: a rejected push must not increment", stored.Version)
	}

	// A rejected push must not consume a sequence number either, or the
	// cursor advances past notes that were never written.
	var lastSeq int64
	if err := db.QueryRow(`SELECT last_seq FROM users WHERE id = ?`, user.ID).Scan(&lastSeq); err != nil {
		t.Fatalf("reading last_seq: %v", err)
	}
	if lastSeq != 1 {
		t.Errorf("last_seq = %d, want 1", lastSeq)
	}
}

func TestUpsertNoteRefusesAnotherUsersNote(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	owner := createUser(t, db, "jozef", "jozef@example.sk")
	intruder := createUser(t, db, "marta", "marta@example.sk")

	if _, err := db.UpsertNote(ctx, owner.ID, noteInput(noteID(1))); err != nil {
		t.Fatalf("UpsertNote: %v", err)
	}

	stolen := noteInput(noteID(1))
	stolen.Version = 1
	stolen.Title = "overwritten"

	note, err := db.UpsertNote(ctx, intruder.ID, stolen)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("error = %v, want ErrForbidden", err)
	}
	if note != nil {
		t.Error("the note was returned: a client that guessed an id learns only that it may not write there")
	}

	unchanged, err := db.NoteByID(ctx, noteID(1))
	if err != nil {
		t.Fatalf("NoteByID: %v", err)
	}
	if unchanged.Title != "Diskrétna matematika" || unchanged.Version != 1 || unchanged.AuthorID != owner.ID {
		t.Errorf("stored note changed: %+v", unchanged)
	}
}

func TestUpsertNoteRoundTripsDeletedAt(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	deletedAt := time.Date(2026, 8, 5, 9, 30, 0, 0, time.UTC)
	input := noteInput(noteID(1))
	input.DeletedAt = &deletedAt

	created, err := db.UpsertNote(ctx, user.ID, input)
	if err != nil {
		t.Fatalf("UpsertNote: %v", err)
	}
	if created.DeletedAt == nil || !created.DeletedAt.Equal(deletedAt) {
		t.Errorf("deleted_at = %v, want %v", created.DeletedAt, deletedAt)
	}
}

func TestNotesSinceFiltersOrdersAndCaps(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")
	other := createUser(t, db, "marta", "marta@example.sk")

	for i := 1; i <= 3; i++ {
		if _, err := db.UpsertNote(ctx, user.ID, noteInput(noteID(i))); err != nil {
			t.Fatalf("UpsertNote %d: %v", i, err)
		}
	}
	if _, err := db.UpsertNote(ctx, other.ID, noteInput(noteID(99))); err != nil {
		t.Fatalf("UpsertNote for the other user: %v", err)
	}

	all, err := db.NotesSince(ctx, user.ID, 0, 10)
	if err != nil {
		t.Fatalf("NotesSince: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("len = %d, want 3: another user's notes must never appear", len(all))
	}
	for i, note := range all {
		if note.Seq != int64(i+1) {
			t.Errorf("notes[%d].Seq = %d, want %d", i, note.Seq, i+1)
		}
	}

	since, err := db.NotesSince(ctx, user.ID, 2, 10)
	if err != nil {
		t.Fatalf("NotesSince from 2: %v", err)
	}
	if len(since) != 1 || since[0].Seq != 3 {
		t.Errorf("from seq 2 got %d notes, want the one at seq 3", len(since))
	}

	capped, err := db.NotesSince(ctx, user.ID, 0, 2)
	if err != nil {
		t.Fatalf("NotesSince capped: %v", err)
	}
	if len(capped) != 2 {
		t.Errorf("len = %d, want 2", len(capped))
	}
}

func TestNotesSinceIncludesDeleted(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if _, err := db.UpsertNote(ctx, user.ID, noteInput(noteID(1))); err != nil {
		t.Fatalf("UpsertNote: %v", err)
	}

	deletedAt := time.Now().UTC().Truncate(time.Second)
	removed := noteInput(noteID(1))
	removed.Version = 1
	removed.DeletedAt = &deletedAt
	if _, err := db.UpsertNote(ctx, user.ID, removed); err != nil {
		t.Fatalf("UpsertNote delete: %v", err)
	}

	notes, err := db.NotesSince(ctx, user.ID, 1, 10)
	if err != nil {
		t.Fatalf("NotesSince: %v", err)
	}
	// A delete that did not travel would leave the note on the other device.
	if len(notes) != 1 || notes[0].DeletedAt == nil {
		t.Fatalf("a soft-deleted note did not come back from a pull: %+v", notes)
	}
}

func TestUpsertNoteHandsOutDistinctSeqsConcurrently(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	const writers = 8
	seqs := make([]int64, writers)
	errs := make([]error, writers)

	var wg sync.WaitGroup
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			note, err := db.UpsertNote(ctx, user.ID, noteInput(noteID(i+1)))
			if err != nil {
				errs[i] = err
				return
			}
			seqs[i] = note.Seq
		}()
	}
	wg.Wait()

	seen := make(map[int64]bool, writers)
	for i, err := range errs {
		if err != nil {
			t.Fatalf("writer %d: %v", i, err)
		}
		if seen[seqs[i]] {
			t.Errorf("seq %d handed out twice: a duplicate makes the pull cursor skip a note", seqs[i])
		}
		seen[seqs[i]] = true
	}
}

func TestNoteByIDReportsMissing(t *testing.T) {
	db := openTemp(t)

	if _, err := db.NoteByID(context.Background(), noteID(1)); !errors.Is(err, ErrNotFound) {
		t.Errorf("error = %v, want ErrNotFound", err)
	}
}

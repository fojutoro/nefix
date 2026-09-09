package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// The store takes pointers for every optional column, and a test that
// needs one otherwise has to name a variable it uses once.
func strptr(s string) *string {
	return &s
}

func notebookID(n int) string {
	return fmt.Sprintf("0192f0c1-0000-7000-8000-%012d", n)
}

func notebookInput(id string) NotebookInput {
	return NotebookInput{
		ID:   id,
		Name: "Prednášky",
	}
}

func TestUpsertNotebookInsertsThenUpdates(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	in := notebookInput(notebookID(1))
	in.ClassID = strptr(classID(1))
	in.IsGeneral = true

	created, err := db.UpsertNotebook(ctx, user.ID, in)
	if err != nil {
		t.Fatalf("UpsertNotebook: %v", err)
	}
	if created.Version != 1 || created.Seq != 1 {
		t.Errorf("version, seq = %d, %d, want 1, 1", created.Version, created.Seq)
	}
	if created.AuthorID != user.ID {
		t.Errorf("author_id = %d, want %d", created.AuthorID, user.ID)
	}
	if created.ClassID == nil || *created.ClassID != classID(1) {
		t.Errorf("class_id = %v, want %s", created.ClassID, classID(1))
	}
	if !created.IsGeneral {
		t.Error("is_general = false, want true")
	}

	next := notebookInput(notebookID(1))
	next.ClassID = strptr(classID(1))
	next.IsGeneral = true
	next.Version = 1
	next.Name = "Všeobecné"

	updated, err := db.UpsertNotebook(ctx, user.ID, next)
	if err != nil {
		t.Fatalf("UpsertNotebook update: %v", err)
	}
	if updated.Version != 2 || updated.Seq != 2 {
		t.Errorf("version, seq = %d, %d, want 2, 2", updated.Version, updated.Seq)
	}
	// Renameable, which is the whole difference between a general notebook
	// and a fixed one.
	if updated.Name != "Všeobecné" {
		t.Errorf("name = %q, want the updated one", updated.Name)
	}
	if !updated.CreatedAt.Equal(created.CreatedAt) {
		t.Errorf("created_at moved from %v to %v", created.CreatedAt, updated.CreatedAt)
	}
}

func TestUpsertNotebookConflictReturnsTheStoredCopy(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if _, err := db.UpsertNotebook(ctx, user.ID, notebookInput(notebookID(1))); err != nil {
		t.Fatalf("UpsertNotebook: %v", err)
	}

	stale := notebookInput(notebookID(1))
	stale.Version = 0
	stale.Name = "written against a version the server has moved past"

	stored, err := db.UpsertNotebook(ctx, user.ID, stale)
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("error = %v, want ErrVersionConflict", err)
	}
	if stored == nil {
		t.Fatal("no stored copy returned with the conflict")
	}
	// The server reports what it holds and never merges. That the client
	// resolves this one by taking the server's copy rather than forking is
	// the client's decision and changes nothing here.
	if stored.Name != "Prednášky" {
		t.Errorf("name = %q, want the stored one", stored.Name)
	}
	if stored.Version != 1 {
		t.Errorf("version = %d, want 1: a rejected push must not increment", stored.Version)
	}

	var lastSeq int64
	if err := db.QueryRow(`SELECT last_seq FROM users WHERE id = ?`, user.ID).Scan(&lastSeq); err != nil {
		t.Fatalf("reading last_seq: %v", err)
	}
	if lastSeq != 1 {
		t.Errorf("last_seq = %d, want 1", lastSeq)
	}
}

func TestUpsertNotebookRefusesAnotherUsersNotebook(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	owner := createUser(t, db, "jozef", "jozef@example.sk")
	intruder := createUser(t, db, "marta", "marta@example.sk")

	if _, err := db.UpsertNotebook(ctx, owner.ID, notebookInput(notebookID(1))); err != nil {
		t.Fatalf("UpsertNotebook: %v", err)
	}

	stolen := notebookInput(notebookID(1))
	stolen.Version = 1
	stolen.Name = "overwritten"

	notebook, err := db.UpsertNotebook(ctx, intruder.ID, stolen)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("error = %v, want ErrForbidden", err)
	}
	if notebook != nil {
		t.Error("the notebook was returned: a client that guessed an id learns only that it may not write there")
	}

	unchanged, err := db.NotebookByID(ctx, notebookID(1))
	if err != nil {
		t.Fatalf("NotebookByID: %v", err)
	}
	if unchanged.Name != "Prednášky" || unchanged.Version != 1 || unchanged.AuthorID != owner.ID {
		t.Errorf("stored notebook changed: %+v", unchanged)
	}
}

// The missing REFERENCES clause, tested rather than assumed. A client
// syncing out of order pushes a notebook before its class and a note before
// its notebook, and neither may be answered with a constraint failure that
// the handler can only turn into a 500.
func TestRowsAcceptIDsTheServerHasNotSeen(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	orphan := notebookInput(notebookID(1))
	orphan.ClassID = strptr(classID(404))

	notebook, err := db.UpsertNotebook(ctx, user.ID, orphan)
	if err != nil {
		t.Fatalf("UpsertNotebook with an unknown class: %v", err)
	}
	if notebook.ClassID == nil || *notebook.ClassID != classID(404) {
		t.Errorf("class_id = %v, want it stored unchanged", notebook.ClassID)
	}

	unfiled := noteInput(noteID(1))
	unfiled.NotebookID = strptr(notebookID(404))

	note, err := db.UpsertNote(ctx, user.ID, unfiled)
	if err != nil {
		t.Fatalf("UpsertNote with an unknown notebook: %v", err)
	}
	if note.NotebookID == nil || *note.NotebookID != notebookID(404) {
		t.Errorf("notebook_id = %v, want it stored unchanged", note.NotebookID)
	}
}

// An unfiled note is a real case and must not require setting up a class
// first, so a nil notebook_id is stored and read back as one.
func TestUpsertNoteKeepsAnUnfiledNoteUnfiled(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	note, err := db.UpsertNote(ctx, user.ID, noteInput(noteID(1)))
	if err != nil {
		t.Fatalf("UpsertNote: %v", err)
	}
	if note.NotebookID != nil {
		t.Errorf("notebook_id = %v, want nil", note.NotebookID)
	}
}

func TestNotebooksSinceFiltersOrdersAndCaps(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")
	other := createUser(t, db, "marta", "marta@example.sk")

	for i := 1; i <= 3; i++ {
		if _, err := db.UpsertNotebook(ctx, user.ID, notebookInput(notebookID(i))); err != nil {
			t.Fatalf("UpsertNotebook %d: %v", i, err)
		}
	}
	if _, err := db.UpsertNotebook(ctx, other.ID, notebookInput(notebookID(99))); err != nil {
		t.Fatalf("UpsertNotebook for the other user: %v", err)
	}

	all, err := db.NotebooksSince(ctx, user.ID, 0, 10)
	if err != nil {
		t.Fatalf("NotebooksSince: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("len = %d, want 3: another user's notebooks must never appear", len(all))
	}
	for i, notebook := range all {
		if notebook.Seq != int64(i+1) {
			t.Errorf("notebooks[%d].Seq = %d, want %d", i, notebook.Seq, i+1)
		}
	}

	since, err := db.NotebooksSince(ctx, user.ID, 2, 10)
	if err != nil {
		t.Fatalf("NotebooksSince from 2: %v", err)
	}
	if len(since) != 1 || since[0].Seq != 3 {
		t.Errorf("from seq 2 got %d notebooks, want the one at seq 3", len(since))
	}

	capped, err := db.NotebooksSince(ctx, user.ID, 0, 2)
	if err != nil {
		t.Fatalf("NotebooksSince capped: %v", err)
	}
	if len(capped) != 2 {
		t.Errorf("len = %d, want 2", len(capped))
	}
}

func TestNotebooksSinceIncludesDeleted(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if _, err := db.UpsertNotebook(ctx, user.ID, notebookInput(notebookID(1))); err != nil {
		t.Fatalf("UpsertNotebook: %v", err)
	}

	deletedAt := time.Now().UTC().Truncate(time.Second)
	removed := notebookInput(notebookID(1))
	removed.Version = 1
	removed.DeletedAt = &deletedAt
	if _, err := db.UpsertNotebook(ctx, user.ID, removed); err != nil {
		t.Fatalf("UpsertNotebook delete: %v", err)
	}

	notebooks, err := db.NotebooksSince(ctx, user.ID, 1, 10)
	if err != nil {
		t.Fatalf("NotebooksSince: %v", err)
	}
	if len(notebooks) != 1 || notebooks[0].DeletedAt == nil {
		t.Fatalf("a soft-deleted notebook did not come back from a pull: %+v", notebooks)
	}
}

func TestNotebookByIDReportsMissing(t *testing.T) {
	db := openTemp(t)

	if _, err := db.NotebookByID(context.Background(), notebookID(1)); !errors.Is(err, ErrNotFound) {
		t.Errorf("error = %v, want ErrNotFound", err)
	}
}

package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// Shaped like the client's UUIDv7 without pretending to be one, as noteID is.
func classID(n int) string {
	return fmt.Sprintf("0192f0b1-0000-7000-8000-%012d", n)
}

func classInput(id string) ClassInput {
	code := "1-AIN-101"
	return ClassInput{
		ID:   id,
		Name: "Diskrétna matematika",
		Code: &code,
	}
}

func TestUpsertClassInsertsThenUpdates(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	created, err := db.UpsertClass(ctx, user.ID, classInput(classID(1)))
	if err != nil {
		t.Fatalf("UpsertClass: %v", err)
	}
	if created.Version != 1 || created.Seq != 1 {
		t.Errorf("version, seq = %d, %d, want 1, 1", created.Version, created.Seq)
	}
	if created.AuthorID != user.ID {
		t.Errorf("author_id = %d, want %d", created.AuthorID, user.ID)
	}
	if created.Code == nil || *created.Code != "1-AIN-101" {
		t.Errorf("code = %v, want 1-AIN-101", created.Code)
	}
	if created.ArchivedAt != nil {
		t.Errorf("archived_at = %v, want nil", created.ArchivedAt)
	}

	next := classInput(classID(1))
	next.Version = 1
	next.Name = "Diskrétna matematika 2"

	updated, err := db.UpsertClass(ctx, user.ID, next)
	if err != nil {
		t.Fatalf("UpsertClass update: %v", err)
	}
	if updated.Version != 2 || updated.Seq != 2 {
		t.Errorf("version, seq = %d, %d, want 2, 2", updated.Version, updated.Seq)
	}
	if updated.Name != "Diskrétna matematika 2" {
		t.Errorf("name = %q, want the updated one", updated.Name)
	}
	if !updated.CreatedAt.Equal(created.CreatedAt) {
		t.Errorf("created_at moved from %v to %v", created.CreatedAt, updated.CreatedAt)
	}
}

func TestUpsertClassConflictReturnsTheStoredCopy(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if _, err := db.UpsertClass(ctx, user.ID, classInput(classID(1))); err != nil {
		t.Fatalf("UpsertClass: %v", err)
	}

	stale := classInput(classID(1))
	stale.Version = 0
	stale.Name = "written against a version the server has moved past"

	stored, err := db.UpsertClass(ctx, user.ID, stale)
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("error = %v, want ErrVersionConflict", err)
	}
	if stored == nil {
		t.Fatal("no stored copy returned with the conflict")
	}
	if stored.Name != "Diskrétna matematika" {
		t.Errorf("name = %q, want the stored one", stored.Name)
	}
	if stored.Version != 1 {
		t.Errorf("version = %d, want 1: a rejected push must not increment", stored.Version)
	}

	// A rejected push must not consume a sequence number either, or the
	// cursor advances past rows that were never written.
	var lastSeq int64
	if err := db.QueryRow(`SELECT last_seq FROM users WHERE id = ?`, user.ID).Scan(&lastSeq); err != nil {
		t.Fatalf("reading last_seq: %v", err)
	}
	if lastSeq != 1 {
		t.Errorf("last_seq = %d, want 1", lastSeq)
	}
}

func TestUpsertClassRefusesAnotherUsersClass(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	owner := createUser(t, db, "jozef", "jozef@example.sk")
	intruder := createUser(t, db, "marta", "marta@example.sk")

	if _, err := db.UpsertClass(ctx, owner.ID, classInput(classID(1))); err != nil {
		t.Fatalf("UpsertClass: %v", err)
	}

	stolen := classInput(classID(1))
	stolen.Version = 1
	stolen.Name = "overwritten"

	class, err := db.UpsertClass(ctx, intruder.ID, stolen)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("error = %v, want ErrForbidden", err)
	}
	if class != nil {
		t.Error("the class was returned: a client that guessed an id learns only that it may not write there")
	}

	unchanged, err := db.ClassByID(ctx, classID(1))
	if err != nil {
		t.Fatalf("ClassByID: %v", err)
	}
	if unchanged.Name != "Diskrétna matematika" || unchanged.Version != 1 || unchanged.AuthorID != owner.ID {
		t.Errorf("stored class changed: %+v", unchanged)
	}
}

// Archiving travels as an ordinary field on an ordinary update. It is not a
// delete: deleted_at stays nil and the row keeps coming back from a pull.
func TestUpsertClassRoundTripsArchivedAt(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if _, err := db.UpsertClass(ctx, user.ID, classInput(classID(1))); err != nil {
		t.Fatalf("UpsertClass: %v", err)
	}

	archivedAt := time.Date(2026, 8, 5, 9, 30, 0, 0, time.UTC)
	archived := classInput(classID(1))
	archived.Version = 1
	archived.ArchivedAt = &archivedAt

	stored, err := db.UpsertClass(ctx, user.ID, archived)
	if err != nil {
		t.Fatalf("UpsertClass archive: %v", err)
	}
	if stored.ArchivedAt == nil || !stored.ArchivedAt.Equal(archivedAt) {
		t.Errorf("archived_at = %v, want %v", stored.ArchivedAt, archivedAt)
	}
	if stored.DeletedAt != nil {
		t.Errorf("deleted_at = %v: archiving is not deleting", stored.DeletedAt)
	}

	restored := classInput(classID(1))
	restored.Version = 2
	unarchived, err := db.UpsertClass(ctx, user.ID, restored)
	if err != nil {
		t.Fatalf("UpsertClass unarchive: %v", err)
	}
	if unarchived.ArchivedAt != nil {
		t.Errorf("archived_at = %v, want nil after unarchiving", unarchived.ArchivedAt)
	}
}

func TestClassesSinceFiltersOrdersAndCaps(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")
	other := createUser(t, db, "marta", "marta@example.sk")

	for i := 1; i <= 3; i++ {
		if _, err := db.UpsertClass(ctx, user.ID, classInput(classID(i))); err != nil {
			t.Fatalf("UpsertClass %d: %v", i, err)
		}
	}
	if _, err := db.UpsertClass(ctx, other.ID, classInput(classID(99))); err != nil {
		t.Fatalf("UpsertClass for the other user: %v", err)
	}

	all, err := db.ClassesSince(ctx, user.ID, 0, 10)
	if err != nil {
		t.Fatalf("ClassesSince: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("len = %d, want 3: another user's classes must never appear", len(all))
	}
	for i, class := range all {
		if class.Seq != int64(i+1) {
			t.Errorf("classes[%d].Seq = %d, want %d", i, class.Seq, i+1)
		}
	}

	since, err := db.ClassesSince(ctx, user.ID, 2, 10)
	if err != nil {
		t.Fatalf("ClassesSince from 2: %v", err)
	}
	if len(since) != 1 || since[0].Seq != 3 {
		t.Errorf("from seq 2 got %d classes, want the one at seq 3", len(since))
	}

	capped, err := db.ClassesSince(ctx, user.ID, 0, 2)
	if err != nil {
		t.Fatalf("ClassesSince capped: %v", err)
	}
	if len(capped) != 2 {
		t.Errorf("len = %d, want 2", len(capped))
	}
}

// One counter across all three types. Two counters would let a client hold a
// consistent view of its notes and a stale one of the notebooks they sit in,
// and this is the store-level half of that guarantee: no seq is handed out
// twice, and the order across types is the order the rows were written.
func TestSeqIsSharedAcrossClassesNotebooksAndNotes(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	class, err := db.UpsertClass(ctx, user.ID, classInput(classID(1)))
	if err != nil {
		t.Fatalf("UpsertClass: %v", err)
	}
	notebook, err := db.UpsertNotebook(ctx, user.ID, notebookInput(notebookID(1)))
	if err != nil {
		t.Fatalf("UpsertNotebook: %v", err)
	}
	note, err := db.UpsertNote(ctx, user.ID, noteInput(noteID(1)))
	if err != nil {
		t.Fatalf("UpsertNote: %v", err)
	}

	if class.Seq != 1 || notebook.Seq != 2 || note.Seq != 3 {
		t.Errorf("seqs = %d, %d, %d, want 1, 2, 3 from one shared counter",
			class.Seq, notebook.Seq, note.Seq)
	}

	// A cursor at 1 has seen the class and nothing else, whatever table the
	// rest of the stream happens to live in.
	classes, err := db.ClassesSince(ctx, user.ID, 1, 10)
	if err != nil {
		t.Fatalf("ClassesSince: %v", err)
	}
	notebooks, err := db.NotebooksSince(ctx, user.ID, 1, 10)
	if err != nil {
		t.Fatalf("NotebooksSince: %v", err)
	}
	notes, err := db.NotesSince(ctx, user.ID, 1, 10)
	if err != nil {
		t.Fatalf("NotesSince: %v", err)
	}
	if len(classes) != 0 || len(notebooks) != 1 || len(notes) != 1 {
		t.Errorf("from seq 1 got %d classes, %d notebooks, %d notes, want 0, 1, 1",
			len(classes), len(notebooks), len(notes))
	}
}

func TestClassByIDReportsMissing(t *testing.T) {
	db := openTemp(t)

	if _, err := db.ClassByID(context.Background(), classID(1)); !errors.Is(err, ErrNotFound) {
		t.Errorf("error = %v, want ErrNotFound", err)
	}
}

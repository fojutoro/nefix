package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func deadlineID(n int) string {
	return fmt.Sprintf("0192f0d1-0000-7000-8000-%012d", n)
}

// Midnight UTC, because due_at is a date: the time component is stored and
// returned but means nothing.
func due(day int) time.Time {
	return time.Date(2026, 10, day, 0, 0, 0, 0, time.UTC)
}

func deadlineInput(id string) DeadlineInput {
	return DeadlineInput{
		ID:    id,
		Title: "Písomka z diskrétnej matematiky",
		DueAt: due(9),
	}
}

func TestUpsertDeadlineInsertsThenUpdates(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	in := deadlineInput(deadlineID(1))
	in.ClassID = strptr(classID(1))
	in.Kind = "test"
	in.Note = strptr("prines kalkulačku")

	created, err := db.UpsertDeadline(ctx, user.ID, in)
	if err != nil {
		t.Fatalf("UpsertDeadline: %v", err)
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
	if !created.DueAt.Equal(due(9)) {
		t.Errorf("due_at = %v, want %v", created.DueAt, due(9))
	}
	if created.Kind != "test" {
		t.Errorf("kind = %q, want test", created.Kind)
	}
	if created.Note == nil || *created.Note != "prines kalkulačku" {
		t.Errorf("note = %v, want it stored", created.Note)
	}
	if created.DoneAt != nil {
		t.Errorf("done_at = %v, want nil on a fresh deadline", *created.DoneAt)
	}

	next := deadlineInput(deadlineID(1))
	next.ClassID = strptr(classID(1))
	next.Kind = "test"
	next.Version = 1
	next.DueAt = due(16)
	next.Title = "Písomka, presunutá"

	updated, err := db.UpsertDeadline(ctx, user.ID, next)
	if err != nil {
		t.Fatalf("UpsertDeadline update: %v", err)
	}
	if updated.Version != 2 || updated.Seq != 2 {
		t.Errorf("version, seq = %d, %d, want 2, 2", updated.Version, updated.Seq)
	}
	if !updated.DueAt.Equal(due(16)) {
		t.Errorf("due_at = %v, want the moved date %v", updated.DueAt, due(16))
	}
	if updated.Title != "Písomka, presunutá" {
		t.Errorf("title = %q, want the updated one", updated.Title)
	}
	// The update path has to clear a column the caller left unset, or a note
	// erased on one device would come back on the next pull.
	if updated.Note != nil {
		t.Errorf("note = %v, want nil once the caller stopped sending one", *updated.Note)
	}
	if !updated.CreatedAt.Equal(created.CreatedAt) {
		t.Errorf("created_at moved from %v to %v", created.CreatedAt, updated.CreatedAt)
	}
}

func TestUpsertDeadlineConflictReturnsTheStoredCopy(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if _, err := db.UpsertDeadline(ctx, user.ID, deadlineInput(deadlineID(1))); err != nil {
		t.Fatalf("UpsertDeadline: %v", err)
	}

	stale := deadlineInput(deadlineID(1))
	stale.Version = 0
	stale.Title = "written against a version the server has moved past"

	stored, err := db.UpsertDeadline(ctx, user.ID, stale)
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("error = %v, want ErrVersionConflict", err)
	}
	if stored == nil {
		t.Fatal("no stored copy returned with the conflict")
	}
	// The server reports what it holds and never merges. That the client
	// resolves this one by taking the server's copy rather than forking is
	// the client's decision and changes nothing here.
	if stored.Title != "Písomka z diskrétnej matematiky" {
		t.Errorf("title = %q, want the stored one", stored.Title)
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

func TestUpsertDeadlineRefusesAnotherUsersDeadline(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	owner := createUser(t, db, "jozef", "jozef@example.sk")
	intruder := createUser(t, db, "marta", "marta@example.sk")

	if _, err := db.UpsertDeadline(ctx, owner.ID, deadlineInput(deadlineID(1))); err != nil {
		t.Fatalf("UpsertDeadline: %v", err)
	}

	stolen := deadlineInput(deadlineID(1))
	stolen.Version = 1
	stolen.Title = "overwritten"

	deadline, err := db.UpsertDeadline(ctx, intruder.ID, stolen)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("error = %v, want ErrForbidden", err)
	}
	if deadline != nil {
		t.Error("the deadline was returned: a client that guessed an id learns only that it may not write there")
	}

	unchanged, err := db.DeadlineByID(ctx, deadlineID(1))
	if err != nil {
		t.Fatalf("DeadlineByID: %v", err)
	}
	if unchanged.Title != "Písomka z diskrétnej matematiky" || unchanged.Version != 1 ||
		unchanged.AuthorID != owner.ID {
		t.Errorf("stored deadline changed: %+v", unchanged)
	}
}

// A loose deadline belongs to no class, and a deadline may also name a class
// this server has not been given yet. Neither may be answered with a
// constraint failure the handler can only turn into a 500, which is why the
// column carries no REFERENCES.
func TestUpsertDeadlineAcceptsLooseAndUnknownClasses(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	loose, err := db.UpsertDeadline(ctx, user.ID, deadlineInput(deadlineID(1)))
	if err != nil {
		t.Fatalf("UpsertDeadline loose: %v", err)
	}
	if loose.ClassID != nil {
		t.Errorf("class_id = %v, want nil", *loose.ClassID)
	}

	orphan := deadlineInput(deadlineID(2))
	orphan.ClassID = strptr(classID(404))

	stored, err := db.UpsertDeadline(ctx, user.ID, orphan)
	if err != nil {
		t.Fatalf("UpsertDeadline with an unknown class: %v", err)
	}
	if stored.ClassID == nil || *stored.ClassID != classID(404) {
		t.Errorf("class_id = %v, want it stored unchanged", stored.ClassID)
	}
}

// 'other' is the column default and what a caller that names no kind gets.
func TestUpsertDeadlineDefaultsKindToOther(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	plain, err := db.UpsertDeadline(ctx, user.ID, deadlineInput(deadlineID(1)))
	if err != nil {
		t.Fatalf("UpsertDeadline: %v", err)
	}
	if plain.Kind != "other" {
		t.Errorf("kind = %q, want other", plain.Kind)
	}

	in := deadlineInput(deadlineID(2))
	in.Kind = "assignment"
	assignment, err := db.UpsertDeadline(ctx, user.ID, in)
	if err != nil {
		t.Fatalf("UpsertDeadline assignment: %v", err)
	}
	if assignment.Kind != "assignment" {
		t.Errorf("kind = %q, want assignment", assignment.Kind)
	}

	read, err := db.DeadlineByID(ctx, deadlineID(2))
	if err != nil {
		t.Fatalf("DeadlineByID: %v", err)
	}
	if read.Kind != "assignment" {
		t.Errorf("kind read back = %q, want assignment", read.Kind)
	}
}

// Opaque bytes: the store writes what it is handed and reads it back. The
// unknown key is the point — a server that parsed this column would drop it.
func TestUpsertDeadlineRoundTripsTopicsAndDefaultsToNull(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	plain, err := db.UpsertDeadline(ctx, user.ID, deadlineInput(deadlineID(1)))
	if err != nil {
		t.Fatalf("UpsertDeadline: %v", err)
	}
	if plain.Topics != nil {
		t.Errorf("topics = %v, want nil on a deadline that set none", *plain.Topics)
	}

	const blob = `[{"noteId":"0192f0a1-0000-7000-8000-000000000001","heading":"Množiny","colour":"red"}]`
	withTopics := deadlineInput(deadlineID(2))
	withTopics.Topics = strptr(blob)
	saved, err := db.UpsertDeadline(ctx, user.ID, withTopics)
	if err != nil {
		t.Fatalf("UpsertDeadline: %v", err)
	}
	if saved.Topics == nil || *saved.Topics != blob {
		t.Fatalf("topics = %v, want %s byte for byte", saved.Topics, blob)
	}

	// And an update carries them, rather than the column surviving only the
	// insert path.
	next := deadlineInput(deadlineID(2))
	next.Version = 1
	next.Topics = strptr(`[{"noteId":"0192f0a1-0000-7000-8000-000000000002","heading":"Relácie"}]`)
	updated, err := db.UpsertDeadline(ctx, user.ID, next)
	if err != nil {
		t.Fatalf("UpsertDeadline: %v", err)
	}
	if updated.Topics == nil || *updated.Topics != *next.Topics {
		t.Fatalf("topics = %v, want %s", updated.Topics, *next.Topics)
	}

	read, err := db.DeadlineByID(ctx, deadlineID(2))
	if err != nil {
		t.Fatalf("DeadlineByID: %v", err)
	}
	if read.Topics == nil || *read.Topics != *next.Topics {
		t.Fatalf("topics read back = %v, want %s", read.Topics, *next.Topics)
	}
}

// Ticking off and un-ticking are ordinary updates on an ordinary column.
func TestUpsertDeadlineRoundTripsDoneAt(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if _, err := db.UpsertDeadline(ctx, user.ID, deadlineInput(deadlineID(1))); err != nil {
		t.Fatalf("UpsertDeadline: %v", err)
	}

	doneAt := time.Now().UTC().Truncate(time.Second)
	ticked := deadlineInput(deadlineID(1))
	ticked.Version = 1
	ticked.DoneAt = &doneAt

	done, err := db.UpsertDeadline(ctx, user.ID, ticked)
	if err != nil {
		t.Fatalf("UpsertDeadline done: %v", err)
	}
	if done.DoneAt == nil || !done.DoneAt.Equal(doneAt) {
		t.Fatalf("done_at = %v, want %v", done.DoneAt, doneAt)
	}

	untick := deadlineInput(deadlineID(1))
	untick.Version = 2
	back, err := db.UpsertDeadline(ctx, user.ID, untick)
	if err != nil {
		t.Fatalf("UpsertDeadline untick: %v", err)
	}
	if back.DoneAt != nil {
		t.Errorf("done_at = %v, want nil after un-ticking", *back.DoneAt)
	}
}

func TestDeadlinesSinceFiltersOrdersAndCaps(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")
	other := createUser(t, db, "marta", "marta@example.sk")

	for i := 1; i <= 3; i++ {
		if _, err := db.UpsertDeadline(ctx, user.ID, deadlineInput(deadlineID(i))); err != nil {
			t.Fatalf("UpsertDeadline %d: %v", i, err)
		}
	}
	if _, err := db.UpsertDeadline(ctx, other.ID, deadlineInput(deadlineID(99))); err != nil {
		t.Fatalf("UpsertDeadline for the other user: %v", err)
	}

	all, err := db.DeadlinesSince(ctx, user.ID, 0, 10)
	if err != nil {
		t.Fatalf("DeadlinesSince: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("len = %d, want 3: another user's deadlines must never appear", len(all))
	}
	for i, deadline := range all {
		if deadline.Seq != int64(i+1) {
			t.Errorf("deadlines[%d].Seq = %d, want %d", i, deadline.Seq, i+1)
		}
	}

	since, err := db.DeadlinesSince(ctx, user.ID, 2, 10)
	if err != nil {
		t.Fatalf("DeadlinesSince from 2: %v", err)
	}
	if len(since) != 1 || since[0].Seq != 3 {
		t.Errorf("from seq 2 got %d deadlines, want the one at seq 3", len(since))
	}

	capped, err := db.DeadlinesSince(ctx, user.ID, 0, 2)
	if err != nil {
		t.Fatalf("DeadlinesSince capped: %v", err)
	}
	if len(capped) != 2 {
		t.Errorf("len = %d, want 2", len(capped))
	}
}

func TestDeadlinesSinceIncludesDeleted(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	user := createUser(t, db, "jozef", "jozef@example.sk")

	if _, err := db.UpsertDeadline(ctx, user.ID, deadlineInput(deadlineID(1))); err != nil {
		t.Fatalf("UpsertDeadline: %v", err)
	}

	deletedAt := time.Now().UTC().Truncate(time.Second)
	removed := deadlineInput(deadlineID(1))
	removed.Version = 1
	removed.DeletedAt = &deletedAt
	if _, err := db.UpsertDeadline(ctx, user.ID, removed); err != nil {
		t.Fatalf("UpsertDeadline delete: %v", err)
	}

	deadlines, err := db.DeadlinesSince(ctx, user.ID, 1, 10)
	if err != nil {
		t.Fatalf("DeadlinesSince: %v", err)
	}
	if len(deadlines) != 1 || deadlines[0].DeletedAt == nil {
		t.Fatalf("a soft-deleted deadline did not come back from a pull: %+v", deadlines)
	}
}

func TestDeadlineByIDReportsMissing(t *testing.T) {
	db := openTemp(t)

	if _, err := db.DeadlineByID(context.Background(), deadlineID(1)); !errors.Is(err, ErrNotFound) {
		t.Errorf("error = %v, want ErrNotFound", err)
	}
}

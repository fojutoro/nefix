package http

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func deadlineSyncID(n int) string {
	return fmt.Sprintf("0192f0d1-0000-7000-8000-%012d", n)
}

// Every field, because the decoder rejects unknown ones and a client that
// omits one is sending a different row than it thinks.
func deadlinePayload(id string, version int64) map[string]any {
	return map[string]any{
		"id":         id,
		"class_id":   nil,
		"title":      "Písomka z diskrétnej matematiky",
		"kind":       "test",
		"due_at":     "2026-10-09T00:00:00Z",
		"note":       nil,
		"topics":     nil,
		"done_at":    nil,
		"version":    version,
		"deleted_at": nil,
	}
}

// The opaque columns are *string, and a failure that printed the pointer
// would say nothing about the bytes that came back, which is the entire
// subject of the test below.
func text(s *string) string {
	if s == nil {
		return "<null>"
	}

	return *s
}

func TestPushAcceptsADeadlineThenAnUpdate(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	created := pushRows(t, api, cookie, map[string]any{
		"deadlines": []any{deadlinePayload(deadlineSyncID(1), 0)},
	})
	if len(created.Results) != 1 {
		t.Fatalf("results = %d, want 1", len(created.Results))
	}
	first := created.Results[0]
	if first.Status != "accepted" || first.Kind != "deadline" {
		t.Fatalf("status, kind = %q, %q, want accepted, deadline", first.Status, first.Kind)
	}
	if first.Deadline == nil {
		t.Fatal("no deadline came back with an accepted result")
	}
	if first.Deadline.Version != 1 || first.Deadline.Seq != 1 {
		t.Errorf("version, seq = %d, %d, want 1, 1", first.Deadline.Version, first.Deadline.Seq)
	}
	// A date: midnight UTC, and the time component means nothing.
	if got := first.Deadline.DueAt.Format("2006-01-02T15:04:05Z"); got != "2026-10-09T00:00:00Z" {
		t.Errorf("due_at = %q, want 2026-10-09T00:00:00Z", got)
	}

	moved := deadlinePayload(deadlineSyncID(1), 1)
	moved["due_at"] = "2026-10-16T00:00:00Z"
	updated := pushRows(t, api, cookie, map[string]any{"deadlines": []any{moved}})
	if updated.Results[0].Status != "accepted" {
		t.Fatalf("status = %q, want accepted", updated.Results[0].Status)
	}
	if updated.Results[0].Deadline.Version != 2 {
		t.Errorf("version = %d, want 2", updated.Results[0].Deadline.Version)
	}
	if got := updated.Results[0].Deadline.DueAt.Format("2006-01-02"); got != "2026-10-16" {
		t.Errorf("due_at = %q, want the moved date", got)
	}
}

func TestPushRejectsAStaleDeadlineVersionAndReturnsTheServersCopy(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	pushRows(t, api, cookie, map[string]any{
		"deadlines": []any{deadlinePayload(deadlineSyncID(1), 0)},
	})

	stale := deadlinePayload(deadlineSyncID(1), 0)
	stale["title"] = "written against a version the server has moved past"
	got := pushRows(t, api, cookie, map[string]any{"deadlines": []any{stale}})

	result := got.Results[0]
	if result.Status != "conflict" {
		t.Fatalf("status = %q, want conflict", result.Status)
	}
	// The server's copy travels with the conflict, so the client decides
	// without a second request. It resolves this one by taking that copy
	// rather than forking, and that choice is the client's.
	if result.Deadline == nil || result.Deadline.Title != "Písomka z diskrétnej matematiky" {
		t.Errorf("the stored copy did not travel with the conflict: %+v", result.Deadline)
	}
}

func TestPushRefusesAnotherUsersDeadline(t *testing.T) {
	api := newAPI(t)
	owner := signUp(t, api, "jozef", "jozef@example.sk")
	intruder := signUp(t, api, "marta", "marta@example.sk")

	pushRows(t, api, owner, map[string]any{
		"deadlines": []any{deadlinePayload(deadlineSyncID(1), 0)},
	})

	stolen := deadlinePayload(deadlineSyncID(1), 1)
	stolen["title"] = "overwritten"
	got := pushRows(t, api, intruder, map[string]any{"deadlines": []any{stolen}})

	if got.Results[0].Status != "forbidden" {
		t.Fatalf("status = %q, want forbidden", got.Results[0].Status)
	}
	if got.Results[0].Deadline != nil {
		t.Error("a row came back with a forbidden result: a client that guessed an id learns only that it may not write there")
	}
}

// A kind this server has never heard of is a client bug, not a server fault:
// the column deliberately carries no CHECK, so if this validation is missing
// the value is written and nothing ever reports it. 500 would be the answer
// if the constraint lived in the schema instead.
func TestPushRejectsAnUnknownDeadlineKind(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	deadline := deadlinePayload(deadlineSyncID(1), 0)
	deadline["kind"] = "viva"

	rec := call(t, api, http.MethodPost, "/api/v1/sync/push",
		map[string]any{"deadlines": []any{deadline}}, cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), deadlineSyncID(1)) {
		t.Errorf("body %s does not name the deadline", rec.Body)
	}

	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Deadlines) != 0 {
		t.Errorf("deadlines = %d, want 0 after a refused push", len(pulled.Deadlines))
	}
}

func TestPushAcceptsEveryKnownDeadlineKind(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	for i, kind := range []string{"test", "assignment", "other"} {
		deadline := deadlinePayload(deadlineSyncID(i+1), 0)
		deadline["kind"] = kind
		got := pushRows(t, api, cookie, map[string]any{"deadlines": []any{deadline}})
		if got.Results[0].Status != "accepted" {
			t.Fatalf("kind %q: status = %q, want accepted", kind, got.Results[0].Status)
		}
		if got.Results[0].Deadline.Kind != kind {
			t.Errorf("kind = %q, want %q", got.Results[0].Deadline.Kind, kind)
		}
	}
}

// Absent is 'other', never a 400, for the reason an absent notebook kind is
// 'notes': a client that predates a field sends none and must keep syncing.
func TestPushTreatsAnAbsentDeadlineKindAsOther(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	deadline := deadlinePayload(deadlineSyncID(1), 0)
	delete(deadline, "kind")

	got := pushRows(t, api, cookie, map[string]any{"deadlines": []any{deadline}})
	if got.Results[0].Status != "accepted" {
		t.Fatalf("status = %q, want accepted", got.Results[0].Status)
	}
	if got.Results[0].Deadline.Kind != "other" {
		t.Errorf("kind = %q, want other", got.Results[0].Deadline.Kind)
	}
}

// The one that matters. The blob goes out with a key this server has never
// heard of and in an order no encoder would choose, and it must come back
// byte for byte through both the push result and a pull. A handler that
// decoded this column into a value and re-encoded it passes every other test
// in this file and fails here — which is the whole reason the column is text.
func TestPushRoundTripsTopicsByteIdentically(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	const blob = `[{"z":1,"noteId":"0192f0a1-0000-7000-8000-000000000001","heading":"Množiny","unknownToThisServer":{"b":[true,null]}}]`
	deadline := deadlinePayload(deadlineSyncID(1), 0)
	deadline["topics"] = blob

	got := pushRows(t, api, cookie, map[string]any{"deadlines": []any{deadline}})
	if got.Results[0].Status != "accepted" {
		t.Fatalf("status = %q, want accepted", got.Results[0].Status)
	}
	if pushed := text(got.Results[0].Deadline.Topics); pushed != blob {
		t.Fatalf("topics came back from the push as\n\t%s\nwant byte for byte\n\t%s", pushed, blob)
	}

	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Deadlines) != 1 {
		t.Fatalf("pulled %d deadlines, want 1", len(pulled.Deadlines))
	}
	if back := text(pulled.Deadlines[0].Topics); back != blob {
		t.Fatalf("topics came back from the pull as\n\t%s\nwant byte for byte\n\t%s", back, blob)
	}
}

// A 400 and not a 413, matching notebooks.settings: 413 in this API means the
// request is too big, and a single field over its cap is a bad request that
// names the row.
func TestPushRejectsOversizedTopics(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	// Valid JSON, past the cap. The cap exists so one deadline cannot carry
	// a megabyte of anything through a column nothing validates.
	padding := strings.Repeat("x", maxTopics)
	deadline := deadlinePayload(deadlineSyncID(1), 0)
	deadline["topics"] = `[{"pad":"` + padding + `"}]`

	rec := call(t, api, http.MethodPost, "/api/v1/sync/push",
		map[string]any{"deadlines": []any{deadline}}, cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), deadlineSyncID(1)) {
		t.Errorf("body %s does not name the deadline", rec.Body)
	}

	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Deadlines) != 0 {
		t.Errorf("deadlines = %d, want 0 after a refused push", len(pulled.Deadlines))
	}
}

func TestPushRejectsMalformedDeadlines(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	cases := map[string]map[string]any{
		"id that is not a UUID": corrupt(deadlinePayload(deadlineSyncID(1), 0), "id", "nope"),
		"class_id that is not a UUID": corrupt(
			deadlinePayload(deadlineSyncID(1), 0), "class_id", "nope"),
		"due_at that is not RFC 3339": corrupt(
			deadlinePayload(deadlineSyncID(1), 0), "due_at", "next Friday"),
		"due_at that is absent": func() map[string]any {
			row := deadlinePayload(deadlineSyncID(1), 0)
			delete(row, "due_at")
			return row
		}(),
		"done_at that is not RFC 3339": corrupt(
			deadlinePayload(deadlineSyncID(1), 0), "done_at", "yesterday"),
		"topics that are not JSON": corrupt(
			deadlinePayload(deadlineSyncID(1), 0), "topics", "[{heading:"),
		"a negative version": corrupt(deadlinePayload(deadlineSyncID(1), 0), "version", -1),
		"a title over the cap": corrupt(
			deadlinePayload(deadlineSyncID(1), 0), "title", strings.Repeat("x", maxName+1)),
	}

	for name, deadline := range cases {
		t.Run(name, func(t *testing.T) {
			rec := call(t, api, http.MethodPost, "/api/v1/sync/push",
				map[string]any{"deadlines": []any{deadline}}, cookie)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body)
			}
		})
	}
}

// Deadlines apply last, after the notes their topics point at. Four rows in
// one request take four consecutive seqs from the one counter, and the pull
// returns them as one stream cut up by type.
func TestPullReturnsDeadlinesInTheSharedSeqOrder(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	pushRows(t, api, cookie, map[string]any{
		"classes":   []any{classPayload(classSyncID(1), 0)},
		"notebooks": []any{notebookPayload(notebookSyncID(1), classSyncID(1), 0)},
		"notes":     []any{filedNotePayload(syncID(1), notebookSyncID(1), 0)},
		"deadlines": []any{deadlinePayload(deadlineSyncID(1), 0)},
	})

	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Classes) != 1 || len(pulled.Notebooks) != 1 ||
		len(pulled.Notes) != 1 || len(pulled.Deadlines) != 1 {
		t.Fatalf("pulled %d classes, %d notebooks, %d notes, %d deadlines, want one of each",
			len(pulled.Classes), len(pulled.Notebooks), len(pulled.Notes), len(pulled.Deadlines))
	}
	if !equalSeqs(seqsOf(pulled), []int64{1, 2, 3, 4}) {
		t.Errorf("seqs = %v, want 1, 2, 3, 4 from one shared counter", seqsOf(pulled))
	}
	// A deadline's topics reference notes, so the note has to land first.
	if pulled.Notes[0].Seq >= pulled.Deadlines[0].Seq {
		t.Errorf("note seq %d is not below deadline seq %d: deadlines must apply last",
			pulled.Notes[0].Seq, pulled.Deadlines[0].Seq)
	}
	if pulled.Cursor != 4 || pulled.HasMore {
		t.Errorf("cursor, has_more = %d, %v, want 4, false", pulled.Cursor, pulled.HasMore)
	}
}

// A cursor inside the stream resumes across all four tables. Twelve rows are
// written interleaved, so no table's rows are adjacent: classes hold 1, 5, 9,
// notebooks 2, 6, 10, notes 3, 7, 11 and deadlines 4, 8, 12. A pull that
// forgot deadlines, or that paged per type, returns a different set here
// rather than passing by luck.
func TestPullFromAMidBatchCursorResumesAcrossFourTypes(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	for i := 1; i <= 3; i++ {
		pushRows(t, api, cookie, map[string]any{
			"classes":   []any{classPayload(classSyncID(i), 0)},
			"notebooks": []any{notebookPayload(notebookSyncID(i), classSyncID(i), 0)},
			"notes":     []any{filedNotePayload(syncID(i), notebookSyncID(i), 0)},
			"deadlines": []any{deadlinePayload(deadlineSyncID(i), 0)},
		})
	}

	pulled := pullNotes(t, api, cookie, "?since=5")
	if !equalSeqs(seqsOf(pulled), []int64{6, 7, 8, 9, 10, 11, 12}) {
		t.Errorf("seqs = %v, want 6 through 12", seqsOf(pulled))
	}
	if len(pulled.Deadlines) != 2 {
		t.Errorf("deadlines = %d, want the two above seq 5", len(pulled.Deadlines))
	}
}

func TestPushRejectsAnOversizedArrayOfDeadlines(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	rows := make([]any, 0, maxPushRows+1)
	for i := 1; i <= maxPushRows+1; i++ {
		rows = append(rows, deadlinePayload(deadlineSyncID(i), 0))
	}

	rec := call(t, api, http.MethodPost, "/api/v1/sync/push",
		map[string]any{"deadlines": rows}, cookie)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusRequestEntityTooLarge, rec.Body)
	}

	// Refused before the first upsert, so nothing of any kind landed.
	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Deadlines) != 0 {
		t.Errorf("deadlines were written despite the 413: %+v", pulled.Deadlines)
	}
}

// One transaction per row. A conflict on a deadline must not roll back the
// note pushed alongside it, which is what a single transaction for the batch
// would do.
func TestPushConflictOnADeadlineDoesNotBlockItsNeighbours(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	pushRows(t, api, cookie, map[string]any{
		"deadlines": []any{deadlinePayload(deadlineSyncID(1), 0)},
	})

	got := pushRows(t, api, cookie, map[string]any{
		"notes":     []any{notePayload(syncID(1), 0)},
		"deadlines": []any{deadlinePayload(deadlineSyncID(1), 0)},
	})

	statuses := map[string]string{}
	for _, result := range got.Results {
		statuses[result.Kind] = result.Status
	}
	if statuses["note"] != "accepted" {
		t.Errorf("note status = %q, want accepted alongside a conflicting deadline", statuses["note"])
	}
	if statuses["deadline"] != "conflict" {
		t.Errorf("deadline status = %q, want conflict", statuses["deadline"])
	}
}

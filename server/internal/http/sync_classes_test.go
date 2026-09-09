package http

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"testing"
)

func classSyncID(n int) string {
	return fmt.Sprintf("0192f0b1-0000-7000-8000-%012d", n)
}

func notebookSyncID(n int) string {
	return fmt.Sprintf("0192f0c1-0000-7000-8000-%012d", n)
}

// Every field, because the decoder rejects unknown ones and a client that
// omits one is sending a different row than it thinks.
func classPayload(id string, version int64) map[string]any {
	return map[string]any{
		"id":          id,
		"name":        "Diskrétna matematika",
		"code":        "1-AIN-101",
		"colour":      "#3355ff",
		"semester":    "2026Z",
		"archived_at": nil,
		"version":     version,
		"deleted_at":  nil,
	}
}

func notebookPayload(id, classID string, version int64) map[string]any {
	return map[string]any{
		"id":         id,
		"class_id":   classID,
		"name":       "Prednášky",
		"is_general": true,
		"version":    version,
		"deleted_at": nil,
	}
}

func filedNotePayload(id, notebookID string, version int64) map[string]any {
	note := notePayload(id, version)
	note["notebook_id"] = notebookID
	return note
}

// The three arrays in one request, which is the shape everything below tests.
func pushRows(t *testing.T, api http.Handler, cookie *http.Cookie, body map[string]any) pushResponse {
	t.Helper()

	rec := call(t, api, http.MethodPost, "/api/v1/sync/push", body, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("push status = %d, want %d (body %s)", rec.Code, http.StatusOK, rec.Body)
	}

	var decoded pushResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decoding push body: %v", err)
	}

	return decoded
}

// A class, its general notebook and a note in that notebook, pushed together
// the way one gesture on the client produces them.
func TestPushAppliesClassesThenNotebooksThenNotes(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	got := pushRows(t, api, cookie, map[string]any{
		"classes":   []any{classPayload(classSyncID(1), 0)},
		"notebooks": []any{notebookPayload(notebookSyncID(1), classSyncID(1), 0)},
		"notes":     []any{filedNotePayload(syncID(1), notebookSyncID(1), 0)},
	})

	if len(got.Results) != 3 {
		t.Fatalf("results = %d, want 3", len(got.Results))
	}

	wantKinds := []string{"class", "notebook", "note"}
	for i, result := range got.Results {
		if result.Kind != wantKinds[i] {
			t.Errorf("results[%d].kind = %q, want %q", i, result.Kind, wantKinds[i])
		}
		if result.Status != "accepted" {
			t.Errorf("results[%d].status = %q, want accepted", i, result.Status)
		}
	}

	// The apply order is the seq order, so the class is on the wire before
	// the notebook that names it and the notebook before the note.
	if got.Results[0].Class == nil || got.Results[1].Notebook == nil || got.Results[2].Note == nil {
		t.Fatalf("a result came back without its row: %+v", got.Results)
	}
	if got.Results[0].Class.Seq != 1 || got.Results[1].Notebook.Seq != 2 || got.Results[2].Note.Seq != 3 {
		t.Errorf("seqs = %d, %d, %d, want 1, 2, 3 in dependency order",
			got.Results[0].Class.Seq, got.Results[1].Notebook.Seq, got.Results[2].Note.Seq)
	}
	if got.Results[1].Notebook.ClassID == nil || *got.Results[1].Notebook.ClassID != classSyncID(1) {
		t.Errorf("notebook.class_id = %v, want the class it was pushed with", got.Results[1].Notebook.ClassID)
	}
	if got.Results[2].Note.NotebookID == nil || *got.Results[2].Note.NotebookID != notebookSyncID(1) {
		t.Errorf("note.notebook_id = %v, want the notebook it was pushed with", got.Results[2].Note.NotebookID)
	}
}

// One transaction per row. A conflict in the middle array must not roll back
// what the arrays on either side wrote.
func TestPushConflictOnANotebookDoesNotBlockItsNeighbours(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	// The notebook already exists at version 1, so the batch below sends it
	// stale while the class and the note beside it are new.
	pushRows(t, api, cookie, map[string]any{
		"notebooks": []any{notebookPayload(notebookSyncID(1), classSyncID(1), 0)},
	})

	got := pushRows(t, api, cookie, map[string]any{
		"classes":   []any{classPayload(classSyncID(1), 0)},
		"notebooks": []any{notebookPayload(notebookSyncID(1), classSyncID(1), 0)},
		"notes":     []any{filedNotePayload(syncID(1), notebookSyncID(1), 0)},
	})

	want := []string{"accepted", "conflict", "accepted"}
	for i, result := range got.Results {
		if result.Status != want[i] {
			t.Errorf("results[%d] (%s) status = %q, want %q", i, result.Kind, result.Status, want[i])
		}
	}
	if got.Results[1].Notebook == nil {
		t.Fatal("no server copy travelled with the notebook conflict")
	}
	if got.Results[1].Notebook.Version != 1 {
		t.Errorf("server copy version = %d, want 1", got.Results[1].Notebook.Version)
	}

	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Classes) != 1 || len(pulled.Notebooks) != 1 || len(pulled.Notes) != 1 {
		t.Errorf("stored %d classes, %d notebooks, %d notes, want 1, 1, 1",
			len(pulled.Classes), len(pulled.Notebooks), len(pulled.Notes))
	}
}

func TestPushRejectsAnOversizedArrayOfEveryKind(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	oversized := func(build func(int) map[string]any) []any {
		rows := make([]any, 0, maxPushRows+1)
		for i := 1; i <= maxPushRows+1; i++ {
			rows = append(rows, build(i))
		}
		return rows
	}

	cases := map[string]map[string]any{
		"classes": {"classes": oversized(func(i int) map[string]any {
			return classPayload(classSyncID(i), 0)
		})},
		"notebooks": {"notebooks": oversized(func(i int) map[string]any {
			return notebookPayload(notebookSyncID(i), classSyncID(1), 0)
		})},
		"notes": {"notes": oversized(func(i int) map[string]any {
			return notePayload(syncID(i), 0)
		})},
	}

	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			rec := call(t, api, http.MethodPost, "/api/v1/sync/push", body, cookie)
			if rec.Code != http.StatusRequestEntityTooLarge {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, http.StatusRequestEntityTooLarge, rec.Body)
			}
			// Refused before the first upsert, so nothing of any kind landed.
			pulled := pullNotes(t, api, cookie, "?since=0")
			if len(pulled.Classes)+len(pulled.Notebooks)+len(pulled.Notes) != 0 {
				t.Errorf("rows were written despite the 413: %+v", pulled)
			}
		})
	}
}

func TestPullReturnsEveryTypeInSharedSeqOrder(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	pushRows(t, api, cookie, map[string]any{
		"classes":   []any{classPayload(classSyncID(1), 0)},
		"notebooks": []any{notebookPayload(notebookSyncID(1), classSyncID(1), 0)},
		"notes":     []any{filedNotePayload(syncID(1), notebookSyncID(1), 0)},
	})

	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Classes) != 1 || len(pulled.Notebooks) != 1 || len(pulled.Notes) != 1 {
		t.Fatalf("pulled %d classes, %d notebooks, %d notes, want one of each",
			len(pulled.Classes), len(pulled.Notebooks), len(pulled.Notes))
	}
	if pulled.Classes[0].Seq != 1 || pulled.Notebooks[0].Seq != 2 || pulled.Notes[0].Seq != 3 {
		t.Errorf("seqs = %d, %d, %d, want 1, 2, 3 from one shared counter",
			pulled.Classes[0].Seq, pulled.Notebooks[0].Seq, pulled.Notes[0].Seq)
	}
	// The cursor is the highest seq in the page whatever table it came from.
	if pulled.Cursor != 3 || pulled.HasMore {
		t.Errorf("cursor, has_more = %d, %v, want 3, false", pulled.Cursor, pulled.HasMore)
	}
	if pulled.Classes[0].ArchivedAt != nil {
		t.Errorf("archived_at = %v, want nil", pulled.Classes[0].ArchivedAt)
	}
	if !pulled.Notebooks[0].IsGeneral {
		t.Error("is_general = false, want it carried back")
	}
}

// The one that matters. Nine rows are written in an interleaved order, so
// within every table the seqs are non-contiguous and no table's rows are
// adjacent in the stream: classes hold 1, 4, 7, notebooks 2, 5, 8 and notes
// 3, 6, 9. A cursor at 4 must return 5 to 9 across all three tables. A pull
// that paged per type, or that took the cursor from one table, returns a
// different set here rather than passing by luck.
func TestPullFromAMidBatchCursorResumesAcrossTypes(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	for i := 1; i <= 3; i++ {
		pushRows(t, api, cookie, map[string]any{
			"classes":   []any{classPayload(classSyncID(i), 0)},
			"notebooks": []any{notebookPayload(notebookSyncID(i), classSyncID(i), 0)},
			"notes":     []any{filedNotePayload(syncID(i), notebookSyncID(i), 0)},
		})
	}

	all := pullNotes(t, api, cookie, "?since=0")
	if len(all.Classes) != 3 || len(all.Notebooks) != 3 || len(all.Notes) != 3 {
		t.Fatalf("pulled %d/%d/%d, want 3 of each", len(all.Classes), len(all.Notebooks), len(all.Notes))
	}
	if all.Cursor != 9 {
		t.Fatalf("cursor = %d, want 9", all.Cursor)
	}

	// Seq 4 is the second class. What follows it is the second notebook (5),
	// the second note (6), and the whole third round (7, 8, 9).
	rest := pullNotes(t, api, cookie, "?since=4")

	if got := seqsOf(rest); !equalSeqs(got, []int64{5, 6, 7, 8, 9}) {
		t.Errorf("from cursor 4 got seqs %v, want [5 6 7 8 9]", got)
	}
	if len(rest.Classes) != 1 || len(rest.Notebooks) != 2 || len(rest.Notes) != 2 {
		t.Errorf("from cursor 4 got %d classes, %d notebooks, %d notes, want 1, 2, 2",
			len(rest.Classes), len(rest.Notebooks), len(rest.Notes))
	}
	if rest.Classes[0].Seq != 7 {
		t.Errorf("the only class after cursor 4 has seq %d, want 7", rest.Classes[0].Seq)
	}
	if rest.Cursor != 9 || rest.HasMore {
		t.Errorf("cursor, has_more = %d, %v, want 9, false", rest.Cursor, rest.HasMore)
	}

	// The same cursor with a page that has to truncate. Three rows from three
	// different tables, and the cursor is the highest seq that survived the
	// cut rather than the highest seq any one table held. An implementation
	// that pages each type separately returns 5 to 9 here, and one that takes
	// the cursor from the notes it read last reports 9.
	limited := pullNotes(t, api, cookie, "?since=4&limit=3")
	if got := seqsOf(limited); !equalSeqs(got, []int64{5, 6, 7}) {
		t.Errorf("from cursor 4 with limit 3 got seqs %v, want [5 6 7]", got)
	}
	if limited.Cursor != 7 || !limited.HasMore {
		t.Errorf("cursor, has_more = %d, %v, want 7, true", limited.Cursor, limited.HasMore)
	}
	if len(limited.Classes) != 1 || len(limited.Notebooks) != 1 || len(limited.Notes) != 1 {
		t.Errorf("truncated page = %d classes, %d notebooks, %d notes, want one of each",
			len(limited.Classes), len(limited.Notebooks), len(limited.Notes))
	}
}

// A page smaller than the stream, resumed with no gap and no repeat. The
// limit is 4, so the first page ends inside the second round and the second
// page has to start with the notebook that follows, not with a whole table.
func TestPullPagesAcrossTypesWithoutGapOrRepeat(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	for i := 1; i <= 3; i++ {
		pushRows(t, api, cookie, map[string]any{
			"classes":   []any{classPayload(classSyncID(i), 0)},
			"notebooks": []any{notebookPayload(notebookSyncID(i), classSyncID(i), 0)},
			"notes":     []any{filedNotePayload(syncID(i), notebookSyncID(i), 0)},
		})
	}

	var seen []int64
	cursor := int64(0)
	for page := 1; ; page++ {
		got := pullNotes(t, api, cookie, fmt.Sprintf("?since=%d&limit=4", cursor))
		seqs := seqsOf(got)
		if page == 1 {
			// A page can stop mid-round: four rows is the first class,
			// notebook and note plus the second class.
			if !equalSeqs(seqs, []int64{1, 2, 3, 4}) {
				t.Errorf("page 1 seqs = %v, want [1 2 3 4]", seqs)
			}
			if got.Cursor != 4 || !got.HasMore {
				t.Errorf("page 1 cursor, has_more = %d, %v, want 4, true", got.Cursor, got.HasMore)
			}
		}
		seen = append(seen, seqs...)
		cursor = got.Cursor
		if !got.HasMore {
			break
		}
		if page > 5 {
			t.Fatalf("paging did not terminate; seen %v", seen)
		}
	}

	if !equalSeqs(seen, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9}) {
		t.Errorf("paged seqs = %v, want each of 1 to 9 exactly once", seen)
	}
}

// A page may be entirely one type. Six notebooks are written above a cursor
// that already covers everything else, and a limit of 3 must return three
// notebooks rather than reserving room for the tables with nothing to say.
func TestAPageMayBeEntirelyOneType(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	pushRows(t, api, cookie, map[string]any{
		"classes": []any{classPayload(classSyncID(1), 0)},
	})
	for i := 1; i <= 6; i++ {
		pushRows(t, api, cookie, map[string]any{
			"notebooks": []any{notebookPayload(notebookSyncID(i), classSyncID(1), 0)},
		})
	}

	page := pullNotes(t, api, cookie, "?since=1&limit=3")
	if len(page.Notebooks) != 3 || len(page.Classes) != 0 || len(page.Notes) != 0 {
		t.Errorf("page = %d classes, %d notebooks, %d notes, want 0, 3, 0",
			len(page.Classes), len(page.Notebooks), len(page.Notes))
	}
	if page.Cursor != 4 || !page.HasMore {
		t.Errorf("cursor, has_more = %d, %v, want 4, true", page.Cursor, page.HasMore)
	}
}

func TestPullReturnsOnlyTheCallersRowsOfEveryType(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")
	other := signUp(t, api, "marta", "marta@example.sk")

	pushRows(t, api, cookie, map[string]any{
		"classes":   []any{classPayload(classSyncID(1), 0)},
		"notebooks": []any{notebookPayload(notebookSyncID(1), classSyncID(1), 0)},
		"notes":     []any{filedNotePayload(syncID(1), notebookSyncID(1), 0)},
	})
	pushRows(t, api, other, map[string]any{
		"classes":   []any{classPayload(classSyncID(99), 0)},
		"notebooks": []any{notebookPayload(notebookSyncID(99), classSyncID(99), 0)},
		"notes":     []any{filedNotePayload(syncID(99), notebookSyncID(99), 0)},
	})

	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Classes) != 1 || len(pulled.Notebooks) != 1 || len(pulled.Notes) != 1 {
		t.Fatalf("pulled %d/%d/%d, want one of each: another user's rows must never appear",
			len(pulled.Classes), len(pulled.Notebooks), len(pulled.Notes))
	}
	if pulled.Classes[0].ID != classSyncID(1) || pulled.Notebooks[0].ID != notebookSyncID(1) || pulled.Notes[0].ID != syncID(1) {
		t.Errorf("another user's rows came back: %+v", pulled)
	}
}

func TestPushRejectsMalformedClassesAndNotebooks(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	cases := []struct {
		name string
		body map[string]any
	}{
		{"class id that is not a UUID", map[string]any{"classes": []any{
			corrupt(classPayload(classSyncID(1), 0), "id", "not-a-uuid")}}},
		{"class archived_at not RFC3339", map[string]any{"classes": []any{
			corrupt(classPayload(classSyncID(1), 0), "archived_at", "last term")}}},
		{"class negative version", map[string]any{"classes": []any{
			corrupt(classPayload(classSyncID(1), 0), "version", -1)}}},
		{"notebook id that is not a UUID", map[string]any{"notebooks": []any{
			corrupt(notebookPayload(notebookSyncID(1), classSyncID(1), 0), "id", "nope")}}},
		{"notebook class_id that is not a UUID", map[string]any{"notebooks": []any{
			corrupt(notebookPayload(notebookSyncID(1), classSyncID(1), 0), "class_id", "nope")}}},
		{"note notebook_id that is not a UUID", map[string]any{"notes": []any{
			corrupt(filedNotePayload(syncID(1), notebookSyncID(1), 0), "notebook_id", "nope")}}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := call(t, api, http.MethodPost, "/api/v1/sync/push", tc.body, cookie)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body)
			}
		})
	}
}

func corrupt(row map[string]any, field string, value any) map[string]any {
	row[field] = value
	return row
}

// Every seq in a pull, in the order the three arrays would be replayed as
// one stream.
func seqsOf(page pullResponse) []int64 {
	seqs := make([]int64, 0,
		len(page.Classes)+len(page.Notebooks)+len(page.Notes))
	for _, class := range page.Classes {
		seqs = append(seqs, class.Seq)
	}
	for _, notebook := range page.Notebooks {
		seqs = append(seqs, notebook.Seq)
	}
	for _, note := range page.Notes {
		seqs = append(seqs, note.Seq)
	}
	slices.Sort(seqs)

	return seqs
}

func equalSeqs(got, want []int64) bool {
	return slices.Equal(got, want)
}

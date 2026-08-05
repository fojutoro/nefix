package http

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func syncID(n int) string {
	return fmt.Sprintf("0192f0a1-0000-7000-8000-%012d", n)
}

func signUp(t *testing.T, api http.Handler, username, email string) *http.Cookie {
	t.Helper()

	rec := call(t, api, http.MethodPost, "/api/v1/register", registerBody(username, email))
	if rec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, want %d (body %s)", rec.Code, http.StatusCreated, rec.Body)
	}

	return sessionCookie(t, rec)
}

// Every field, because the decoder rejects unknown ones and a client that
// omits one is sending a different note than it thinks.
func notePayload(id string, version int64) map[string]any {
	return map[string]any{
		"id":             id,
		"class_id":       nil,
		"title":          "Diskrétna matematika",
		"body_md":        "# Množiny",
		"visibility":     "private",
		"forked_from_id": nil,
		"version":        version,
		"deleted_at":     nil,
	}
}

func pushNotes(t *testing.T, api http.Handler, cookie *http.Cookie, notes ...map[string]any) pushResponse {
	t.Helper()

	rec := call(t, api, http.MethodPost, "/api/v1/sync/push", map[string]any{"notes": notes}, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("push status = %d, want %d (body %s)", rec.Code, http.StatusOK, rec.Body)
	}

	var body pushResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding push body: %v", err)
	}

	return body
}

func pullNotes(t *testing.T, api http.Handler, cookie *http.Cookie, query string) pullResponse {
	t.Helper()

	rec := call(t, api, http.MethodGet, "/api/v1/sync/pull"+query, nil, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("pull status = %d, want %d (body %s)", rec.Code, http.StatusOK, rec.Body)
	}

	var body pullResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding pull body: %v", err)
	}

	return body
}

func TestPushAcceptsANewNoteThenAnUpdate(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	created := pushNotes(t, api, cookie, notePayload(syncID(1), 0))
	if len(created.Results) != 1 {
		t.Fatalf("results = %d, want 1", len(created.Results))
	}
	first := created.Results[0]
	if first.Status != "accepted" {
		t.Fatalf("status = %q, want accepted", first.Status)
	}
	if first.Note.Version != 1 || first.Note.Seq != 1 {
		t.Errorf("version, seq = %d, %d, want 1, 1", first.Note.Version, first.Note.Seq)
	}

	updated := pushNotes(t, api, cookie, notePayload(syncID(1), 1))
	second := updated.Results[0]
	if second.Status != "accepted" {
		t.Fatalf("status = %q, want accepted", second.Status)
	}
	if second.Note.Version != 2 || second.Note.Seq != 2 {
		t.Errorf("version, seq = %d, %d, want 2, 2", second.Note.Version, second.Note.Seq)
	}
}

func TestPushRejectsAStaleVersionAndReturnsTheServersCopy(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	pushNotes(t, api, cookie, notePayload(syncID(1), 0))

	stale := notePayload(syncID(1), 0)
	stale["title"] = "written against a version the server has moved past"

	got := pushNotes(t, api, cookie, stale)
	result := got.Results[0]
	if result.Status != "conflict" {
		t.Fatalf("status = %q, want conflict", result.Status)
	}
	if result.Note == nil {
		t.Fatal("no server copy travelled with the conflict")
	}
	if result.Note.Title != "Diskrétna matematika" || result.Note.Version != 1 {
		t.Errorf("server copy = %+v, want the stored note at version 1", result.Note)
	}
}

func TestPushRefusesAnotherUsersNote(t *testing.T) {
	api := newAPI(t)
	owner := signUp(t, api, "jozef", "jozef@example.sk")
	intruder := signUp(t, api, "marta", "marta@example.sk")

	pushNotes(t, api, owner, notePayload(syncID(1), 0))

	stolen := notePayload(syncID(1), 1)
	stolen["title"] = "overwritten"

	got := pushNotes(t, api, intruder, stolen)
	if got.Results[0].Status != "forbidden" {
		t.Fatalf("status = %q, want forbidden", got.Results[0].Status)
	}
	if got.Results[0].Note != nil {
		t.Error("the note came back: a client that guessed an id learns only that it may not write there")
	}

	// The owner still has what the owner wrote.
	pulled := pullNotes(t, api, owner, "?since=0")
	if len(pulled.Notes) != 1 || pulled.Notes[0].Title != "Diskrétna matematika" || pulled.Notes[0].Version != 1 {
		t.Errorf("stored note changed: %+v", pulled.Notes)
	}
}

func TestPushProcessesEachNoteIndependently(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	// Note 2 exists at version 1 already, so the batch below sends it stale.
	pushNotes(t, api, cookie, notePayload(syncID(2), 0))

	got := pushNotes(t, api, cookie,
		notePayload(syncID(1), 0),
		notePayload(syncID(2), 0),
		notePayload(syncID(3), 0),
	)
	if len(got.Results) != 3 {
		t.Fatalf("results = %d, want 3", len(got.Results))
	}

	want := []string{"accepted", "conflict", "accepted"}
	for i, result := range got.Results {
		if result.Status != want[i] {
			t.Errorf("results[%d].status = %q, want %q", i, result.Status, want[i])
		}
		if result.ID != syncID(i+1) {
			t.Errorf("results[%d].id = %q, want %q", i, result.ID, syncID(i+1))
		}
	}

	// A conflict in the middle rolled back neither neighbour.
	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Notes) != 3 {
		t.Errorf("stored notes = %d, want 3", len(pulled.Notes))
	}
}

func TestPullPagesFromACursor(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	for i := 1; i <= 5; i++ {
		pushNotes(t, api, cookie, notePayload(syncID(i), 0))
	}

	all := pullNotes(t, api, cookie, "?since=0")
	if len(all.Notes) != 5 {
		t.Fatalf("notes = %d, want 5", len(all.Notes))
	}
	for i, note := range all.Notes {
		if note.Seq != int64(i+1) {
			t.Errorf("notes[%d].seq = %d, want %d", i, note.Seq, i+1)
		}
	}
	if all.Cursor != 5 || all.HasMore {
		t.Errorf("cursor, has_more = %d, %v, want 5, false", all.Cursor, all.HasMore)
	}

	rest := pullNotes(t, api, cookie, "?since=3")
	if len(rest.Notes) != 2 || rest.Notes[0].Seq != 4 {
		t.Errorf("from seq 3 got %+v, want the notes at 4 and 5", rest.Notes)
	}

	page := pullNotes(t, api, cookie, "?since=0&limit=2")
	if len(page.Notes) != 2 {
		t.Fatalf("page = %d notes, want 2", len(page.Notes))
	}
	if page.Cursor != 2 || !page.HasMore {
		t.Errorf("cursor, has_more = %d, %v, want 2, true", page.Cursor, page.HasMore)
	}

	last := pullNotes(t, api, cookie, "?since=4&limit=2")
	if len(last.Notes) != 1 || last.HasMore {
		t.Errorf("last page = %+v, has_more = %v, want one note and false", last.Notes, last.HasMore)
	}

	empty := pullNotes(t, api, cookie, "?since=5")
	if len(empty.Notes) != 0 || empty.HasMore {
		t.Errorf("empty page = %+v, has_more = %v", empty.Notes, empty.HasMore)
	}
	// Nothing new must not rewind the client to the beginning of history.
	if empty.Cursor != 5 {
		t.Errorf("cursor = %d, want the 5 it was given", empty.Cursor)
	}
}

// The reason the cursor is a sequence and not a timestamp. The timestamp
// columns hold whole seconds, so two notes written in the same second are
// indistinguishable by time: a timestamp cursor landing between them would
// have to either return both or skip one for ever. A sequence cannot.
func TestNotesWrittenInOneSecondStillPageOneAtATime(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	var first, second noteResponse
	for attempt := 1; ; attempt++ {
		got := pushNotes(t, api, cookie,
			notePayload(syncID(attempt*2-1), 0),
			notePayload(syncID(attempt*2), 0),
		)
		first, second = *got.Results[0].Note, *got.Results[1].Note
		if first.UpdatedAt.Equal(second.UpdatedAt) {
			break
		}
		if attempt == 5 {
			t.Fatalf("no two writes landed in the same stored second after %d attempts", attempt)
		}
	}

	if first.Seq == second.Seq {
		t.Fatalf("both notes got seq %d", first.Seq)
	}
	// Consecutive, because nothing else was written between them. This is the
	// assertion the loop above cannot make true by itself: it says the two
	// notes are one cursor step apart, which is what lets the pull below
	// separate them when their timestamps cannot.
	if second.Seq != first.Seq+1 {
		t.Errorf("seq %d and %d are not consecutive, although the two notes were written back to back",
			first.Seq, second.Seq)
	}

	page := pullNotes(t, api, cookie, fmt.Sprintf("?since=%d", first.Seq))
	if len(page.Notes) != 1 || page.Notes[0].ID != second.ID {
		t.Fatalf("a cursor between two same-second notes returned %d notes, want exactly the later one", len(page.Notes))
	}
}

func TestPullCarriesADeleteAndOnlyTheCallersNotes(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")
	other := signUp(t, api, "marta", "marta@example.sk")

	pushNotes(t, api, cookie, notePayload(syncID(1), 0))
	pushNotes(t, api, other, notePayload(syncID(99), 0))

	deletedAt := time.Date(2026, 8, 5, 9, 30, 0, 0, time.UTC)
	removed := notePayload(syncID(1), 1)
	removed["deleted_at"] = deletedAt.Format(time.RFC3339)
	pushNotes(t, api, cookie, removed)

	pulled := pullNotes(t, api, cookie, "?since=0")
	if len(pulled.Notes) != 1 {
		t.Fatalf("notes = %d, want 1: another user's notes must never appear", len(pulled.Notes))
	}
	if pulled.Notes[0].DeletedAt == nil || !pulled.Notes[0].DeletedAt.Equal(deletedAt) {
		t.Errorf("deleted_at = %v, want %v", pulled.Notes[0].DeletedAt, deletedAt)
	}
}

func TestPushRejectsMalformedNotes(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	cases := map[string]func(map[string]any){
		"id that is not a UUID":  func(n map[string]any) { n["id"] = "not-a-uuid" },
		"unknown visibility":     func(n map[string]any) { n["visibility"] = "everyone" },
		"deleted_at not RFC3339": func(n map[string]any) { n["deleted_at"] = "yesterday" },
		"negative version":       func(n map[string]any) { n["version"] = -1 },
	}

	for name, corrupt := range cases {
		t.Run(name, func(t *testing.T) {
			note := notePayload(syncID(1), 0)
			corrupt(note)

			rec := call(t, api, http.MethodPost, "/api/v1/sync/push", map[string]any{"notes": []any{note}}, cookie)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body)
			}
		})
	}
}

func TestPushRejectsAnOversizedBatch(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	notes := make([]map[string]any, 0, maxPushNotes+1)
	for i := 1; i <= maxPushNotes+1; i++ {
		notes = append(notes, notePayload(syncID(i), 0))
	}

	rec := call(t, api, http.MethodPost, "/api/v1/sync/push", map[string]any{"notes": notes}, cookie)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}

	// Nothing was written: the batch is refused before the first upsert.
	if pulled := pullNotes(t, api, cookie, "?since=0"); len(pulled.Notes) != 0 {
		t.Errorf("stored notes = %d, want 0", len(pulled.Notes))
	}
}

func TestPushRejectsAnOversizedBody(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	// One note, under the batch count, over the byte ceiling.
	note := notePayload(syncID(1), 0)
	note["body_md"] = strings.Repeat("m", maxPushBytes+1)

	rec := call(t, api, http.MethodPost, "/api/v1/sync/push", map[string]any{"notes": []any{note}}, cookie)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d (body %s)", rec.Code, http.StatusRequestEntityTooLarge, rec.Body)
	}
}

func TestPullRejectsANonNumericCursor(t *testing.T) {
	api := newAPI(t)
	cookie := signUp(t, api, "jozef", "jozef@example.sk")

	rec := call(t, api, http.MethodGet, "/api/v1/sync/pull?since=abc", nil, cookie)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body)
	}
}

func TestSyncRequiresASession(t *testing.T) {
	api := newAPI(t)

	push := call(t, api, http.MethodPost, "/api/v1/sync/push", map[string]any{"notes": []any{}})
	if push.Code != http.StatusUnauthorized {
		t.Errorf("push status = %d, want %d", push.Code, http.StatusUnauthorized)
	}

	pull := call(t, api, http.MethodGet, "/api/v1/sync/pull?since=0", nil)
	if pull.Code != http.StatusUnauthorized {
		t.Errorf("pull status = %d, want %d", pull.Code, http.StatusUnauthorized)
	}
}

// Walked from the same list New registers from, so every route in that list
// is covered. It does not prove more than that: a route registered by calling
// api.Handle directly, outside apiRoutes, is invisible here and this test
// stays green. What keeps the header on such a route is noStore matching the
// /api/ path prefix rather than the route table, which
// TestUnroutedAPIPathStillForbidsCaching covers.
func TestEveryAPIRouteForbidsCaching(t *testing.T) {
	srv, db := newServer(t)
	api := New("v0.1.0", "abc1234", db, CookieConfig{})

	for _, route := range srv.apiRoutes() {
		t.Run(route.Method+" "+route.Pattern, func(t *testing.T) {
			// The status does not matter. A 401 or a 400 must carry the
			// header as surely as a 200 does.
			rec := call(t, api, route.Method, route.Pattern, nil)

			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control = %q, want %q", got, "no-store")
			}
			if got := rec.Header().Get("Vary"); got != "Cookie" {
				t.Errorf("Vary = %q, want %q", got, "Cookie")
			}
		})
	}
}

func TestUnroutedAPIPathStillForbidsCaching(t *testing.T) {
	api := newAPI(t)

	rec := call(t, api, http.MethodGet, "/api/v1/nothing_here", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want %q", got, "no-store")
	}
}

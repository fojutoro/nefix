package http

import (
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/fojutoro/nefix/server/internal/store"
)

const (
	maxPushBytes     = 1 << 20
	maxPushNotes     = 100
	defaultPullLimit = 100
	maxPullLimit     = 500
	maxNoteTitle     = 200
)

var visibilities = []string{"private", "faculty", "public"}

// What a client may send. The server owns seq, version arithmetic and the
// timestamps, so none of them are fields here except the version the client
// last saw, which is the whole point of the exchange.
type pushNote struct {
	ID           string  `json:"id"`
	ClassID      *int64  `json:"class_id"`
	Title        string  `json:"title"`
	BodyMd       string  `json:"body_md"`
	Visibility   string  `json:"visibility"`
	ForkedFromID *string `json:"forked_from_id"`
	Version      int64   `json:"version"`
	DeletedAt    *string `json:"deleted_at"`
}

type pushRequest struct {
	Notes []pushNote `json:"notes"`
}

type pushResult struct {
	ID     string        `json:"id"`
	Status string        `json:"status"`
	Note   *noteResponse `json:"note,omitempty"`
}

type pushResponse struct {
	Results []pushResult `json:"results"`
}

type noteResponse struct {
	ID           string     `json:"id"`
	ClassID      *int64     `json:"class_id"`
	Title        string     `json:"title"`
	BodyMd       string     `json:"body_md"`
	Visibility   string     `json:"visibility"`
	ForkedFromID *string    `json:"forked_from_id"`
	Version      int64      `json:"version"`
	Seq          int64      `json:"seq"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	DeletedAt    *time.Time `json:"deleted_at"`
}

type pullResponse struct {
	Notes   []noteResponse `json:"notes"`
	Cursor  int64          `json:"cursor"`
	HasMore bool           `json:"has_more"`
}

func newNoteResponse(n *store.Note) *noteResponse {
	return &noteResponse{
		ID:           n.ID,
		ClassID:      n.ClassID,
		Title:        n.Title,
		BodyMd:       n.BodyMd,
		Visibility:   n.Visibility,
		ForkedFromID: n.ForkedFromID,
		Version:      n.Version,
		Seq:          n.Seq,
		CreatedAt:    n.CreatedAt,
		UpdatedAt:    n.UpdatedAt,
		DeletedAt:    n.DeletedAt,
	}
}

func isHex(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}

// Ids are minted by the client, so the server checks the shape rather than
// trusting it. Any UUID version: the client promises v7 for the ordering, and
// the server never depends on it.
func validUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if r != '-' {
				return false
			}
			continue
		}
		if !isHex(r) {
			return false
		}
	}

	return true
}

// Returns the message to send back, empty when valid. A failure here is a
// client bug rather than a sync outcome, so it is a 400 for the batch and
// never one of the three result statuses.
func (n *pushNote) validate() (store.NoteInput, string) {
	if !validUUID(n.ID) {
		return store.NoteInput{}, "note id must be a UUID"
	}
	if utf8.RuneCountInString(n.Title) > maxNoteTitle {
		return store.NoteInput{}, "note " + n.ID + ": title must be at most 200 characters"
	}
	if !slices.Contains(visibilities, n.Visibility) {
		return store.NoteInput{}, "note " + n.ID + ": visibility must be private, faculty or public"
	}
	if n.Version < 0 {
		return store.NoteInput{}, "note " + n.ID + ": version must not be negative"
	}

	// Parsed here so a malformed value is a 400 rather than a string the
	// column cannot be compared against later.
	var deletedAt *time.Time
	if n.DeletedAt != nil {
		t, err := time.Parse(time.RFC3339, *n.DeletedAt)
		if err != nil {
			return store.NoteInput{}, "note " + n.ID + ": deleted_at must be an RFC 3339 timestamp"
		}
		utc := t.UTC()
		deletedAt = &utc
	}

	return store.NoteInput{
		ID:           n.ID,
		ClassID:      n.ClassID,
		Title:        n.Title,
		BodyMd:       n.BodyMd,
		Visibility:   n.Visibility,
		ForkedFromID: n.ForkedFromID,
		Version:      n.Version,
		DeletedAt:    deletedAt,
	}, ""
}

func (s *server) push(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req pushRequest
	if !decodeBodyLimit(w, r, &req, maxPushBytes) {
		return
	}
	if len(req.Notes) > maxPushNotes {
		writeError(w, http.StatusRequestEntityTooLarge, "a push carries at most 100 notes")
		return
	}

	// Validated before anything is written, so a batch the server refuses
	// leaves no half of itself behind.
	inputs := make([]store.NoteInput, 0, len(req.Notes))
	for i := range req.Notes {
		input, message := req.Notes[i].validate()
		if message != "" {
			writeError(w, http.StatusBadRequest, message)
			return
		}
		inputs = append(inputs, input)
	}

	// One transaction per note, inside UpsertNote. A conflict on the third
	// must not undo the first two.
	results := make([]pushResult, 0, len(inputs))
	for _, input := range inputs {
		note, err := s.db.UpsertNote(r.Context(), user.ID, input)
		switch {
		case errors.Is(err, store.ErrVersionConflict):
			// The server's copy travels with the conflict, so deciding what
			// to do costs the client no second request.
			results = append(results, pushResult{ID: input.ID, Status: "conflict", Note: newNoteResponse(note)})
		case errors.Is(err, store.ErrForbidden):
			results = append(results, pushResult{ID: input.ID, Status: "forbidden"})
		case err != nil:
			slog.Error("upserting note failed", "note", input.ID, "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "could not save the notes")
			return
		default:
			results = append(results, pushResult{ID: input.ID, Status: "accepted", Note: newNoteResponse(note)})
		}
	}

	writeJSON(w, http.StatusOK, pushResponse{Results: results})
}

// Absent means the default. Present and unparseable is an error rather than
// the default, because a client sending since=abc has a bug and silently
// pulling from zero would hide it behind a full resync.
func queryInt(r *http.Request, name string, fallback int64) (int64, string) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, ""
	}

	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0, name + " must be a non-negative integer"
	}

	return value, ""
}

func (s *server) pull(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	since, message := queryInt(r, "since", 0)
	if message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	limit, message := queryInt(r, "limit", defaultPullLimit)
	if message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	if limit < 1 {
		limit = defaultPullLimit
	}
	if limit > maxPullLimit {
		limit = maxPullLimit
	}

	// One row past the limit answers has_more exactly, without a second query.
	notes, err := s.db.NotesSince(r.Context(), user.ID, since, int(limit)+1)
	if err != nil {
		slog.Error("pulling notes failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "could not read the notes")
		return
	}

	hasMore := int64(len(notes)) > limit
	if hasMore {
		notes = notes[:limit]
	}

	// An empty page returns the cursor it was given. There is no highest seq
	// to report, and answering zero would send the client back to the start.
	cursor := since
	body := make([]noteResponse, 0, len(notes))
	for i := range notes {
		body = append(body, *newNoteResponse(&notes[i]))
		cursor = notes[i].Seq
	}

	writeJSON(w, http.StatusOK, pullResponse{Notes: body, Cursor: cursor, HasMore: hasMore})
}

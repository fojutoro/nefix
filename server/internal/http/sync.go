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
	maxPushBytes = 1 << 20
	// Per array, not per request. Three arrays of a hundred is still well
	// inside the byte ceiling, which is the real limit on a batch.
	maxPushRows      = 100
	defaultPullLimit = 100
	maxPullLimit     = 500
	maxNoteTitle     = 200
	maxName          = 200
)

var visibilities = []string{"private", "faculty", "public"}

// Not a CHECK on the column, deliberately: see 0007_collegebooks.sql. Here a
// kind this server does not know is a 400 that names the row, rather than a
// constraint failure that reads as a server fault and stops the client's sync
// dead.
var notebookKinds = []string{"notes", "collegebook"}

// What a client may send. The server owns seq, version arithmetic and the
// timestamps, so none of them are fields here except the version the client
// last saw, which is the whole point of the exchange.
type pushNote struct {
	ID string `json:"id"`
	// Vestigial and always null. Membership moved to notebook_id; this column
	// is dropped a release from now, and nothing new may start writing it.
	ClassID      *int64  `json:"class_id"`
	NotebookID   *string `json:"notebook_id"`
	Title        string  `json:"title"`
	BodyMd       string  `json:"body_md"`
	Visibility   string  `json:"visibility"`
	ForkedFromID *string `json:"forked_from_id"`
	// The note's place in its collegebook, null for a note that is not a
	// page. A float: a page inserted between two others takes the midpoint of
	// their orders, so nothing after it is renumbered.
	PageOrder *float64 `json:"page_order"`
	Version   int64    `json:"version"`
	DeletedAt *string  `json:"deleted_at"`
}

type pushClass struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Code     *string `json:"code"`
	Colour   *string `json:"colour"`
	Semester *string `json:"semester"`
	// Archiving is an ordinary field on an ordinary update, not a delete.
	ArchivedAt *string `json:"archived_at"`
	Version    int64   `json:"version"`
	DeletedAt  *string `json:"deleted_at"`
}

type pushNotebook struct {
	ID string `json:"id"`
	// May name a class the server has not been given yet, and may be null:
	// a notebook without a class is allowed.
	ClassID   *string `json:"class_id"`
	Name      string  `json:"name"`
	IsGeneral bool    `json:"is_general"`
	// 'notes' or 'collegebook'. Absent is 'notes': a client that predates
	// collegebooks sends no kind at all and must keep syncing.
	Kind      string  `json:"kind"`
	Version   int64   `json:"version"`
	DeletedAt *string `json:"deleted_at"`
}

// Named arrays rather than one list with a type discriminator: each kind has
// different fields, and a tagged union on the wire would mean decoding twice.
type pushRequest struct {
	Classes   []pushClass    `json:"classes"`
	Notebooks []pushNotebook `json:"notebooks"`
	Notes     []pushNote     `json:"notes"`
}

type pushResult struct {
	ID string `json:"id"`
	// Which local table the result refers to: class, notebook or note. Ids
	// are unique across the three, but the client still has to know which
	// store to write, and reading that from which field is populated would
	// break the moment a row comes back without one.
	Kind     string            `json:"kind"`
	Status   string            `json:"status"`
	Class    *classResponse    `json:"class,omitempty"`
	Notebook *notebookResponse `json:"notebook,omitempty"`
	Note     *noteResponse     `json:"note,omitempty"`
}

type pushResponse struct {
	Results []pushResult `json:"results"`
}

type noteResponse struct {
	ID           string     `json:"id"`
	ClassID      *int64     `json:"class_id"`
	NotebookID   *string    `json:"notebook_id"`
	Title        string     `json:"title"`
	BodyMd       string     `json:"body_md"`
	Visibility   string     `json:"visibility"`
	ForkedFromID *string    `json:"forked_from_id"`
	PageOrder    *float64   `json:"page_order"`
	Version      int64      `json:"version"`
	Seq          int64      `json:"seq"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	DeletedAt    *time.Time `json:"deleted_at"`
}

type classResponse struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Code       *string    `json:"code"`
	Colour     *string    `json:"colour"`
	Semester   *string    `json:"semester"`
	ArchivedAt *time.Time `json:"archived_at"`
	Version    int64      `json:"version"`
	Seq        int64      `json:"seq"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	DeletedAt  *time.Time `json:"deleted_at"`
}

type notebookResponse struct {
	ID        string     `json:"id"`
	ClassID   *string    `json:"class_id"`
	Name      string     `json:"name"`
	IsGeneral bool       `json:"is_general"`
	Kind      string     `json:"kind"`
	Version   int64      `json:"version"`
	Seq       int64      `json:"seq"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at"`
}

type pullResponse struct {
	Classes   []classResponse    `json:"classes"`
	Notebooks []notebookResponse `json:"notebooks"`
	Notes     []noteResponse     `json:"notes"`
	Cursor    int64              `json:"cursor"`
	HasMore   bool               `json:"has_more"`
}

func newNoteResponse(n *store.Note) *noteResponse {
	return &noteResponse{
		ID:           n.ID,
		ClassID:      n.ClassID,
		NotebookID:   n.NotebookID,
		Title:        n.Title,
		BodyMd:       n.BodyMd,
		Visibility:   n.Visibility,
		ForkedFromID: n.ForkedFromID,
		PageOrder:    n.PageOrder,
		Version:      n.Version,
		Seq:          n.Seq,
		CreatedAt:    n.CreatedAt,
		UpdatedAt:    n.UpdatedAt,
		DeletedAt:    n.DeletedAt,
	}
}

func newClassResponse(c *store.Class) *classResponse {
	return &classResponse{
		ID:         c.ID,
		Name:       c.Name,
		Code:       c.Code,
		Colour:     c.Colour,
		Semester:   c.Semester,
		ArchivedAt: c.ArchivedAt,
		Version:    c.Version,
		Seq:        c.Seq,
		CreatedAt:  c.CreatedAt,
		UpdatedAt:  c.UpdatedAt,
		DeletedAt:  c.DeletedAt,
	}
}

func newNotebookResponse(n *store.Notebook) *notebookResponse {
	return &notebookResponse{
		ID:        n.ID,
		ClassID:   n.ClassID,
		Name:      n.Name,
		IsGeneral: n.IsGeneral,
		Kind:      n.Kind,
		Version:   n.Version,
		Seq:       n.Seq,
		CreatedAt: n.CreatedAt,
		UpdatedAt: n.UpdatedAt,
		DeletedAt: n.DeletedAt,
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

// Parsed at the boundary so a malformed value is a 400 rather than a string
// the column cannot be compared against later.
func optionalTime(raw *string, field, subject string) (*time.Time, string) {
	if raw == nil {
		return nil, ""
	}

	t, err := time.Parse(time.RFC3339, *raw)
	if err != nil {
		return nil, subject + ": " + field + " must be an RFC 3339 timestamp"
	}
	utc := t.UTC()

	return &utc, ""
}

// A reference to a row the server may not hold yet, which is why it is only
// ever checked for shape.
func optionalUUID(raw *string, field, subject string) string {
	if raw == nil || validUUID(*raw) {
		return ""
	}

	return subject + ": " + field + " must be a UUID"
}

// Returns the message to send back, empty when valid. A failure here is a
// client bug rather than a sync outcome, so it is a 400 for the batch and
// never one of the three result statuses.
func (n *pushNote) validate() (store.NoteInput, string) {
	if !validUUID(n.ID) {
		return store.NoteInput{}, "note id must be a UUID"
	}
	subject := "note " + n.ID
	if utf8.RuneCountInString(n.Title) > maxNoteTitle {
		return store.NoteInput{}, subject + ": title must be at most 200 characters"
	}
	if !slices.Contains(visibilities, n.Visibility) {
		return store.NoteInput{}, subject + ": visibility must be private, faculty or public"
	}
	if n.Version < 0 {
		return store.NoteInput{}, subject + ": version must not be negative"
	}
	if message := optionalUUID(n.NotebookID, "notebook_id", subject); message != "" {
		return store.NoteInput{}, message
	}

	deletedAt, message := optionalTime(n.DeletedAt, "deleted_at", subject)
	if message != "" {
		return store.NoteInput{}, message
	}

	return store.NoteInput{
		ID:           n.ID,
		ClassID:      n.ClassID,
		NotebookID:   n.NotebookID,
		Title:        n.Title,
		BodyMd:       n.BodyMd,
		Visibility:   n.Visibility,
		ForkedFromID: n.ForkedFromID,
		PageOrder:    n.PageOrder,
		Version:      n.Version,
		DeletedAt:    deletedAt,
	}, ""
}

func (c *pushClass) validate() (store.ClassInput, string) {
	if !validUUID(c.ID) {
		return store.ClassInput{}, "class id must be a UUID"
	}
	subject := "class " + c.ID
	if utf8.RuneCountInString(c.Name) > maxName {
		return store.ClassInput{}, subject + ": name must be at most 200 characters"
	}
	if c.Version < 0 {
		return store.ClassInput{}, subject + ": version must not be negative"
	}

	archivedAt, message := optionalTime(c.ArchivedAt, "archived_at", subject)
	if message != "" {
		return store.ClassInput{}, message
	}
	deletedAt, message := optionalTime(c.DeletedAt, "deleted_at", subject)
	if message != "" {
		return store.ClassInput{}, message
	}

	return store.ClassInput{
		ID:         c.ID,
		Name:       c.Name,
		Code:       c.Code,
		Colour:     c.Colour,
		Semester:   c.Semester,
		ArchivedAt: archivedAt,
		Version:    c.Version,
		DeletedAt:  deletedAt,
	}, ""
}

func (n *pushNotebook) validate() (store.NotebookInput, string) {
	if !validUUID(n.ID) {
		return store.NotebookInput{}, "notebook id must be a UUID"
	}
	subject := "notebook " + n.ID
	if utf8.RuneCountInString(n.Name) > maxName {
		return store.NotebookInput{}, subject + ": name must be at most 200 characters"
	}
	if n.Version < 0 {
		return store.NotebookInput{}, subject + ": version must not be negative"
	}
	if message := optionalUUID(n.ClassID, "class_id", subject); message != "" {
		return store.NotebookInput{}, message
	}
	// Empty is absent rather than wrong. The store turns it into 'notes',
	// which is the one place that default lives.
	if n.Kind != "" && !slices.Contains(notebookKinds, n.Kind) {
		return store.NotebookInput{}, subject + ": kind must be notes or collegebook"
	}

	deletedAt, message := optionalTime(n.DeletedAt, "deleted_at", subject)
	if message != "" {
		return store.NotebookInput{}, message
	}

	return store.NotebookInput{
		ID:        n.ID,
		ClassID:   n.ClassID,
		Name:      n.Name,
		IsGeneral: n.IsGeneral,
		Kind:      n.Kind,
		Version:   n.Version,
		DeletedAt: deletedAt,
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
	for _, array := range []struct {
		name string
		size int
	}{
		{"classes", len(req.Classes)},
		{"notebooks", len(req.Notebooks)},
		{"notes", len(req.Notes)},
	} {
		if array.size > maxPushRows {
			writeError(w, http.StatusRequestEntityTooLarge,
				"a push carries at most 100 "+array.name)
			return
		}
	}

	// Validated before anything is written, so a batch the server refuses
	// leaves no half of itself behind. A malformed row in any array refuses
	// all three.
	classInputs := make([]store.ClassInput, 0, len(req.Classes))
	for i := range req.Classes {
		input, message := req.Classes[i].validate()
		if message != "" {
			writeError(w, http.StatusBadRequest, message)
			return
		}
		classInputs = append(classInputs, input)
	}
	notebookInputs := make([]store.NotebookInput, 0, len(req.Notebooks))
	for i := range req.Notebooks {
		input, message := req.Notebooks[i].validate()
		if message != "" {
			writeError(w, http.StatusBadRequest, message)
			return
		}
		notebookInputs = append(notebookInputs, input)
	}
	noteInputs := make([]store.NoteInput, 0, len(req.Notes))
	for i := range req.Notes {
		input, message := req.Notes[i].validate()
		if message != "" {
			writeError(w, http.StatusBadRequest, message)
			return
		}
		noteInputs = append(noteInputs, input)
	}

	// One transaction per row, inside each Upsert. A conflict on the third
	// must not undo the first two.
	//
	// Classes, then notebooks, then notes: dependency order within the one
	// request. A client creating a class and its general notebook in one
	// gesture pushes both together, and this way the server never briefly
	// holds a notebook whose class it has not seen.
	results := make([]pushResult, 0, len(classInputs)+len(notebookInputs)+len(noteInputs))

	for _, input := range classInputs {
		class, err := s.db.UpsertClass(r.Context(), user.ID, input)
		result := pushResult{ID: input.ID, Kind: "class"}
		switch {
		case errors.Is(err, store.ErrVersionConflict):
			result.Status, result.Class = "conflict", newClassResponse(class)
		case errors.Is(err, store.ErrForbidden):
			result.Status = "forbidden"
		case err != nil:
			slog.Error("upserting class failed", "class", input.ID, "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "could not save the classes")
			return
		default:
			result.Status, result.Class = "accepted", newClassResponse(class)
		}
		results = append(results, result)
	}

	for _, input := range notebookInputs {
		notebook, err := s.db.UpsertNotebook(r.Context(), user.ID, input)
		result := pushResult{ID: input.ID, Kind: "notebook"}
		switch {
		case errors.Is(err, store.ErrVersionConflict):
			result.Status, result.Notebook = "conflict", newNotebookResponse(notebook)
		case errors.Is(err, store.ErrForbidden):
			result.Status = "forbidden"
		case err != nil:
			slog.Error("upserting notebook failed", "notebook", input.ID, "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "could not save the notebooks")
			return
		default:
			result.Status, result.Notebook = "accepted", newNotebookResponse(notebook)
		}
		results = append(results, result)
	}

	for _, input := range noteInputs {
		note, err := s.db.UpsertNote(r.Context(), user.ID, input)
		result := pushResult{ID: input.ID, Kind: "note"}
		switch {
		case errors.Is(err, store.ErrVersionConflict):
			// The server's copy travels with the conflict, so deciding what
			// to do costs the client no second request.
			result.Status, result.Note = "conflict", newNoteResponse(note)
		case errors.Is(err, store.ErrForbidden):
			result.Status = "forbidden"
		case err != nil:
			slog.Error("upserting note failed", "note", input.ID, "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "could not save the notes")
			return
		default:
			result.Status, result.Note = "accepted", newNoteResponse(note)
		}
		results = append(results, result)
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

	// One row past the limit from each table answers has_more exactly,
	// without a second query.
	classes, err := s.db.ClassesSince(r.Context(), user.ID, since, int(limit)+1)
	if err != nil {
		pullFailed(w, user.ID, err)
		return
	}
	notebooks, err := s.db.NotebooksSince(r.Context(), user.ID, since, int(limit)+1)
	if err != nil {
		pullFailed(w, user.ID, err)
		return
	}
	notes, err := s.db.NotesSince(r.Context(), user.ID, since, int(limit)+1)
	if err != nil {
		pullFailed(w, user.ID, err)
		return
	}

	writeJSON(w, http.StatusOK, page(since, limit, classes, notebooks, notes))
}

func pullFailed(w http.ResponseWriter, userID int64, err error) {
	slog.Error("pulling failed", "user", userID, "error", err)
	writeError(w, http.StatusInternalServerError, "could not read the changes")
}

// The three tables are one ordered stream cut up by type, so a page is the
// `limit` lowest seqs across all of them and the cursor is the highest seq
// that survived that cut. A page can therefore be entirely one type while
// the other tables hold rows above the cursor, and that is right rather than
// a gap: the cursor is a position in the stream, and which table a row came
// from is incidental to it. Reserving a share of the page per type, or
// carrying a cursor per type, is what would let a client hold a consistent
// view of its notes and a stale one of the notebooks they sit in.
func page(since, limit int64, classes []store.Class, notebooks []store.Notebook, notes []store.Note) pullResponse {
	seqs := make([]int64, 0, len(classes)+len(notebooks)+len(notes))
	for i := range classes {
		seqs = append(seqs, classes[i].Seq)
	}
	for i := range notebooks {
		seqs = append(seqs, notebooks[i].Seq)
	}
	for i := range notes {
		seqs = append(seqs, notes[i].Seq)
	}
	slices.Sort(seqs)

	hasMore := int64(len(seqs)) > limit
	if hasMore {
		seqs = seqs[:limit]
	}

	// An empty page returns the cursor it was given. There is no highest seq
	// to report, and answering zero would send the client back to the start.
	cursor := since
	if len(seqs) > 0 {
		cursor = seqs[len(seqs)-1]
	}

	body := pullResponse{
		Classes:   make([]classResponse, 0, len(classes)),
		Notebooks: make([]notebookResponse, 0, len(notebooks)),
		Notes:     make([]noteResponse, 0, len(notes)),
		Cursor:    cursor,
		HasMore:   hasMore,
	}
	// Each table already comes back in seq order, so the first row above the
	// cursor ends that table's share of the page.
	for i := range classes {
		if classes[i].Seq > cursor {
			break
		}
		body.Classes = append(body.Classes, *newClassResponse(&classes[i]))
	}
	for i := range notebooks {
		if notebooks[i].Seq > cursor {
			break
		}
		body.Notebooks = append(body.Notebooks, *newNotebookResponse(&notebooks[i]))
	}
	for i := range notes {
		if notes[i].Seq > cursor {
			break
		}
		body.Notes = append(body.Notes, *newNoteResponse(&notes[i]))
	}

	return body
}

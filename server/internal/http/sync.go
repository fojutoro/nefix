package http

import (
	"encoding/json"
	"errors"
	"fmt"
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
	// Per array, not per request. Four arrays of a hundred is still well
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

// The cap on a notebook's settings blob. Generous for a few dozen appearance
// keys and small enough that the column cannot become a file store, which is
// the one thing an opaque TEXT column invites.
const maxSettings = 4096

// Not a CHECK on the column either, for the reason notebookKinds is not: see
// 0009_deadlines.sql.
var deadlineKinds = []string{"test", "assignment", "other"}

// The cap on a deadline's topics blob. Larger than maxSettings because a
// topic carries a UUID and a heading and a deadline may have many, and still
// small enough that the column cannot become a file store.
const maxTopics = 8192

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
	Kind string `json:"kind"`
	// The client's appearance settings for this book, as JSON text. A string
	// and not a nested object: the client is the only thing that reads these,
	// and decoding them here into a map would reorder the keys and drop any
	// this version has never heard of, so a newer client's book would come
	// back from an older server with its settings quietly mangled. As text
	// the bytes are returned exactly as they arrived. Absent is null.
	Settings  *string `json:"settings"`
	Version   int64   `json:"version"`
	DeletedAt *string `json:"deleted_at"`
}

type pushDeadline struct {
	ID string `json:"id"`
	// May name a class the server has not been given yet, and may be null: a
	// loose deadline belongs to no class.
	ClassID *string `json:"class_id"`
	Title   string  `json:"title"`
	// 'test', 'assignment' or 'other'. Absent is 'other': a client that
	// predates this field sends no kind at all and must keep syncing.
	Kind string `json:"kind"`
	// A date, and the only timestamp a client must send. Its time component
	// is midnight UTC and means nothing — a test is on Friday, not at 14:30.
	DueAt string  `json:"due_at"`
	Note  *string `json:"note"`
	// The deadline's topics, as JSON text and not a nested array, for the
	// reason a notebook's settings are text: the server stores these bytes
	// without reading them, and decoding them here would reorder the keys and
	// drop any this version has never heard of, so a newer client's deadline
	// would come back from an older server with its topics quietly mangled.
	Topics *string `json:"topics"`
	// Set means ticked off. An ordinary field on an ordinary update, not a
	// delete, exactly as archived_at is on a class.
	DoneAt    *string `json:"done_at"`
	Version   int64   `json:"version"`
	DeletedAt *string `json:"deleted_at"`
}

// Named arrays rather than one list with a type discriminator: each kind has
// different fields, and a tagged union on the wire would mean decoding twice.
type pushRequest struct {
	Classes   []pushClass    `json:"classes"`
	Notebooks []pushNotebook `json:"notebooks"`
	Notes     []pushNote     `json:"notes"`
	Deadlines []pushDeadline `json:"deadlines"`
}

type pushResult struct {
	ID string `json:"id"`
	// Which local table the result refers to: class, notebook, note or
	// deadline. Ids are unique across the four, but the client still has to
	// know which store to write, and reading that from which field is
	// populated would break the moment a row comes back without one.
	Kind     string            `json:"kind"`
	Status   string            `json:"status"`
	Class    *classResponse    `json:"class,omitempty"`
	Notebook *notebookResponse `json:"notebook,omitempty"`
	Note     *noteResponse     `json:"note,omitempty"`
	Deadline *deadlineResponse `json:"deadline,omitempty"`
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
	Settings  *string    `json:"settings"`
	Version   int64      `json:"version"`
	Seq       int64      `json:"seq"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at"`
}

type deadlineResponse struct {
	ID      string  `json:"id"`
	ClassID *string `json:"class_id"`
	Title   string  `json:"title"`
	Kind    string  `json:"kind"`
	// Marshalled as RFC 3339 like every other timestamp, with the time at
	// midnight UTC. That time is not meaningful and no reader may use it.
	DueAt     time.Time  `json:"due_at"`
	Note      *string    `json:"note"`
	Topics    *string    `json:"topics"`
	DoneAt    *time.Time `json:"done_at"`
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
	Deadlines []deadlineResponse `json:"deadlines"`
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
		Settings:  n.Settings,
		Version:   n.Version,
		Seq:       n.Seq,
		CreatedAt: n.CreatedAt,
		UpdatedAt: n.UpdatedAt,
		DeletedAt: n.DeletedAt,
	}
}

func newDeadlineResponse(d *store.Deadline) *deadlineResponse {
	return &deadlineResponse{
		ID:        d.ID,
		ClassID:   d.ClassID,
		Title:     d.Title,
		Kind:      d.Kind,
		DueAt:     d.DueAt,
		Note:      d.Note,
		Topics:    d.Topics,
		DoneAt:    d.DoneAt,
		Version:   d.Version,
		Seq:       d.Seq,
		CreatedAt: d.CreatedAt,
		UpdatedAt: d.UpdatedAt,
		DeletedAt: d.DeletedAt,
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

// due_at is the one timestamp a client has to send, so it is parsed through
// this rather than optionalTime: absent decodes to the empty string and must
// be named as a missing field rather than silently becoming the zero time,
// which would file every such deadline in the year 1.
func requiredTime(raw, field, subject string) (time.Time, string) {
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, subject + ": " + field + " must be an RFC 3339 timestamp"
	}

	return t.UTC(), ""
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
	// Two rules, and deliberately no third. The shape of the blob is the
	// client's business — a future version will put keys in here this server
	// has never heard of, and validating them would break that client's sync
	// rather than degrade it. What is checked is that the column cannot be
	// used as unbounded storage, and that bytes which no reader could parse
	// are named now rather than failing on every device that pulls them.
	if n.Settings != nil {
		if len(*n.Settings) > maxSettings {
			return store.NotebookInput{}, fmt.Sprintf(
				"%s: settings must be at most %d bytes", subject, maxSettings)
		}
		if !json.Valid([]byte(*n.Settings)) {
			return store.NotebookInput{}, subject + ": settings must be valid JSON"
		}
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
		Settings:  n.Settings,
		Version:   n.Version,
		DeletedAt: deletedAt,
	}, ""
}

func (d *pushDeadline) validate() (store.DeadlineInput, string) {
	if !validUUID(d.ID) {
		return store.DeadlineInput{}, "deadline id must be a UUID"
	}
	subject := "deadline " + d.ID
	if utf8.RuneCountInString(d.Title) > maxName {
		return store.DeadlineInput{}, subject + ": title must be at most 200 characters"
	}
	if d.Version < 0 {
		return store.DeadlineInput{}, subject + ": version must not be negative"
	}
	if message := optionalUUID(d.ClassID, "class_id", subject); message != "" {
		return store.DeadlineInput{}, message
	}
	// Empty is absent rather than wrong. The store turns it into 'other',
	// which is the one place that default lives.
	if d.Kind != "" && !slices.Contains(deadlineKinds, d.Kind) {
		return store.DeadlineInput{}, subject + ": kind must be test, assignment or other"
	}
	// The same two rules as a notebook's settings, and deliberately no third:
	// a cap, so an opaque column cannot become a file store, and valid JSON,
	// so bytes no reader could parse are named here rather than failing on
	// every device that pulls them. What is inside a topic is the client's
	// business — a newer client will put keys in one that this server has
	// never heard of, and validating them would break its sync rather than
	// degrade it.
	//
	// A 400 for either, not a 413. In this API 413 means the request is too
	// big; one field over its own cap is a bad request that names the row,
	// which is what notebooks.settings already answers.
	if d.Topics != nil {
		if len(*d.Topics) > maxTopics {
			return store.DeadlineInput{}, fmt.Sprintf(
				"%s: topics must be at most %d bytes", subject, maxTopics)
		}
		if !json.Valid([]byte(*d.Topics)) {
			return store.DeadlineInput{}, subject + ": topics must be valid JSON"
		}
	}

	dueAt, message := requiredTime(d.DueAt, "due_at", subject)
	if message != "" {
		return store.DeadlineInput{}, message
	}
	doneAt, message := optionalTime(d.DoneAt, "done_at", subject)
	if message != "" {
		return store.DeadlineInput{}, message
	}
	deletedAt, message := optionalTime(d.DeletedAt, "deleted_at", subject)
	if message != "" {
		return store.DeadlineInput{}, message
	}

	return store.DeadlineInput{
		ID:        d.ID,
		ClassID:   d.ClassID,
		Title:     d.Title,
		Kind:      d.Kind,
		DueAt:     dueAt,
		Note:      d.Note,
		Topics:    d.Topics,
		DoneAt:    doneAt,
		Version:   d.Version,
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
		{"deadlines", len(req.Deadlines)},
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
	deadlineInputs := make([]store.DeadlineInput, 0, len(req.Deadlines))
	for i := range req.Deadlines {
		input, message := req.Deadlines[i].validate()
		if message != "" {
			writeError(w, http.StatusBadRequest, message)
			return
		}
		deadlineInputs = append(deadlineInputs, input)
	}

	// One transaction per row, inside each Upsert. A conflict on the third
	// must not undo the first two.
	//
	// Classes, then notebooks, then notes, then deadlines: dependency order
	// within the one request. A client creating a class and its general
	// notebook in one gesture pushes both together, and this way the server
	// never briefly holds a notebook whose class it has not seen. Deadlines
	// come last because their topics reference notes, so the notes land
	// first — nothing here resolves a topic, but the seq order a pull
	// replays is the same order, and a client applying it must not meet a
	// topic before the note it names.
	results := make([]pushResult, 0,
		len(classInputs)+len(notebookInputs)+len(noteInputs)+len(deadlineInputs))

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

	for _, input := range deadlineInputs {
		deadline, err := s.db.UpsertDeadline(r.Context(), user.ID, input)
		result := pushResult{ID: input.ID, Kind: "deadline"}
		switch {
		case errors.Is(err, store.ErrVersionConflict):
			result.Status, result.Deadline = "conflict", newDeadlineResponse(deadline)
		case errors.Is(err, store.ErrForbidden):
			result.Status = "forbidden"
		case err != nil:
			slog.Error("upserting deadline failed", "deadline", input.ID, "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "could not save the deadlines")
			return
		default:
			result.Status, result.Deadline = "accepted", newDeadlineResponse(deadline)
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
	deadlines, err := s.db.DeadlinesSince(r.Context(), user.ID, since, int(limit)+1)
	if err != nil {
		pullFailed(w, user.ID, err)
		return
	}

	writeJSON(w, http.StatusOK, page(since, limit, classes, notebooks, notes, deadlines))
}

func pullFailed(w http.ResponseWriter, userID int64, err error) {
	slog.Error("pulling failed", "user", userID, "error", err)
	writeError(w, http.StatusInternalServerError, "could not read the changes")
}

// The four tables are one ordered stream cut up by type, so a page is the
// `limit` lowest seqs across all of them and the cursor is the highest seq
// that survived that cut. A page can therefore be entirely one type while
// the other tables hold rows above the cursor, and that is right rather than
// a gap: the cursor is a position in the stream, and which table a row came
// from is incidental to it. Reserving a share of the page per type, or
// carrying a cursor per type, is what would let a client hold a consistent
// view of its notes and a stale one of the notebooks they sit in.
func page(since, limit int64, classes []store.Class, notebooks []store.Notebook,
	notes []store.Note, deadlines []store.Deadline) pullResponse {
	seqs := make([]int64, 0, len(classes)+len(notebooks)+len(notes)+len(deadlines))
	for i := range classes {
		seqs = append(seqs, classes[i].Seq)
	}
	for i := range notebooks {
		seqs = append(seqs, notebooks[i].Seq)
	}
	for i := range notes {
		seqs = append(seqs, notes[i].Seq)
	}
	for i := range deadlines {
		seqs = append(seqs, deadlines[i].Seq)
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
		Deadlines: make([]deadlineResponse, 0, len(deadlines)),
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
	for i := range deadlines {
		if deadlines[i].Seq > cursor {
			break
		}
		body.Deadlines = append(body.Deadlines, *newDeadlineResponse(&deadlines[i]))
	}

	return body
}

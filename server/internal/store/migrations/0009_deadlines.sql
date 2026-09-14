-- A dated thing a student must do: a test, an assignment, a form to hand in.
-- It belongs to a class, or to nothing.

CREATE TABLE deadlines (
  id          TEXT PRIMARY KEY,
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Nullable, because a loose deadline belongs to no class. No REFERENCES
  -- clause, for the reason notebooks.class_id has none: a client syncing out
  -- of order can legitimately push a deadline before its class, and a
  -- foreign key violation there would answer something that is not a client
  -- error with a 500.
  class_id    TEXT,
  title       TEXT NOT NULL,
  -- 'test', 'assignment' or 'other', and no CHECK, exactly as notebooks.kind
  -- carries none. A kind from a newer client is refused in Go with a 400 that
  -- names the row, rather than failing a constraint and reading as a server
  -- fault that stops that client's sync dead.
  kind        TEXT NOT NULL DEFAULT 'other',
  -- A date, not a moment. A test is "on Friday", not "at 14:30". Stored in
  -- the same format as every other timestamp here, with the time at midnight
  -- UTC: that time component is not meaningful and nothing may read it. The
  -- client decides what "today" means against its own calendar.
  due_at      TEXT NOT NULL,
  note        TEXT,
  -- A JSON array of {noteId, heading}, stored as text and never parsed by
  -- this server. It stores these bytes, returns them, and caps their size.
  -- Each topic is an id and a heading together on purpose: the text alone
  -- dangles when a heading is renamed, and the id alone cannot say which part
  -- of a long note. A server that parsed this column is a server that drops
  -- keys a newer client added, which is what notebooks.settings taught.
  topics      TEXT,
  -- Set means ticked off. Soft, like every delete here, and not the same
  -- thing as deleted_at below: a finished deadline is still a deadline.
  done_at     TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  -- Per-author and shared with classes, notebooks and notes, handed out by
  -- the same nextSeq. One counter and one cursor across all four.
  seq         INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);

CREATE INDEX idx_deadlines_author_seq ON deadlines(author_id, seq);
CREATE INDEX idx_deadlines_due ON deadlines(author_id, due_at);

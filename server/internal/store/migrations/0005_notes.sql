CREATE TABLE notes (
  id             TEXT PRIMARY KEY,
  author_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- No REFERENCES clause: classes are phase 5 and the table does not exist
  -- yet. The constraint arrives with the classes migration.
  class_id       INTEGER,
  title          TEXT NOT NULL,
  body_md        TEXT NOT NULL,
  -- 'faculty' is accepted and today means readable by its author and nobody
  -- else: users.faculty_id is always NULL until faculty assignment exists, so
  -- no reader can ever match. That is correct behaviour, not a gap.
  visibility     TEXT NOT NULL DEFAULT 'private'
                 CHECK (visibility IN ('private','faculty','public')),
  -- No REFERENCES notes(id) either, for the same reason as class_id but a
  -- phase later: a client can push a fork before the server has the note it
  -- forked from, and a foreign key would answer a bad request with a 500.
  -- Forks are phase 6 and the constraint arrives with them.
  forked_from_id TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  -- Per-author, monotonic, handed out by nextSeq. The pull cursor, and the
  -- reason it is not a timestamp: two notes written in the same millisecond
  -- cannot straddle a cursor and lose one of themselves.
  seq            INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);

CREATE INDEX idx_notes_author_seq ON notes(author_id, seq);
CREATE INDEX idx_notes_class ON notes(class_id, visibility);

ALTER TABLE users ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;

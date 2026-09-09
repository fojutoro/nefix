CREATE TABLE classes (
  id           TEXT PRIMARY KEY,
  author_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  code         TEXT,
  colour       TEXT,
  semester     TEXT,
  -- A class is archived, never hard-deleted. Its notebooks and notes stay
  -- intact and reachable: a semester's notes are exactly what someone wants
  -- back a year later. deleted_at below is the sync tombstone, and the two
  -- are not the same thing.
  archived_at  TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  -- Per-author and shared with notebooks and notes, handed out by the same
  -- nextSeq. One counter and one cursor: two would let a client hold a
  -- consistent view of its notes and a stale one of the notebooks they sit in.
  seq          INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);

CREATE TABLE notebooks (
  id           TEXT PRIMARY KEY,
  author_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- No REFERENCES clause. A client syncing out of order can legitimately
  -- push a notebook before the class it belongs to, and a foreign key
  -- violation there would answer something that is not a client error with a
  -- 500. A notebook may also have no class at all.
  class_id     TEXT,
  name         TEXT NOT NULL,
  -- The notebook created alongside its class, so a new class is something
  -- you can type in immediately. It is renameable but not deletable, and
  -- nothing here constrains it: no UNIQUE on (class_id, is_general), no
  -- CHECK. That invariant is enforced in the UI phase, deliberately, and is
  -- not an omission.
  is_general   INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  seq          INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);

-- No REFERENCES notebooks(id), for the reason notebooks.class_id has none:
-- a note can arrive before the notebook it names.
ALTER TABLE notes ADD COLUMN notebook_id TEXT;

-- notes.class_id stays, unused from here on. Dropping it in the same release
-- that stops writing it violates expand and contract: the column goes in a
-- later release, once no deployed code reads it. It is INTEGER and the new
-- ids are TEXT, which is why membership moved to notebook_id rather than
-- changing this column's type under a running client.

CREATE INDEX idx_classes_author_seq ON classes(author_id, seq);
CREATE INDEX idx_notebooks_author_seq ON notebooks(author_id, seq);
CREATE INDEX idx_notebooks_class ON notebooks(class_id);
CREATE INDEX idx_notes_notebook ON notes(notebook_id);

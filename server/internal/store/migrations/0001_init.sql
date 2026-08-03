CREATE TABLE institutions (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('university','secondary')),
  name        TEXT NOT NULL,
  short_name  TEXT NOT NULL,
  country     TEXT NOT NULL,
  website     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE faculties (
  id              INTEGER PRIMARY KEY,
  institution_id  INTEGER NOT NULL REFERENCES institutions(id),
  name            TEXT NOT NULL,
  city            TEXT,
  website         TEXT,
  email_domain    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_faculties_institution ON faculties(institution_id);

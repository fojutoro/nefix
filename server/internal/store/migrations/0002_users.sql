CREATE TABLE users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'student'
                 CHECK (role IN ('student','teacher','admin')),
  faculty_id     INTEGER REFERENCES faculties(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

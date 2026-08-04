-- Tokens were stored in plaintext. Existing rows cannot be carried over:
-- hashing needs the plaintext and the hash is one-way, so there is nothing to
-- backfill from. There are no real users yet, so dropping is correct and
-- cheaper than a table holding both forms. Dropping takes the indexes with it.
DROP TABLE sessions;

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

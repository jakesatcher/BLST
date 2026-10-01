-- API keys can expire and can be limited to one tournament (a rink
-- scorekeeper key shouldn't be able to touch other events).
ALTER TABLE api_keys ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE;

-- Security audit trail: every write, and every rejected request (401/403/429).
-- No request bodies or tokens are stored.
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor      TEXT,
  role       TEXT,
  key_id     INTEGER,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

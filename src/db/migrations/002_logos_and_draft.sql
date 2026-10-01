-- Team and tournament graphics. Stored in Postgres (not on disk) because
-- Heroku's filesystem is wiped on every restart. logo_version on the owner
-- row is the cache-buster clients put in the image URL; NULL = no logo.
CREATE TABLE team_logos (
  team_id      INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data         BYTEA NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tournament_logos (
  tournament_id INTEGER PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
  content_type  TEXT NOT NULL,
  data          BYTEA NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE teams ADD COLUMN logo_version BIGINT;
ALTER TABLE tournaments ADD COLUMN logo_version BIGINT;

-- Where a player was taken in the draft (from the post-draft roster upload).
ALTER TABLE roster_entries ADD COLUMN draft_round INTEGER CHECK (draft_round >= 0);
ALTER TABLE roster_entries ADD COLUMN draft_pick INTEGER CHECK (draft_pick >= 0);

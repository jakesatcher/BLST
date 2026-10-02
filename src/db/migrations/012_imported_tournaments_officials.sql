-- Imported history can belong to a tournament (created by the import when
-- it doesn't exist yet), so a past tournament keeps its own stats page and
-- its lines count toward players' and teams' totals once, through it.
ALTER TABLE tournaments ADD COLUMN imported BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tournaments ADD COLUMN import_batch TEXT;

ALTER TABLE historical_stats ADD COLUMN tournament_id INTEGER;
ALTER TABLE historical_stats ADD CONSTRAINT historical_stats_tournament_fk
  FOREIGN KEY (org_id, tournament_id) REFERENCES tournaments (org_id, id) ON DELETE CASCADE;
ALTER TABLE historical_stats ADD COLUMN team_id INTEGER;
ALTER TABLE historical_stats ADD CONSTRAINT historical_stats_team_fk
  FOREIGN KEY (org_id, team_id) REFERENCES teams (org_id, id) ON DELETE SET NULL (team_id);
CREATE INDEX historical_stats_tournament_idx ON historical_stats (org_id, tournament_id);

-- Officials of record for a game: referees, linespersons, scorekeepers,
-- timekeepers (names only; they don't need accounts).
CREATE TABLE game_officials (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('referee', 'linesperson', 'scorekeeper', 'timekeeper')),
  name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, game_id) REFERENCES games (org_id, id) ON DELETE CASCADE
);
CREATE INDEX game_officials_game_idx ON game_officials (org_id, game_id, position);
ALTER TABLE game_officials ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_officials FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON game_officials USING (blst_all_orgs() OR org_id = blst_org()) WITH CHECK (blst_all_orgs() OR org_id = blst_org());

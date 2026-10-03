-- Leagues: a league runs seasons; each season has divisions (B, C, D…),
-- each with its own teams, schedule, standings and playoffs. A division in a
-- season is a competition (a tournaments row with kind = 'league'), so live
-- scoring, schedules, standings, rosters and imports all work unchanged.
-- Players can play in several divisions in the same season; their stats
-- follow them across teams and divisions within the league.

CREATE TABLE leagues (
  id               SERIAL PRIMARY KEY,
  org_id           INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  short_name       TEXT CHECK (short_name IS NULL OR length(short_name) <= 16),
  -- Player-rating weights (see services/ratings.js); {} = defaults.
  rating_settings  JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name)
);

CREATE TABLE league_divisions (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  league_id  INTEGER NOT NULL,
  name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  -- 1 = the strongest division. Strength scales production in ratings
  -- (null = from the rank: 1.00, 0.85, 0.70, …).
  rank       INTEGER NOT NULL DEFAULT 1 CHECK (rank BETWEEN 1 AND 20),
  strength   NUMERIC(4, 2) CHECK (strength IS NULL OR strength BETWEEN 0.1 AND 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, league_id, name),
  FOREIGN KEY (org_id, league_id) REFERENCES leagues (org_id, id) ON DELETE CASCADE
);

CREATE TABLE league_seasons (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  league_id  INTEGER NOT NULL,
  name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  year       INTEGER CHECK (year IS NULL OR year BETWEEN 1950 AND 2100),
  start_date DATE,
  end_date   DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, league_id, name),
  FOREIGN KEY (org_id, league_id) REFERENCES leagues (org_id, id) ON DELETE CASCADE
);

ALTER TABLE tournaments ADD COLUMN kind TEXT NOT NULL DEFAULT 'tournament' CHECK (kind IN ('tournament', 'league'));
ALTER TABLE tournaments ADD COLUMN league_id INTEGER;
ALTER TABLE tournaments ADD COLUMN league_season_id INTEGER;
ALTER TABLE tournaments ADD COLUMN league_division_id INTEGER;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_league_fk FOREIGN KEY (org_id, league_id) REFERENCES leagues (org_id, id) ON DELETE CASCADE;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_league_season_fk FOREIGN KEY (org_id, league_season_id) REFERENCES league_seasons (org_id, id) ON DELETE CASCADE;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_league_division_fk FOREIGN KEY (org_id, league_division_id) REFERENCES league_divisions (org_id, id) ON DELETE CASCADE;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_league_parts CHECK (
  (kind = 'tournament' AND league_id IS NULL AND league_season_id IS NULL AND league_division_id IS NULL)
  OR (kind = 'league' AND league_id IS NOT NULL AND league_season_id IS NOT NULL AND league_division_id IS NOT NULL));
ALTER TABLE tournaments ADD CONSTRAINT tournaments_league_one UNIQUE (org_id, league_season_id, league_division_id);
CREATE INDEX tournaments_league_idx ON tournaments (org_id, league_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['leagues', 'league_divisions', 'league_seasons'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (blst_all_orgs() OR org_id = blst_org()) WITH CHECK (blst_all_orgs() OR org_id = blst_org())', t);
  END LOOP;
END $$;

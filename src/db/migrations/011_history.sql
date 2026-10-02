-- History that follows people and teams across tournaments.
--   * Draft tournaments: teams are new each time; stats follow players.
--   * Team tournaments: teams carry over as "clubs", so a club's record and
--     its players' stats add up across tournaments (and imported history).
--   * Dismissed "same person?" suggestions, so admins only see each once.

ALTER TABLE tournaments ADD COLUMN format TEXT NOT NULL DEFAULT 'draft' CHECK (format IN ('draft', 'team'));

-- Name used to recognise the same team across tournaments and imports.
CREATE OR REPLACE FUNCTION blst_team_key(name TEXT) RETURNS TEXT AS $$
  SELECT trim(regexp_replace(regexp_replace(lower(coalesce(name, '')), '[^a-z0-9 ]', '', 'g'), '\s+', ' ', 'g'))
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE clubs (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  short_name TEXT CHECK (short_name IS NULL OR length(short_name) <= 12),
  color      TEXT CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  name_key   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name_key)
);

CREATE OR REPLACE FUNCTION blst_clubs_key() RETURNS trigger AS $$
BEGIN
  NEW.name := trim(NEW.name);
  NEW.name_key := blst_team_key(NEW.name);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER clubs_key BEFORE INSERT OR UPDATE OF name ON clubs FOR EACH ROW EXECUTE FUNCTION blst_clubs_key();

ALTER TABLE teams ADD COLUMN club_id INTEGER;
ALTER TABLE teams ADD CONSTRAINT teams_club_fk FOREIGN KEY (org_id, club_id) REFERENCES clubs (org_id, id) ON DELETE SET NULL (club_id);
CREATE INDEX teams_club_idx ON teams (org_id, club_id);

ALTER TABLE historical_stats ADD COLUMN club_id INTEGER;
ALTER TABLE historical_stats ADD CONSTRAINT historical_stats_club_fk FOREIGN KEY (org_id, club_id) REFERENCES clubs (org_id, id) ON DELETE SET NULL (club_id);
CREATE INDEX historical_stats_club_idx ON historical_stats (org_id, club_id);

-- Teams in team tournaments join (or start) the club with their name.
-- Placeholder names ("Team 3", or a bare color) don't make clubs; renaming a
-- team moves it to the club with its new name, and a club left with no
-- teams and no history is removed.
CREATE OR REPLACE FUNCTION blst_placeholder_team(name TEXT) RETURNS BOOLEAN AS $$
  SELECT blst_team_key(name) ~ '^(team )?[0-9]+$' OR blst_team_key(name) = ''
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION blst_teams_club() RETURNS trigger AS $$
DECLARE
  fmt TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.name IS DISTINCT FROM OLD.name AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id THEN
    NEW.club_id := NULL; -- re-resolve by the new name
  END IF;
  IF NEW.club_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT format INTO fmt FROM tournaments WHERE id = NEW.tournament_id;
  IF fmt = 'team' AND NOT blst_placeholder_team(NEW.name) THEN
    INSERT INTO clubs (org_id, name, short_name, color) VALUES (NEW.org_id, NEW.name, NEW.short_name, NEW.color)
      ON CONFLICT (org_id, name_key) DO NOTHING;
    SELECT id INTO NEW.club_id FROM clubs WHERE org_id = NEW.org_id AND name_key = blst_team_key(NEW.name);
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER teams_club BEFORE INSERT OR UPDATE OF name, club_id ON teams FOR EACH ROW EXECUTE FUNCTION blst_teams_club();

CREATE OR REPLACE FUNCTION blst_clubs_cleanup() RETURNS trigger AS $$
BEGIN
  IF OLD.club_id IS NOT NULL AND OLD.club_id IS DISTINCT FROM NEW.club_id THEN
    DELETE FROM clubs c WHERE c.id = OLD.club_id
      AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.club_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM historical_stats h WHERE h.club_id = c.id);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER teams_club_cleanup AFTER UPDATE OF club_id, name ON teams FOR EACH ROW EXECUTE FUNCTION blst_clubs_cleanup();

-- Switching a tournament to "team" links its teams; back to "draft" unlinks them.
CREATE OR REPLACE FUNCTION blst_tournament_format() RETURNS trigger AS $$
BEGIN
  IF NEW.format IS DISTINCT FROM OLD.format THEN
    IF NEW.format = 'team' THEN
      UPDATE teams SET club_id = NULL WHERE tournament_id = NEW.id AND club_id IS NULL; -- fires blst_teams_club
    ELSE
      UPDATE teams SET club_id = NULL WHERE tournament_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER tournaments_format AFTER UPDATE OF format ON tournaments FOR EACH ROW EXECUTE FUNCTION blst_tournament_format();

-- Imported stat lines whose team name is a club join it.
CREATE OR REPLACE FUNCTION blst_history_club() RETURNS trigger AS $$
BEGIN
  IF NEW.club_id IS NULL AND NEW.team_name IS NOT NULL THEN
    SELECT id INTO NEW.club_id FROM clubs WHERE org_id = NEW.org_id AND name_key = blst_team_key(NEW.team_name);
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER historical_stats_club BEFORE INSERT OR UPDATE OF team_name ON historical_stats FOR EACH ROW EXECUTE FUNCTION blst_history_club();

-- "These two players are different people": hides the suggestion.
CREATE TABLE player_identity_dismissals (
  org_id     INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  player_a   INTEGER NOT NULL,
  player_b   INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, player_a, player_b),
  CHECK (player_a < player_b),
  FOREIGN KEY (org_id, player_a) REFERENCES players (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, player_b) REFERENCES players (org_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['clubs', 'player_identity_dismissals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (blst_all_orgs() OR org_id = blst_org()) WITH CHECK (blst_all_orgs() OR org_id = blst_org())', t);
  END LOOP;
END $$;

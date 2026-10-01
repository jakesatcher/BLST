-- Registrations: one row per player per tournament, each with its own
-- human-readable registration code (e.g. FALL26-0042). The player row is
-- the person across tournaments; matching on registration links returning
-- players to their existing record (history, earlier tournaments).

ALTER TABLE players ADD COLUMN player_code TEXT UNIQUE;
ALTER TABLE players ADD COLUMN leagueapps_user_id BIGINT UNIQUE;
ALTER TABLE players ADD COLUMN birth_date DATE;
ALTER TABLE players ADD COLUMN name_key TEXT;
UPDATE players SET player_code = 'BLP-' || lpad(id::text, 6, '0');
CREATE INDEX players_name_key_idx ON players (name_key);

ALTER TABLE tournaments ADD COLUMN registration_prefix TEXT UNIQUE;
ALTER TABLE tournaments ADD COLUMN registration_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN leagueapps_program_ids BIGINT[] NOT NULL DEFAULT '{}';

CREATE TABLE tournament_registrations (
  id                         SERIAL PRIMARY KEY,
  tournament_id              INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id                  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  registration_code          TEXT NOT NULL UNIQUE,
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waitlist', 'cancelled')),
  source                     TEXT NOT NULL CHECK (source IN ('leagueapps', 'manual', 'csv')),
  leagueapps_registration_id BIGINT UNIQUE,
  leagueapps_program_id      BIGINT,
  program_name               TEXT,
  match_method               TEXT NOT NULL,
  needs_review               BOOLEAN NOT NULL DEFAULT FALSE,
  review_note                TEXT,
  prior_tournaments          INTEGER NOT NULL DEFAULT 0,
  has_history                BOOLEAN NOT NULL DEFAULT FALSE,
  registered_at              TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, player_id)
);
CREATE INDEX tournament_registrations_player_idx ON tournament_registrations (player_id);

-- Incremental sync position for paginated exports (LeagueApps cursor).
CREATE TABLE sync_state (
  source       TEXT PRIMARY KEY,
  last_updated BIGINT NOT NULL DEFAULT 0,
  last_id      BIGINT NOT NULL DEFAULT 0,
  last_run_at  TIMESTAMPTZ,
  last_result  JSONB
);

-- LeagueApps programs seen in registrations, so an admin can pick which
-- program(s) feed which tournament.
CREATE TABLE leagueapps_programs (
  program_id    BIGINT PRIMARY KEY,
  name          TEXT,
  registrations INTEGER NOT NULL DEFAULT 0,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE integration_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

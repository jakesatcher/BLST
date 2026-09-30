-- BLST core schema.
--
-- Stats are never stored as running totals: every number shown anywhere
-- (scores, player lines, standings) is derived on read from game_events,
-- so a corrected or voided event can never leave a stale total behind.
-- The one exception is games.home_score/away_score, a cache refreshed
-- after every event write so schedule lists don't need to aggregate.

CREATE TABLE tournaments (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  season            TEXT,
  location          TEXT,
  start_date        DATE,
  end_date          DATE,
  num_teams         INTEGER NOT NULL DEFAULT 4 CHECK (num_teams BETWEEN 2 AND 64),
  periods           INTEGER NOT NULL DEFAULT 3 CHECK (periods BETWEEN 1 AND 4),
  period_length_sec INTEGER NOT NULL DEFAULT 1200 CHECK (period_length_sec > 0),
  ot_length_sec     INTEGER NOT NULL DEFAULT 300 CHECK (ot_length_sec >= 0),
  skaters_per_side  INTEGER NOT NULL DEFAULT 5 CHECK (skaters_per_side BETWEEN 3 AND 6),
  allow_ties        BOOLEAN NOT NULL DEFAULT FALSE,
  points_win        INTEGER NOT NULL DEFAULT 2,
  points_otl        INTEGER NOT NULL DEFAULT 1,
  points_tie        INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'completed')),
  factions_event_id TEXT,
  factions_points   JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id              SERIAL PRIMARY KEY,
  tournament_id   INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  short_name      TEXT,
  color           TEXT,
  seed            INTEGER,
  final_placement INTEGER,
  external_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, name)
);
CREATE INDEX teams_tournament_idx ON teams (tournament_id);

-- email and factions_player_id are private (the Factions player id is a
-- reversible encoding of the email) and are only ever returned to admins.
CREATE TABLE players (
  id                 SERIAL PRIMARY KEY,
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL,
  email              TEXT UNIQUE,
  position           TEXT CHECK (position IN ('C', 'LW', 'RW', 'F', 'D', 'G')),
  shoots             TEXT CHECK (shoots IN ('L', 'R')),
  preferred_number   INTEGER CHECK (preferred_number BETWEEN 0 AND 99),
  external_id        TEXT UNIQUE,
  factions_player_id TEXT UNIQUE,
  factions_order     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX players_name_idx ON players (lower(last_name), lower(first_name));

-- A player is on at most one team per tournament; moving them updates this
-- row and appends to roster_moves. Games snapshot the roster into
-- game_rosters, so stats from before a move stay credited to the old team.
CREATE TABLE roster_entries (
  id            SERIAL PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  jersey_number INTEGER CHECK (jersey_number BETWEEN 0 AND 99),
  position      TEXT CHECK (position IN ('C', 'LW', 'RW', 'F', 'D', 'G')),
  role          TEXT CHECK (role IN ('C', 'A')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, player_id)
);
CREATE UNIQUE INDEX roster_team_number_uniq ON roster_entries (team_id, jersey_number) WHERE jersey_number IS NOT NULL;

CREATE TABLE roster_moves (
  id            SERIAL PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  from_team_id  INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  to_team_id    INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  jersey_number INTEGER,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clock model: while running, remaining = clock_remaining_ms - (now - clock_started_at).
-- Clients get server_now with every snapshot and tick locally, so nothing
-- has to be broadcast every second.
CREATE TABLE games (
  id                 SERIAL PRIMARY KEY,
  tournament_id      INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  home_team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  scheduled_at       TIMESTAMPTZ,
  venue              TEXT,
  game_type          TEXT NOT NULL DEFAULT 'pool' CHECK (game_type IN ('pool', 'playoff', 'final', 'exhibition')),
  status             TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'intermission', 'final')),
  period             INTEGER NOT NULL DEFAULT 1,
  clock_running      BOOLEAN NOT NULL DEFAULT FALSE,
  clock_remaining_ms INTEGER NOT NULL DEFAULT 0,
  clock_started_at   TIMESTAMPTZ,
  home_goalie_id     INTEGER REFERENCES players(id) ON DELETE SET NULL,
  away_goalie_id     INTEGER REFERENCES players(id) ON DELETE SET NULL,
  home_score         INTEGER NOT NULL DEFAULT 0,
  away_score         INTEGER NOT NULL DEFAULT 0,
  decision           TEXT CHECK (decision IN ('REG', 'OT', 'SO')),
  final_elapsed_sec  INTEGER,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (home_team_id <> away_team_id)
);
CREATE INDEX games_tournament_idx ON games (tournament_id, scheduled_at);

CREATE TABLE game_rosters (
  game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  jersey_number INTEGER,
  position      TEXT,
  dressed       BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (game_id, player_id)
);

-- One row per thing that happened. Field meaning by type:
--   goal / penalty_shot / shootout_attempt: player = shooter, goalie = goalie faced (NULL = empty net)
--   shot / missed_shot: player = shooter, goalie = goalie faced (shot only)
--   blocked_shot: player = blocker (team_id = blocker's team), secondary = shooter
--   penalty: player = offender (NULL for bench minors), secondary = drew the penalty
--   faceoff: player = winner (team_id = winner's team), secondary = loser
--   hit: player = hitter, secondary = player hit
--   giveaway / takeaway: player
--   goalie_change: goalie = goalie now in net for team_id (NULL = net empty)
CREATE TABLE game_events (
  id                  SERIAL PRIMARY KEY,
  game_id             INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN (
                        'goal', 'shot', 'missed_shot', 'blocked_shot', 'penalty', 'faceoff', 'hit',
                        'giveaway', 'takeaway', 'goalie_change', 'penalty_shot', 'shootout_attempt',
                        'timeout', 'note')),
  team_id             INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  period              INTEGER NOT NULL CHECK (period >= 1),
  elapsed_sec         INTEGER NOT NULL CHECK (elapsed_sec >= 0),
  player_id           INTEGER REFERENCES players(id) ON DELETE SET NULL,
  assist1_id          INTEGER REFERENCES players(id) ON DELETE SET NULL,
  assist2_id          INTEGER REFERENCES players(id) ON DELETE SET NULL,
  secondary_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  goalie_id           INTEGER REFERENCES players(id) ON DELETE SET NULL,
  strength            TEXT CHECK (strength IN ('EV', 'PP', 'SH', 'PS')),
  empty_net           BOOLEAN NOT NULL DEFAULT FALSE,
  penalty_minutes     INTEGER CHECK (penalty_minutes >= 0),
  penalty_severity    TEXT CHECK (penalty_severity IN (
                        'minor', 'bench_minor', 'double_minor', 'major', 'misconduct', 'game_misconduct', 'match')),
  infraction          TEXT,
  coincidental        BOOLEAN NOT NULL DEFAULT FALSE,
  result              TEXT CHECK (result IN ('goal', 'save', 'miss')),
  on_ice_home         INTEGER[],
  on_ice_away         INTEGER[],
  notes               TEXT,
  voided              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX game_events_game_idx ON game_events (game_id, period, elapsed_sec, id);

-- Imported prior-season / prior-event stat lines. Kept separate from live
-- events (they have no play-by-play) and summed into career totals on read.
CREATE TABLE historical_stats (
  id             SERIAL PRIMARY KEY,
  player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season         TEXT,
  event_name     TEXT,
  team_name      TEXT,
  gp             INTEGER NOT NULL DEFAULT 0,
  goals          INTEGER NOT NULL DEFAULT 0,
  assists        INTEGER NOT NULL DEFAULT 0,
  pim            INTEGER NOT NULL DEFAULT 0,
  plus_minus     INTEGER NOT NULL DEFAULT 0,
  ppg            INTEGER NOT NULL DEFAULT 0,
  ppa            INTEGER NOT NULL DEFAULT 0,
  shg            INTEGER NOT NULL DEFAULT 0,
  sha            INTEGER NOT NULL DEFAULT 0,
  gwg            INTEGER NOT NULL DEFAULT 0,
  shots          INTEGER NOT NULL DEFAULT 0,
  hits           INTEGER NOT NULL DEFAULT 0,
  blocks         INTEGER NOT NULL DEFAULT 0,
  fow            INTEGER NOT NULL DEFAULT 0,
  fol            INTEGER NOT NULL DEFAULT 0,
  goalie_gp      INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  ot_losses      INTEGER NOT NULL DEFAULT 0,
  ties           INTEGER NOT NULL DEFAULT 0,
  shots_against  INTEGER NOT NULL DEFAULT 0,
  goals_against  INTEGER NOT NULL DEFAULT 0,
  shutouts       INTEGER NOT NULL DEFAULT 0,
  toi_sec        INTEGER NOT NULL DEFAULT 0,
  source         TEXT,
  import_batch   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX historical_stats_player_idx ON historical_stats (player_id);

CREATE TABLE api_keys (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'scorekeeper', 'readonly')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE TABLE webhooks (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL,
  events     TEXT[] NOT NULL DEFAULT '{*}',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            SERIAL PRIMARY KEY,
  webhook_id    INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at  TIMESTAMPTZ
);
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries (webhook_id, created_at DESC);

CREATE TABLE factions_sync_log (
  id            SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  ok            BOOLEAN NOT NULL,
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

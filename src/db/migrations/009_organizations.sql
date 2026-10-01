-- Organizations: BLST becomes a platform. Each organization lives at
-- <slug>.<APP_DOMAIN> with its own tournaments, players, keys, settings and
-- (if it turns the feature on) its own Factions. Existing data becomes the
-- first organization, "blpa".
--
-- Isolation is enforced by Postgres row-level security, not only by queries:
-- every tenant table has org_id, the app sets app.org_id on each connection
-- (src/db/index.js), and policies only show and accept that organization's
-- rows. "*" means every organization (platform jobs); unset means none.

CREATE FUNCTION blst_org() RETURNS INTEGER LANGUAGE sql STABLE AS
$$ SELECT nullif(nullif(current_setting('app.org_id', true), ''), '*')::int $$;
CREATE FUNCTION blst_all_orgs() RETURNS BOOLEAN LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.org_id', true), '') = '*' $$;

CREATE TABLE organizations (
  id               SERIAL PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  factions_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  requested_by     INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  request_note     TEXT,
  decided_by       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO organizations (id, slug, name, status, factions_enabled) VALUES (1, 'blpa', 'BLPA', 'active', TRUE);
SELECT setval('organizations_id_seq', 1);

-- ---------------------------------------------------------------------------
-- org_id on every tenant table. Existing rows belong to organization 1.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tournaments', 'teams', 'players', 'roster_entries', 'roster_moves', 'games', 'game_rosters', 'game_events',
    'historical_stats', 'team_logos', 'tournament_logos', 'venue_streams', 'tournament_registrations',
    'api_keys', 'webhooks', 'webhook_deliveries', 'leagueapps_programs', 'sync_state',
    'faction_members', 'faction_events', 'faction_participation', 'faction_achievements'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN org_id INTEGER', t);
    EXECUTE format('UPDATE %I SET org_id = 1', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL, ALTER COLUMN org_id SET DEFAULT blst_org()', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE', t, t || '_org_fk');
    EXECUTE format('CREATE INDEX %I ON %I (org_id)', t || '_org_idx', t);
  END LOOP;
END $$;

-- The audit log keeps platform events too (org_id NULL).
ALTER TABLE audit_log ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
UPDATE audit_log SET org_id = 1;
ALTER TABLE audit_log ALTER COLUMN org_id SET DEFAULT blst_org();
CREATE INDEX audit_log_org_idx ON audit_log (org_id, id DESC);

-- Per-organization keys: sync cursors and Factions members.
ALTER TABLE sync_state DROP CONSTRAINT sync_state_pkey, ADD PRIMARY KEY (org_id, source);

-- ---------------------------------------------------------------------------
-- Factions: each organization designs its own (replaces the fixed six).

CREATE TABLE factions (
  org_id     INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  emoji      TEXT CHECK (emoji IS NULL OR length(emoji) <= 16),
  color      TEXT NOT NULL DEFAULT '#64748b' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  -- Hash bucket (0..n-1): fixed once members exist; new factions are appended.
  position   INTEGER NOT NULL CHECK (position >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, slug),
  UNIQUE (org_id, position),
  UNIQUE (org_id, name)
);
INSERT INTO factions (org_id, slug, name, emoji, color, position)
SELECT 1, slug, name, CASE slug WHEN 'varghona' THEN '🐺' WHEN 'tuskarium' THEN '🐘' WHEN 'aetherwing' THEN '🦅'
                                WHEN 'serikon' THEN '🐍' WHEN 'thalkara' THEN '🦑' WHEN 'ursonne' THEN '🐻' END,
       CASE slug WHEN 'varghona' THEN '#64748b' WHEN 'tuskarium' THEN '#78716c' WHEN 'aetherwing' THEN '#2563eb'
                 WHEN 'serikon' THEN '#16a34a' WHEN 'thalkara' THEN '#7c3aed' WHEN 'ursonne' THEN '#d97706' END,
       position
  FROM faction_orders;

-- Members are per organization: the same email is a separate member (and
-- may be in a different faction) in each organization.
ALTER TABLE faction_participation DROP CONSTRAINT faction_participation_member_id_fkey;
ALTER TABLE faction_achievements DROP CONSTRAINT faction_achievements_member_id_fkey;
ALTER TABLE faction_members DROP CONSTRAINT faction_members_order_slug_fkey;
ALTER TABLE faction_members DROP CONSTRAINT faction_members_pkey, ADD PRIMARY KEY (org_id, id);
ALTER TABLE faction_members ADD CONSTRAINT faction_members_faction_fk
  FOREIGN KEY (org_id, order_slug) REFERENCES factions(org_id, slug);
DROP TABLE faction_orders;

CREATE OR REPLACE FUNCTION blst_faction_order(org INTEGER, e TEXT) RETURNS TEXT LANGUAGE sql STABLE AS
$$ SELECT f.slug FROM factions f,
     (SELECT sha256(convert_to(blst_norm_email(e), 'UTF8')) AS d) h
    WHERE f.org_id = org
      AND f.position = ((get_byte(h.d, 0)::bigint << 24) | (get_byte(h.d, 1)::bigint << 16)
                      | (get_byte(h.d, 2)::bigint << 8) | get_byte(h.d, 3)::bigint)
                      % (SELECT count(*) FROM factions WHERE org_id = org) $$;
DROP FUNCTION blst_faction_order(TEXT);

-- Players join their organization's factions only when it uses Factions.
CREATE OR REPLACE FUNCTION blst_player_faction_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; slug TEXT;
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    NEW.factions_player_id := NULL;
    IF TG_OP = 'UPDATE' THEN NEW.factions_order := NULL; END IF;
    RETURN NEW;
  END IF;
  IF NOT coalesce((SELECT factions_enabled FROM organizations WHERE id = NEW.org_id), FALSE) THEN
    RETURN NEW;
  END IF;
  slug := blst_faction_order(NEW.org_id, NEW.email);
  IF slug IS NULL THEN RETURN NEW; END IF; -- no factions designed yet
  INSERT INTO faction_members (org_id, id, email, display_name, order_slug, source)
  VALUES (NEW.org_id, blst_faction_member_id(NEW.email), blst_norm_email(NEW.email),
          btrim(NEW.first_name || ' ' || NEW.last_name), slug, 'blst')
  ON CONFLICT DO NOTHING;
  SELECT id, order_slug INTO m FROM faction_members WHERE org_id = NEW.org_id AND email = blst_norm_email(NEW.email);
  NEW.factions_player_id := m.id;
  NEW.factions_order := m.order_slug;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Uniqueness is per organization (two leagues can each have jane@…), and
-- scoping every rule by org_id also means a duplicate-key error can never
-- reveal another organization's rows. Exceptions are globally random values.

DO $$
DECLARE r RECORD; cols TEXT;
BEGIN
  FOR r IN
    SELECT con.conname, con.conrelid::regclass::text AS tbl, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
     WHERE con.contype = 'u' AND con.connamespace = 'public'::regnamespace
       AND con.conrelid::regclass::text IN (
         'tournaments', 'teams', 'players', 'roster_entries', 'tournament_registrations', 'faction_members',
         'faction_events', 'faction_participation', 'faction_achievements')
       AND pg_get_constraintdef(con.oid) NOT LIKE '%org_id%'
       AND con.conname NOT IN ('players_player_code_key')
  LOOP
    cols := substring(r.def FROM 'UNIQUE \((.*)\)');
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (org_id, %s)', r.tbl, r.conname, cols);
  END LOOP;
END $$;
ALTER TABLE game_rosters DROP CONSTRAINT game_rosters_pkey, ADD PRIMARY KEY (org_id, game_id, player_id);
ALTER TABLE team_logos DROP CONSTRAINT team_logos_pkey, ADD PRIMARY KEY (org_id, team_id);
ALTER TABLE tournament_logos DROP CONSTRAINT tournament_logos_pkey, ADD PRIMARY KEY (org_id, tournament_id);
ALTER TABLE leagueapps_programs DROP CONSTRAINT leagueapps_programs_pkey, ADD PRIMARY KEY (org_id, program_id);
DROP INDEX venue_streams_venue_uniq;
CREATE UNIQUE INDEX venue_streams_venue_uniq ON venue_streams (org_id, tournament_id, lower(venue));
DROP INDEX roster_team_number_uniq;
CREATE UNIQUE INDEX roster_team_number_uniq ON roster_entries (org_id, team_id, jersey_number) WHERE jersey_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- References between tenant tables must stay inside one organization: every
-- foreign key gets org_id in it (so even a guessed id from another
-- organization can't be linked).

DO $$
DECLARE t TEXT; r RECORD; def TEXT; col TEXT; ref TEXT; refcol TEXT; tail TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tournaments', 'teams', 'players', 'games', 'webhooks', 'faction_events'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (org_id, id)', t, t || '_org_id_key');
  END LOOP;
  FOR r IN
    SELECT con.conname, con.conrelid::regclass::text AS tbl, con.confrelid::regclass::text AS reftbl, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
     WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace
       AND con.confrelid::regclass::text IN ('tournaments', 'teams', 'players', 'games', 'webhooks', 'faction_events')
       AND array_length(con.conkey, 1) = 1
       AND EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'public' AND c.table_name = con.conrelid::regclass::text AND c.column_name = 'org_id')
  LOOP
    col := substring(r.def FROM '^FOREIGN KEY \(([a-z0-9_]+)\)');
    ref := substring(r.def FROM 'REFERENCES ([a-z0-9_]+)\(');
    refcol := substring(r.def FROM 'REFERENCES [a-z0-9_]+\(([a-z0-9_]+)\)');
    tail := coalesce(substring(r.def FROM 'REFERENCES [a-z0-9_]+\([a-z0-9_]+\)(.*)$'), '');
    -- SET NULL must only clear the referencing column, never org_id.
    tail := replace(tail, 'ON DELETE SET NULL', format('ON DELETE SET NULL (%I)', col));
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id, %I) REFERENCES %I(org_id, %I)%s',
                   r.tbl, r.conname, col, ref, refcol, tail);
  END LOOP;
END $$;
ALTER TABLE faction_participation ADD CONSTRAINT faction_participation_member_fk
  FOREIGN KEY (org_id, member_id) REFERENCES faction_members(org_id, id) ON DELETE CASCADE;
ALTER TABLE faction_achievements ADD CONSTRAINT faction_achievements_member_fk
  FOREIGN KEY (org_id, member_id) REFERENCES faction_members(org_id, id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- People: accounts stay global (one sign-in); access is per organization.

CREATE TABLE org_members (
  org_id        INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'scorekeeper')),
  tournament_id INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id),
  FOREIGN KEY (org_id, tournament_id) REFERENCES tournaments(org_id, id) ON DELETE SET NULL (tournament_id)
);
CREATE INDEX org_members_account_idx ON org_members (account_id);

-- Access granted before the person has an account; claimed at sign-in.
CREATE TABLE org_invites (
  org_id        INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL CHECK (email = lower(email)),
  role          TEXT NOT NULL CHECK (role IN ('admin', 'scorekeeper')),
  tournament_id INTEGER,
  invited_by    INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, email),
  FOREIGN KEY (org_id, tournament_id) REFERENCES tournaments(org_id, id) ON DELETE SET NULL (tournament_id)
);

-- Existing accounts: admins become platform admins and admins of BLPA;
-- scorekeepers keep their access (and tournament limit) in BLPA.
INSERT INTO org_members (org_id, account_id, role, tournament_id)
SELECT 1, id, role, CASE WHEN role = 'scorekeeper' THEN tournament_id END
  FROM accounts WHERE role IN ('admin', 'scorekeeper');
UPDATE accounts SET role = 'user' WHERE role = 'scorekeeper';
ALTER TABLE accounts DROP COLUMN tournament_id;
ALTER TABLE accounts DROP CONSTRAINT accounts_role_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_role_check CHECK (role IN ('user', 'admin'));
COMMENT ON COLUMN accounts.role IS 'admin = platform (global) admin; organization roles live in org_members';

-- ---------------------------------------------------------------------------
-- Row-level security on every tenant table.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tournaments', 'teams', 'players', 'roster_entries', 'roster_moves', 'games', 'game_rosters', 'game_events',
    'historical_stats', 'team_logos', 'tournament_logos', 'venue_streams', 'tournament_registrations',
    'api_keys', 'webhooks', 'webhook_deliveries', 'leagueapps_programs', 'sync_state',
    'factions', 'faction_members', 'faction_events', 'faction_participation', 'faction_achievements',
    'org_members', 'org_invites'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (blst_all_orgs() OR org_id = blst_org()) WITH CHECK (blst_all_orgs() OR org_id = blst_org())', t);
  END LOOP;
END $$;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_log USING (blst_all_orgs() OR org_id = blst_org()) WITH CHECK (true);

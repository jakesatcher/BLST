-- BLPA Factions (Original Draft Society), merged into BLST.
--
-- Every person with an email belongs to one of six Orders for life. The
-- Order comes from the email: SHA-256 of the trimmed, lowercased email, the
-- first 4 bytes as an unsigned big-endian integer, mod 6, indexed into the
-- fixed list below. The member id is the base64url of the same email (a
-- reversible encoding: treat it like the email itself). Both formulas are
-- identical to the standalone Factions app, so existing ids and Orders carry
-- over unchanged.

-- Order of this list is load-bearing (position = hash bucket): append only.
CREATE TABLE faction_orders (
  slug     TEXT PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  animal   TEXT NOT NULL,
  position INTEGER NOT NULL UNIQUE
);
INSERT INTO faction_orders (slug, name, animal, position) VALUES
  ('varghona', 'Varghona', 'wolf', 0),
  ('tuskarium', 'Tuskarium', 'elephant', 1),
  ('aetherwing', 'Aetherwing', 'eagle', 2),
  ('serikon', 'Serikon', 'snake', 3),
  ('thalkara', 'Thalkara', 'kraken', 4),
  ('ursonne', 'Ursonne', 'bear', 5);

CREATE FUNCTION blst_norm_email(e TEXT) RETURNS TEXT LANGUAGE sql STABLE AS
$$ SELECT lower(btrim(e)) $$;

CREATE FUNCTION blst_faction_member_id(e TEXT) RETURNS TEXT LANGUAGE sql STABLE AS
$$ SELECT translate(rtrim(replace(encode(convert_to(blst_norm_email(e), 'UTF8'), 'base64'), E'\n', ''), '='), '+/', '-_') $$;

CREATE FUNCTION blst_faction_order(e TEXT) RETURNS TEXT LANGUAGE sql STABLE AS
$$ SELECT o.slug FROM faction_orders o,
     (SELECT sha256(convert_to(blst_norm_email(e), 'UTF8')) AS d) h
    WHERE o.position = ((get_byte(h.d, 0)::bigint << 24) | (get_byte(h.d, 1)::bigint << 16)
                      | (get_byte(h.d, 2)::bigint << 8) | get_byte(h.d, 3)::bigint) % 6 $$;

-- One row per person. bonus_points are manual awards (the standalone app's
-- "points"); event points live in faction_participation.
CREATE TABLE faction_members (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  display_name       TEXT,
  leagueapps_user_id TEXT UNIQUE,
  order_slug         TEXT NOT NULL REFERENCES faction_orders(slug),
  bonus_points       INTEGER NOT NULL DEFAULT 0,
  degree             INTEGER NOT NULL DEFAULT 1,
  source             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX faction_members_order_idx ON faction_members (order_slug);
CREATE INDEX faction_members_name_idx ON faction_members (lower(display_name));

-- An Order is for life: no UPDATE can move a member, or change the email
-- their id and Order were derived from. Only the one-time import from a
-- standalone Factions database may set an Order explicitly.
CREATE FUNCTION blst_faction_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'a Factions member''s email and id can''t change';
  END IF;
  IF NEW.order_slug IS DISTINCT FROM OLD.order_slug
     AND coalesce(current_setting('blst.factions_import', true), '') <> 'on' THEN
    RAISE EXCEPTION 'a Factions member''s Order is permanent';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER faction_members_guard BEFORE UPDATE ON faction_members
  FOR EACH ROW EXECUTE FUNCTION blst_faction_member_guard();

CREATE TABLE faction_events (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                TEXT NOT NULL,
  leagueapps_event_id TEXT UNIQUE,
  start_date          DATE,
  end_date            DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE faction_participation (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  member_id     TEXT NOT NULL REFERENCES faction_members(id) ON DELETE CASCADE,
  event_id      TEXT NOT NULL REFERENCES faction_events(id) ON DELETE CASCADE,
  points_earned INTEGER NOT NULL DEFAULT 0,
  placement     INTEGER,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB,
  UNIQUE (member_id, event_id)
);
CREATE INDEX faction_participation_event_idx ON faction_participation (event_id);

CREATE TABLE faction_achievements (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  member_id  TEXT NOT NULL REFERENCES faction_members(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  title      TEXT NOT NULL,
  event_id   TEXT REFERENCES faction_events(id) ON DELETE SET NULL,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, code)
);
CREATE INDEX faction_achievements_event_idx ON faction_achievements (event_id);

-- Any BLST player with an email is a Factions member: created on first
-- sight (never reassigned), and the player row carries the member id
-- (private) and Order (public).
CREATE FUNCTION blst_player_faction_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD;
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    NEW.factions_player_id := NULL;
    IF TG_OP = 'UPDATE' THEN NEW.factions_order := NULL; END IF;
    RETURN NEW;
  END IF;
  INSERT INTO faction_members (id, email, display_name, order_slug, source)
  VALUES (blst_faction_member_id(NEW.email), blst_norm_email(NEW.email),
          btrim(NEW.first_name || ' ' || NEW.last_name), blst_faction_order(NEW.email), 'blst')
  ON CONFLICT DO NOTHING;
  SELECT id, order_slug INTO m FROM faction_members WHERE email = blst_norm_email(NEW.email);
  NEW.factions_player_id := m.id;
  NEW.factions_order := m.order_slug;
  RETURN NEW;
END $$;
CREATE TRIGGER players_faction_link BEFORE INSERT OR UPDATE OF email ON players
  FOR EACH ROW EXECUTE FUNCTION blst_player_faction_link();

-- Existing players: keep any Order already recorded from the standalone
-- app (it was assigned there first), otherwise derive it.
INSERT INTO faction_members (id, email, display_name, order_slug, source)
SELECT DISTINCT ON (blst_norm_email(p.email))
       blst_faction_member_id(p.email), blst_norm_email(p.email), btrim(p.first_name || ' ' || p.last_name),
       CASE WHEN p.factions_order IN (SELECT slug FROM faction_orders) THEN p.factions_order ELSE blst_faction_order(p.email) END,
       'blst'
  FROM players p WHERE p.email IS NOT NULL AND btrim(p.email) <> ''
  ORDER BY blst_norm_email(p.email), p.id
ON CONFLICT DO NOTHING;
UPDATE players SET email = email WHERE email IS NOT NULL;

-- The connection to a separate Factions server is gone; its log goes too.
DROP TABLE factions_sync_log;

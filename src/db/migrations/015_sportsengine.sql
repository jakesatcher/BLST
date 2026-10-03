-- SportsEngine integration (per organization): an OAuth client for the
-- SportsEngine API, links between SportsEngine ids and BLST records, and a
-- sync log.

CREATE TABLE sportsengine_connections (
  org_id             INTEGER PRIMARY KEY DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  client_id          TEXT NOT NULL,
  client_secret_enc  TEXT NOT NULL,          -- AES-256-GCM, key from AUTH_SECRET
  se_organization_id TEXT NOT NULL,          -- the SportsEngine organization to read from
  se_organization_name TEXT,
  auto_push          BOOLEAN NOT NULL DEFAULT TRUE, -- send final scores to SportsEngine
  access_token_enc   TEXT,
  token_expires_at   TIMESTAMPTZ,
  last_error         TEXT,
  last_sync_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sportsengine_links (
  org_id     INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('team', 'player', 'game')),
  se_id      TEXT NOT NULL,
  blst_id    INTEGER NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, se_id),
  UNIQUE (org_id, kind, blst_id)
);

CREATE TABLE sportsengine_sync_log (
  id      BIGSERIAL PRIMARY KEY,
  org_id  INTEGER NOT NULL DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  action  TEXT NOT NULL,
  ok      BOOLEAN NOT NULL,
  message TEXT NOT NULL,
  details JSONB
);
CREATE INDEX sportsengine_sync_log_idx ON sportsengine_sync_log (org_id, at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sportsengine_connections', 'sportsengine_links', 'sportsengine_sync_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (blst_all_orgs() OR org_id = blst_org()) WITH CHECK (blst_all_orgs() OR org_id = blst_org())', t);
  END LOOP;
END $$;

-- League onboarding and flexible history imports:
--   * each organization connects its own LeagueApps account (credentials
--     encrypted; the server-wide LEAGUEAPPS_* settings still work for one);
--   * games whose final score came from another system (no play-by-play)
--     count in standings with their stored score;
--   * an organization's onboarding progress.

CREATE TABLE leagueapps_connections (
  org_id          INTEGER PRIMARY KEY DEFAULT blst_org() REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,      -- PEM, AES-256-GCM with a key from AUTH_SECRET
  field_map       JSONB NOT NULL DEFAULT '{}',
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE leagueapps_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE leagueapps_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON leagueapps_connections USING (blst_all_orgs() OR org_id = blst_org()) WITH CHECK (blst_all_orgs() OR org_id = blst_org());

ALTER TABLE games ADD COLUMN result_only BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN games.result_only IS 'final score imported from another system (SportsEngine, a results file); no play-by-play';

ALTER TABLE organizations ADD COLUMN onboarding JSONB NOT NULL DEFAULT '{}';
-- Organizations that already exist are set up.
UPDATE organizations SET onboarding = '{"completed": true}';

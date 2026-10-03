-- A league's stats are only for its people. Besides admins and
-- scorekeepers, an admin can add "viewers" (see everything, change nothing).
-- Players whose account email matches a player in the league can see it
-- without being added (checked at sign-in, see middleware/auth.js).
ALTER TABLE org_members DROP CONSTRAINT org_members_role_check;
ALTER TABLE org_members ADD CONSTRAINT org_members_role_check CHECK (role IN ('admin', 'scorekeeper', 'viewer'));
ALTER TABLE org_invites DROP CONSTRAINT org_invites_role_check;
ALTER TABLE org_invites ADD CONSTRAINT org_invites_role_check CHECK (role IN ('admin', 'scorekeeper', 'viewer'));
CREATE INDEX IF NOT EXISTS players_email_lower_idx ON players (org_id, lower(email));

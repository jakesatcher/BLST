-- Awards an organization shows on its stats page (and on the winner's
-- player page), e.g. BLPA's "Heel of the Year". Edited under Admin →
-- Organization. Each: { title, name, note? }; the player is found by name.
ALTER TABLE organizations ADD COLUMN awards JSONB NOT NULL DEFAULT '[]';
UPDATE organizations SET awards = '[{"title": "Heel of the Year", "name": "Nick Fleehart"}]' WHERE slug = 'blpa';

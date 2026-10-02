-- Tournament IDs. A tournament with a city, a type (the organization's
-- event series, e.g. BLPA's DEX, Bash and Outlaw) and a year has an ID like
-- PITTSBURGH-DEX-2025. Historical uploads must name one, and a tournament's
-- stats can only be uploaded once (re-uploading replaces them on purpose).

ALTER TABLE organizations ADD COLUMN tournament_types TEXT[] NOT NULL DEFAULT '{}';
UPDATE organizations SET tournament_types = '{DEX,Bash,Outlaw}' WHERE id = 1;

ALTER TABLE tournaments ADD COLUMN series TEXT CHECK (series IS NULL OR length(series) BETWEEN 1 AND 30);
ALTER TABLE tournaments ADD COLUMN year INTEGER CHECK (year IS NULL OR year BETWEEN 1950 AND 2100);
ALTER TABLE tournaments ADD COLUMN code TEXT GENERATED ALWAYS AS (
  CASE WHEN regexp_replace(coalesce(location, ''), '[^A-Za-z0-9]', '', 'g') <> ''
        AND regexp_replace(coalesce(series, ''), '[^A-Za-z0-9]', '', 'g') <> '' AND year IS NOT NULL
       THEN upper(regexp_replace(location, '[^A-Za-z0-9]', '', 'g')) || '-' || upper(regexp_replace(series, '[^A-Za-z0-9]', '', 'g')) || '-' || year::text
  END) STORED;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_code_uniq UNIQUE (org_id, code);

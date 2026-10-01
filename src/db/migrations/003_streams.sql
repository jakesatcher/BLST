-- Video for the watch page. A rink (games.venue) gets a default stream per
-- tournament; a game can override it. BLST never proxies or stores video:
-- viewers either play an embeddable player on the watch page (partner
-- embed, YouTube Live, HLS) or open LiveBarn with their own subscription
-- next to BLST's live scorebug.
CREATE TABLE venue_streams (
  id            SERIAL PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  venue         TEXT NOT NULL,
  livebarn_url  TEXT,
  embed_url     TEXT,
  delay_sec     INTEGER NOT NULL DEFAULT 0 CHECK (delay_sec BETWEEN 0 AND 300),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX venue_streams_venue_uniq ON venue_streams (tournament_id, lower(venue));

ALTER TABLE games ADD COLUMN stream_embed_url TEXT;
ALTER TABLE games ADD COLUMN livebarn_url TEXT;
ALTER TABLE games ADD COLUMN stream_delay_sec INTEGER CHECK (stream_delay_sec BETWEEN 0 AND 300);

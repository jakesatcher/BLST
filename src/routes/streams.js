const { Router } = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const { badRequest, notFound, intParam, optInt, optString } = require("../lib/http");
const { emitDomain } = require("../lib/bus");
const streams = require("../lib/streams");

const router = Router();
const admin = requireRole("admin");

// Rink → stream defaults for a tournament. Public: these are links viewers
// open anyway (no credentials are ever stored).
router.get("/tournaments/:id/streams", async (req, res) => {
  const tid = intParam(req.params.id);
  const saved = await db.many("SELECT * FROM venue_streams WHERE tournament_id = $1 ORDER BY lower(venue)", [tid]);
  // Rinks that have games but no stream yet, so the admin can fill them in.
  const venues = await db.many(
    "SELECT DISTINCT venue FROM games WHERE tournament_id = $1 AND venue IS NOT NULL AND venue <> '' ORDER BY venue",
    [tid],
  );
  const known = new Set(saved.map((s) => s.venue.toLowerCase()));
  res.json({
    streams: saved.map((s) => ({ ...s, kind: streams.embedKind(s.embed_url) })),
    unconfigured_venues: venues.map((v) => v.venue).filter((v) => !known.has(v.toLowerCase())),
  });
});

router.put("/tournaments/:id/streams", admin, async (req, res) => {
  const tid = intParam(req.params.id);
  const venue = optString(req.body.venue, "venue", { max: 80 });
  if (!venue) throw badRequest("venue (rink name, as used on the schedule) is required");
  const embed = streams.normalizeEmbedUrl(req.body.embed_url) ?? null;
  const livebarn = streams.normalizeLinkUrl(req.body.livebarn_url, "LiveBarn link") ?? null;
  if (!embed && !livebarn) throw badRequest("give a LiveBarn link, an embed URL, or both");
  const delay = optInt(req.body.delay_sec, "delay_sec", { min: 0, max: 300 }) ?? (livebarn && !embed ? 20 : 0);
  const row = await db.one(
    `INSERT INTO venue_streams (tournament_id, venue, livebarn_url, embed_url, delay_sec) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tournament_id, lower(venue)) DO UPDATE
       SET venue = EXCLUDED.venue, livebarn_url = EXCLUDED.livebarn_url, embed_url = EXCLUDED.embed_url, delay_sec = EXCLUDED.delay_sec
     RETURNING *`,
    [tid, venue, livebarn, embed, delay],
  );
  emitDomain("tournament.updated", { tournament_id: tid, streams: true });
  res.json({ ...row, kind: streams.embedKind(row.embed_url), livebarn_embed_warning: embed && streams.isLiveBarn(embed) ? "LiveBarn pages normally can't be embedded; use the Check button." : null });
});

router.delete("/tournaments/:id/streams/:streamId", admin, async (req, res) => {
  const r = await db.query("DELETE FROM venue_streams WHERE id = $1 AND tournament_id = $2", [intParam(req.params.streamId, "streamId"), intParam(req.params.id)]);
  if (!r.rowCount) throw notFound("stream");
  res.status(204).end();
});

/** "Can this link be shown inside the watch page?" (headers only). */
router.post("/streams/check", admin, async (req, res) => {
  const url = streams.normalizeEmbedUrl(req.body.url);
  if (!url) throw badRequest("url is required");
  res.json({ url, ...(await streams.checkEmbeddable(url)) });
});

module.exports = router;

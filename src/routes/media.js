const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const { HttpError, intParam, notFound } = require("../lib/http");
const { emitDomain } = require("../lib/bus");
const importer = require("../services/importer");

const router = express.Router();
const admin = requireRole("admin");
const MAX_BYTES = 2 * 1024 * 1024;

// Team and tournament graphics, kept in Postgres so they survive Heroku
// dyno restarts. Clients reference /…/logo?v=<logo_version>; the version
// changes on every upload, so responses can be cached forever.

/** Identifies the image from its first bytes; the Content-Type header isn't trusted. */
function sniffImage(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  const head = buf.toString("utf8", 0, Math.min(buf.length, 1024)).replace(/^﻿/, "").trimStart();
  if ((head.startsWith("<svg") || head.startsWith("<?xml")) && /<svg[\s>]/.test(buf.toString("utf8"))) return "image/svg+xml";
  return null;
}

const OWNERS = {
  teams: { table: "teams", logos: "team_logos", key: "team_id", event: "team.updated", idField: "team_id" },
  tournaments: { table: "tournaments", logos: "tournament_logos", key: "tournament_id", event: "tournament.updated", idField: "tournament_id" },
};

for (const [path, o] of Object.entries(OWNERS)) {
  router.get(`/${path}/:id/logo`, async (req, res) => {
    const row = await db.one(`SELECT content_type, data FROM ${o.logos} WHERE ${o.key} = $1`, [intParam(req.params.id)]);
    if (!row) throw notFound("logo");
    res.set({
      "content-type": row.content_type,
      "cache-control": req.query.v ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      // An SVG opened directly can't run scripts; other sites may embed logos.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    });
    res.send(row.data);
  });

  router.put(`/${path}/:id/logo`, admin, express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
    const id = intParam(req.params.id);
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) throw new HttpError(400, "send the image file as the request body");
    const type = sniffImage(buf);
    if (!type) throw new HttpError(415, "logo must be a PNG, JPEG, GIF, WebP or SVG image");
    const owner = await db.one(`SELECT id, ${path === "teams" ? "tournament_id" : "id AS tournament_id"} FROM ${o.table} WHERE id = $1`, [id]);
    if (!owner) throw notFound(path.slice(0, -1));
    const version = Date.now();
    await db.tx(async (c) => {
      await c.query(
        `INSERT INTO ${o.logos} (${o.key}, content_type, data) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, ${o.key}) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`,
        [id, type, buf],
      );
      await c.query(`UPDATE ${o.table} SET logo_version = $2 WHERE id = $1`, [id, version]);
    });
    emitDomain(o.event, { tournament_id: owner.tournament_id, [o.idField]: id, logo_version: version });
    res.json({ logo_version: version, logo_url: `/api/v1/${path}/${id}/logo?v=${version}`, content_type: type, bytes: buf.length });
  });

  router.delete(`/${path}/:id/logo`, admin, async (req, res) => {
    const id = intParam(req.params.id);
    const owner = await db.one(
      `UPDATE ${o.table} SET logo_version = NULL WHERE id = $1 RETURNING ${path === "teams" ? "tournament_id" : "id AS tournament_id"}`,
      [id],
    );
    if (!owner) throw notFound(path.slice(0, -1));
    await db.query(`DELETE FROM ${o.logos} WHERE ${o.key} = $1`, [id]);
    emitDomain(o.event, { tournament_id: owner.tournament_id, [o.idField]: id, logo_version: null });
    res.status(204).end();
  });
}

/** Rosters in the upload format; ?template=1 gives the blank post-draft template. */
router.get("/tournaments/:id/roster.csv", admin, async (req, res) => {
  const id = intParam(req.params.id);
  const t = await db.one("SELECT name FROM tournaments WHERE id = $1", [id]);
  if (!t) throw notFound("tournament");
  const template = req.query.template === "1" || req.query.template === "true";
  const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  res.set("content-type", "text/csv; charset=utf-8");
  res.set("content-disposition", `attachment; filename="${slug}-${template ? "roster-template" : "rosters"}.csv"`);
  res.send(await importer.rosterCsv(id, { template }));
});

module.exports = router;
module.exports.sniffImage = sniffImage;

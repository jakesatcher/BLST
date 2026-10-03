const { Router } = require("express");
const db = require("../db");
const { requireRole, hasRole } = require("../middleware/auth");
const { badRequest, notFound, intParam, optInt, optEnum, optString, requireFields, buildUpdate } = require("../lib/http");
const { emitDomain } = require("../lib/bus");
const data = require("../services/data");

const router = Router();
const admin = requireRole("admin");
const POSITIONS = ["C", "LW", "RW", "F", "D", "G"];

// Allow-list, so a new private column can't leak by default. Email, birth
// date, LeagueApps id and the Factions member id (a reversible encoding of
// the email) are only ever returned to admins.
// Factions is a separate section, so its data isn't part of player records here.
const PUBLIC_FIELDS = ["id", "first_name", "last_name", "position", "shoots", "preferred_number", "external_id",
  "player_code", "created_at", "updated_at"];
function serialize(p, req) {
  if (hasRole(req, "admin")) return p;
  return Object.fromEntries(PUBLIC_FIELDS.filter((k) => k in p).map((k) => [k, p[k]]));
}

function playerFields(body) {
  const email = optString(body.email, "email", { max: 200 });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("email is not valid");
  return {
    first_name: optString(body.first_name, "first_name", { max: 60 }),
    last_name: optString(body.last_name, "last_name", { max: 60 }),
    email: email === undefined ? undefined : email && email.toLowerCase(),
    position: optEnum(body.position, "position", POSITIONS),
    shoots: optEnum(body.shoots, "shoots", ["L", "R"]),
    preferred_number: optInt(body.preferred_number, "preferred_number", { min: 0, max: 99 }),
    external_id: optString(body.external_id, "external_id", { max: 100 }),
  };
}

router.get("/players", async (req, res) => {
  const q = optString(req.query.q, "q", { max: 100 });
  const limit = optInt(req.query.limit, "limit", { min: 1, max: 500 }) || 100;
  const offset = optInt(req.query.offset, "offset", { min: 0 }) || 0;
  const params = [limit, offset];
  let where = "TRUE";
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where = `(lower(first_name || ' ' || last_name) LIKE $3 OR lower(coalesce(external_id, '')) LIKE $3${hasRole(req, "admin") ? " OR lower(coalesce(email, '')) LIKE $3" : ""})`;
  }
  const rows = await db.many(`SELECT * FROM players WHERE ${where} ORDER BY lower(last_name), lower(first_name), id LIMIT $1 OFFSET $2`, params);
  res.json(rows.map((p) => serialize(p, req)));
});

router.post("/players", admin, async (req, res) => {
  const fields = playerFields(req.body);
  requireFields(fields, ["first_name", "last_name"]);
  const cols = Object.keys(fields).filter((k) => fields[k] !== undefined);
  const player = await db.one(
    `INSERT INTO players (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    cols.map((k) => fields[k]),
  );
  emitDomain("player.created", { player: serialize(player, { auth: { role: null } }) });
  res.status(201).json(player);
});

router.get("/players/:id", async (req, res) => {
  const id = intParam(req.params.id);
  const player = await db.one("SELECT * FROM players WHERE id = $1", [id]);
  if (!player) throw notFound("player");
  const rosters = await db.many(
    `SELECT re.*, t.name AS tournament, tm.name AS team FROM roster_entries re
       JOIN tournaments t ON t.id = re.tournament_id JOIN teams tm ON tm.id = re.team_id
      WHERE re.player_id = $1 ORDER BY t.start_date DESC NULLS LAST`,
    [id],
  );
  res.json({ ...serialize(player, req), rosters });
});

router.get("/players/:id/career", async (req, res) => {
  res.json(await data.playerCareer(intParam(req.params.id)));
});

router.patch("/players/:id", admin, async (req, res) => {
  const upd = buildUpdate(playerFields(req.body), 2);
  if (!upd) throw badRequest("nothing to update");
  const player = await db.one(`UPDATE players SET ${upd.set}, updated_at = now() WHERE id = $1 RETURNING *`, [intParam(req.params.id), ...upd.values]);
  if (!player) throw notFound("player");
  emitDomain("player.updated", { player: serialize(player, { auth: { role: null } }) });
  res.json(player);
});

router.delete("/players/:id", admin, async (req, res) => {
  const id = intParam(req.params.id);
  const used = await db.one("SELECT count(*) AS n FROM game_rosters WHERE player_id = $1", [id]);
  if (used.n > 0 && req.query.force !== "true") {
    throw badRequest("player has appeared in games; pass ?force=true to delete them and their game records");
  }
  const r = await db.query("DELETE FROM players WHERE id = $1", [id]);
  if (!r.rowCount) throw notFound("player");
  res.status(204).end();
});

router.get("/players/:id/history", async (req, res) => {
  res.json(await db.many("SELECT * FROM historical_stats WHERE player_id = $1 ORDER BY season NULLS FIRST, id", [intParam(req.params.id)]));
});

router.delete("/history/:id", admin, async (req, res) => {
  const r = await db.query("DELETE FROM historical_stats WHERE id = $1", [intParam(req.params.id)]);
  if (!r.rowCount) throw notFound("historical stat line");
  res.status(204).end();
});

module.exports = router;
module.exports.serialize = serialize;

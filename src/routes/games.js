const { Router } = require("express");
const db = require("../db");
const { requireRole, assertTournamentScope } = require("../middleware/auth");
const { badRequest, conflict, intParam, optInt, optEnum, optString, buildUpdate } = require("../lib/http");
const { emitDomain } = require("../lib/bus");
const data = require("../services/data");
const control = require("../services/gameControl");
const { listGames } = require("./tournaments");
const streams = require("../lib/streams");

const router = Router();
const admin = requireRole("admin");
// Scorekeeper routes act on one game: the key must be allowed to score in
// that game's tournament (object-level authorization).
async function scopeGame(req, _res, next) {
  const game = await data.getGame(intParam(req.params.id));
  assertTournamentScope(req, game.tournament_id);
  next();
}
const scorekeeper = [requireRole("scorekeeper"), scopeGame];
const GAME_TYPES = ["pool", "playoff", "final", "exhibition"];

function parseDate(v, name) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest(`${name} is not a valid date/time`);
  return d;
}

router.get("/games", async (req, res) => {
  const status = optEnum(req.query.status, "status", ["scheduled", "live", "intermission", "final"]);
  if (req.query.live === "true") return res.json(await listGames("g.status IN ('live', 'intermission')", []));
  if (status) return res.json(await listGames("g.status = $1", [status]));
  res.json(await listGames("g.scheduled_at > now() - interval '1 day' OR g.status IN ('live', 'intermission')", []));
});

router.post("/tournaments/:id/games", admin, async (req, res) => {
  const tid = intParam(req.params.id);
  const home = Number(req.body.home_team_id);
  const away = Number(req.body.away_team_id);
  if (!home || !away) throw badRequest("home_team_id and away_team_id are required");
  if (home === away) throw badRequest("a team can't play itself");
  const teams = await db.many("SELECT id FROM teams WHERE tournament_id = $1 AND id = ANY($2)", [tid, [home, away]]);
  if (teams.length !== 2) throw badRequest("both teams must be in this tournament");
  const game = await db.one(
    `INSERT INTO games (tournament_id, home_team_id, away_team_id, scheduled_at, venue, game_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [tid, home, away, parseDate(req.body.scheduled_at, "scheduled_at") ?? null, optString(req.body.venue, "venue") ?? null,
      optEnum(req.body.game_type, "game_type", GAME_TYPES) ?? "pool"],
  );
  emitDomain("game.created", { game_id: game.id, tournament_id: tid, game });
  res.status(201).json(game);
});

router.get("/games/:id", async (req, res) => {
  res.json(await data.gameSnapshot(intParam(req.params.id)));
});

router.patch("/games/:id", admin, async (req, res) => {
  const id = intParam(req.params.id);
  const current = await data.getGame(id);
  const fields = {
    scheduled_at: parseDate(req.body.scheduled_at, "scheduled_at"),
    venue: optString(req.body.venue, "venue"),
    game_type: optEnum(req.body.game_type, "game_type", GAME_TYPES),
    stream_embed_url: streams.normalizeEmbedUrl(req.body.stream_embed_url),
    livebarn_url: streams.normalizeLinkUrl(req.body.livebarn_url, "LiveBarn link"),
    stream_delay_sec: optInt(req.body.stream_delay_sec, "stream_delay_sec", { min: 0, max: 300 }),
  };
  for (const side of ["home_team_id", "away_team_id"]) {
    if (req.body[side] === undefined) continue;
    if (current.status !== "scheduled") throw conflict("teams can't change after the game has started");
    const team = await db.one("SELECT id FROM teams WHERE id = $1 AND tournament_id = $2", [Number(req.body[side]), current.tournament_id]);
    if (!team) throw badRequest(`${side} is not in this tournament`);
    fields[side] = team.id;
  }
  // Imported results (no play-by-play) keep their score here.
  for (const side of ["home_score", "away_score"]) {
    if (req.body[side] === undefined) continue;
    if (!current.result_only) throw conflict("this game's score comes from its goals; edit those instead");
    fields[side] = optInt(req.body[side], side, { min: 0, max: 99 });
  }
  const upd = buildUpdate(fields, 2);
  if (!upd) throw badRequest("nothing to update");
  await db.query(`UPDATE games SET ${upd.set}, updated_at = now() WHERE id = $1`, [id, ...upd.values]);
  const snap = await control.publish(id, "game.updated");
  if (current.result_only) require("../lib/bus").emitDomain("game.updated", { game_id: id, tournament_id: current.tournament_id });
  res.json(snap);
});

router.delete("/games/:id", admin, async (req, res) => {
  const id = intParam(req.params.id);
  const game = await data.getGame(id);
  if (game.status !== "scheduled" && req.query.force !== "true") {
    throw conflict("game has started; pass ?force=true to delete it and all its events");
  }
  await db.query("DELETE FROM games WHERE id = $1", [id]);
  emitDomain("game.deleted", { game_id: id, tournament_id: game.tournament_id });
  res.status(204).end();
});

router.get("/games/:id/events", async (req, res) => {
  const snap = await data.gameSnapshot(intParam(req.params.id));
  res.json(snap.events);
});

// Raw events, including voided ones, for the scorekeeper's correction view.
router.get("/games/:id/events/raw", scorekeeper, async (req, res) => {
  res.json(await db.many("SELECT * FROM game_events WHERE game_id = $1 ORDER BY period, elapsed_sec, id", [intParam(req.params.id)]));
});

// ---------------------------------------------------------------------------
// Live control (scorekeeper)

router.post("/games/:id/start", scorekeeper, async (req, res) => {
  res.json(await control.startGame(intParam(req.params.id), req.body));
});

router.post("/games/:id/clock", scorekeeper, async (req, res) => {
  res.json(await control.clockAction(intParam(req.params.id), req.body));
});

router.post("/games/:id/period/end", scorekeeper, async (req, res) => {
  res.json(await control.endPeriod(intParam(req.params.id)));
});

router.post("/games/:id/period/next", scorekeeper, async (req, res) => {
  res.json(await control.nextPeriod(intParam(req.params.id)));
});

router.post("/games/:id/end", scorekeeper, async (req, res) => {
  res.json(await control.endGame(intParam(req.params.id), req.body));
});

router.post("/games/:id/reopen", scorekeeper, async (req, res) => {
  res.json(await control.reopenGame(intParam(req.params.id)));
});

router.post("/games/:id/goalie", scorekeeper, async (req, res) => {
  res.status(201).json(await control.changeGoalie(intParam(req.params.id), req.body));
});

router.patch("/games/:id/lineup", scorekeeper, async (req, res) => {
  res.json(await control.updateLineup(intParam(req.params.id), req.body));
});

router.post("/games/:id/events", scorekeeper, async (req, res) => {
  res.status(201).json(await control.createEvent(intParam(req.params.id), req.body));
});

router.patch("/games/:id/events/:eventId", scorekeeper, async (req, res) => {
  res.json(await control.updateEvent(intParam(req.params.id), intParam(req.params.eventId, "eventId"), req.body));
});

router.delete("/games/:id/events/:eventId", scorekeeper, async (req, res) => {
  res.json(await control.voidEvent(intParam(req.params.id), intParam(req.params.eventId, "eventId"), true));
});

router.post("/games/:id/events/:eventId/restore", scorekeeper, async (req, res) => {
  res.json(await control.voidEvent(intParam(req.params.id), intParam(req.params.eventId, "eventId"), false));
});

// ---------------------------------------------------------------------------
// Officials of record: referees, linespersons, scorekeepers, timekeepers.

const OFFICIAL_ROLES = ["referee", "linesperson", "scorekeeper", "timekeeper"];

router.get("/games/:id/officials", async (req, res) => {
  await data.getGame(intParam(req.params.id));
  res.json(await db.many("SELECT role, name FROM game_officials WHERE game_id = $1 ORDER BY position, id", [intParam(req.params.id)]));
});

/** Replaces the game's officials: { officials: [{ role, name }] } (any number of each role). */
router.put("/games/:id/officials", scorekeeper, async (req, res) => {
  const id = intParam(req.params.id);
  const list = req.body.officials;
  if (!Array.isArray(list) || list.length > 20) throw badRequest("officials must be a list (at most 20)");
  const clean = list.map((o, i) => {
    const role = OFFICIAL_ROLES.includes(o && o.role) ? o.role : null;
    if (!role) throw badRequest(`officials[${i}].role must be one of ${OFFICIAL_ROLES.join(", ")}`);
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
    return { role, name };
  }).filter((o) => o.name);
  await db.tx(async (c) => {
    await c.query("DELETE FROM game_officials WHERE game_id = $1", [id]);
    for (const [i, o] of clean.entries()) {
      await c.query("INSERT INTO game_officials (game_id, role, name, position) VALUES ($1, $2, $3, $4)", [id, o.role, o.name, i]);
    }
  });
  await require("../services/gameControl").publish(id, "officials");
  res.json(clean);
});

module.exports = router;

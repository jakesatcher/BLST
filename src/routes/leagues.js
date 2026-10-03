const { Router } = require("express");
const leagues = require("../services/leagues");
const ratings = require("../services/ratings");
const { requireRole } = require("../middleware/auth");
const { badRequest, intParam, optInt, optString, optBool } = require("../lib/http");
const { emitDomain } = require("../lib/bus");

// Leagues (public reads; admin writes). A division in a season is a
// competition: schedule, score and manage it like any tournament.

const router = Router();
const admin = requireRole("admin");
const lid = (req) => intParam(req.params.id);
const date = (v, name) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw badRequest(`${name} must be YYYY-MM-DD`);
  return String(v);
};
const filters = (req) => ({
  seasonId: optInt(req.query.season_id, "season_id", { min: 1 }) ?? undefined,
  divisionId: optInt(req.query.division_id, "division_id", { min: 1 }) ?? undefined,
});
const strengthOf = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0.1 || n > 2) throw badRequest("strength must be between 0.1 and 2 (1 = the strongest division)");
  return n;
};

router.get("/leagues", async (_req, res) => res.json(await leagues.list()));
router.get("/leagues/:id", async (req, res) => res.json(await leagues.get(lid(req))));
router.get("/leagues/:id/stats", async (req, res) => res.json(await leagues.stats(lid(req), filters(req))));
router.get("/leagues/:id/standings", async (req, res) => {
  const seasonId = optInt(req.query.season_id, "season_id", { min: 1 });
  if (!seasonId) throw badRequest("season_id is required");
  res.json(await leagues.standings(lid(req), seasonId));
});
router.get("/leagues/:id/ratings", async (req, res) => res.json(await ratings.ratings(lid(req), filters(req))));
router.get("/leagues/:id/players/:playerId", async (req, res) => res.json(await leagues.player(lid(req), intParam(req.params.playerId))));

router.post("/leagues", admin, async (req, res) => {
  const divisions = Array.isArray(req.body.divisions) ? req.body.divisions.slice(0, 20) : [];
  const l = await leagues.create({ name: optString(req.body.name, "name", { max: 80 }), short_name: optString(req.body.short_name, "short_name", { max: 16 }), divisions });
  emitDomain("league.created", { league_id: l.id });
  res.status(201).json(await leagues.get(l.id));
});
router.patch("/leagues/:id", admin, async (req, res) => {
  res.json(await leagues.update(lid(req), { name: optString(req.body.name, "name", { max: 80 }), short_name: optString(req.body.short_name, "short_name", { max: 16 }) }));
});
router.delete("/leagues/:id", admin, async (req, res) => {
  await leagues.remove(lid(req));
  res.status(204).end();
});

router.post("/leagues/:id/divisions", admin, async (req, res) => {
  res.status(201).json(await leagues.addDivision(lid(req), {
    name: optString(req.body.name, "name", { max: 40 }), rank: optInt(req.body.rank, "rank", { min: 1, max: 20 }), strength: strengthOf(req.body.strength),
  }));
});
router.patch("/leagues/:id/divisions/:did", admin, async (req, res) => {
  res.json(await leagues.updateDivision(lid(req), intParam(req.params.did), {
    name: optString(req.body.name, "name", { max: 40 }), rank: optInt(req.body.rank, "rank", { min: 1, max: 20 }), strength: strengthOf(req.body.strength),
  }));
});
router.delete("/leagues/:id/divisions/:did", admin, async (req, res) => {
  await leagues.removeDivision(lid(req), intParam(req.params.did));
  res.status(204).end();
});

router.post("/leagues/:id/seasons", admin, async (req, res) => {
  res.status(201).json(await leagues.addSeason(lid(req), {
    name: optString(req.body.name, "name", { max: 40 }), year: optInt(req.body.year, "year", { min: 1950, max: 2100 }),
    start_date: date(req.body.start_date, "start_date"), end_date: date(req.body.end_date, "end_date"),
  }));
});
router.patch("/leagues/:id/seasons/:sid", admin, async (req, res) => {
  res.json(await leagues.updateSeason(lid(req), intParam(req.params.sid), {
    name: optString(req.body.name, "name", { max: 40 }), year: optInt(req.body.year, "year", { min: 1950, max: 2100 }),
    start_date: date(req.body.start_date, "start_date"), end_date: date(req.body.end_date, "end_date"),
  }));
});
router.delete("/leagues/:id/seasons/:sid", admin, async (req, res) => {
  await leagues.removeSeason(lid(req), intParam(req.params.sid));
  res.status(204).end();
});

/** Starts a division in a season (a competition with its teams). */
router.post("/leagues/:id/seasons/:sid/divisions/:did", admin, async (req, res) => {
  const names = Array.isArray(req.body.team_names) ? req.body.team_names.slice(0, 64).map((x) => optString(x, "team_names[]", { max: 80 }) || "") : [];
  res.status(201).json(await leagues.addCompetition(lid(req), intParam(req.params.sid), intParam(req.params.did), {
    num_teams: optInt(req.body.num_teams, "num_teams", { min: 2, max: 64 }) ?? (names.length || 4), team_names: names,
    start_date: date(req.body.start_date, "start_date"), end_date: date(req.body.end_date, "end_date"),
    rules: {
      periods: optInt(req.body.periods, "periods", { min: 1, max: 4 }), period_length_sec: optInt(req.body.period_length_sec, "period_length_sec", { min: 60, max: 3600 }),
      ot_length_sec: optInt(req.body.ot_length_sec, "ot_length_sec", { min: 0, max: 3600 }), allow_ties: optBool(req.body.allow_ties, "allow_ties"),
    },
  }));
});

router.put("/leagues/:id/rating-settings", admin, async (req, res) => {
  res.json(await ratings.saveSettings(lid(req), req.body || {}));
});

module.exports = router;

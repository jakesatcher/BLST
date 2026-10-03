const { Router } = require("express");
const history = require("../services/history");
const { requireRole } = require("../middleware/auth");
const { badRequest, intParam, optInt, optString, optEnum, optBool } = require("../lib/http");
const { emitDomain } = require("../lib/bus");

// History across tournaments: the player directory with all-time totals,
// teams that carry over between team tournaments ("clubs"), and the admin
// tools for matching imported players to registered ones.

const router = Router();
const admin = requireRole("admin");
const SORTS = ["points", "goals", "assists", "gp", "pim", "wins", "shutouts", "events", "name"];

router.get("/history/players", async (req, res) => {
  res.json(await history.directory({
    q: optString(req.query.q, "q", { max: 100 }),
    sort: optEnum(req.query.sort, "sort", SORTS) || "points",
    limit: optInt(req.query.limit, "limit", { min: 1, max: 1000 }) || 100,
  }));
});

router.get("/clubs", async (_req, res) => {
  res.json(await history.listClubs());
});

router.get("/clubs/:id", async (req, res) => {
  res.json(await history.club(intParam(req.params.id)));
});

function clubFields(body) {
  const color = optString(body.color, "color", { max: 7 });
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw badRequest("color must look like #1d4ed8");
  return { name: optString(body.name, "name", { max: 80 }), short_name: optString(body.short_name, "short_name", { max: 12 }), color };
}

router.post("/clubs", admin, async (req, res) => {
  const c = await history.createClub(clubFields(req.body));
  emitDomain("club.updated", { club_id: c.id });
  res.status(201).json(c);
});

router.patch("/clubs/:id", admin, async (req, res) => {
  const c = await history.updateClub(intParam(req.params.id), clubFields(req.body));
  emitDomain("club.updated", { club_id: c.id });
  res.json(c);
});

/** Two names for the same team: fold `from_club_id` into this one. */
router.post("/clubs/:id/merge", admin, async (req, res) => {
  const from = optInt(req.body.from_club_id, "from_club_id", { min: 1 });
  if (!from) throw badRequest("from_club_id is required");
  const r = await history.mergeClubs(intParam(req.params.id), from);
  emitDomain("club.updated", { club_id: r.club.id });
  res.json(r);
});

router.delete("/clubs/:id", admin, async (req, res) => {
  await history.deleteClub(intParam(req.params.id));
  emitDomain("club.updated", {});
  res.status(204).end();
});

/** Which carried-over team a tournament team is (null: none). */
router.put("/teams/:id/club", admin, async (req, res) => {
  const clubId = req.body.club_id === null ? null : optInt(req.body.club_id, "club_id", { min: 1 });
  if (clubId === undefined) throw badRequest("club_id (a number, or null) is required");
  const t = await history.setTeamClub(intParam(req.params.id), clubId);
  emitDomain("club.updated", { club_id: clubId });
  res.json(t);
});

// ---------------------------------------------------------------------------
// Matching imported players (often without email) to registered ones

router.get("/admin/identity/suggestions", admin, async (_req, res) => {
  res.json(await history.suggestions());
});

router.post("/admin/identity/dismiss", admin, async (req, res) => {
  const a = optInt(req.body.player_a, "player_a", { min: 1 });
  const b = optInt(req.body.player_b, "player_b", { min: 1 });
  if (!a || !b) throw badRequest("player_a and player_b are required");
  await history.dismiss(a, b);
  res.status(204).end();
});

/** Bulk-attach emails: CSV/rows with player_code (or player_id, or name) and email. */
router.post("/admin/identity/emails", admin, async (req, res) => {
  const { rowsFrom } = require("../services/importer");
  const rows = rowsFrom(req.body);
  if (!rows.length) throw badRequest("no rows");
  if (rows.length > 20000) throw badRequest("too many rows (max 20000)");
  const r = await history.linkEmails(rows, { dryRun: Boolean(optBool(req.body.dry_run, "dry_run")) });
  if (!r.dry_run && r.linked) emitDomain("players.updated", { emails_linked: r.linked });
  res.json(r);
});

module.exports = router;

// ---------------------------------------------------------------------------
// Stats page: all-time leaders and the organization's awards

/** All-time leaders (imported history + every BLST game). Goalie rates need half the leader's games. */
router.get("/leaders", async (req, res) => {
  const limit = optInt(req.query.limit, "limit", { min: 1, max: 25 }) || 5;
  const rows = await history.allTime();
  const line = (r, value, gp) => ({ player_id: r.player_id, name: r.name, position: r.position, gp, value });
  const top = (list, value, gp, dir = -1) => list
    .filter((r) => value(r) != null && gp(r) > 0)
    .sort((a, b) => dir * (value(a) - value(b)) || gp(b) - gp(a) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((r) => line(r, value(r), gp(r)));
  const skaters = rows.filter((r) => r.skater.gp > 0);
  const goalies = rows.filter((r) => r.goalie.gp > 0);
  const minGp = Math.max(1, Math.floor(Math.max(0, ...goalies.map((g) => g.goalie.gp)) / 2));
  const qualified = goalies.filter((g) => g.goalie.gp >= minGp);
  res.json({
    scope: "all-time",
    goals: top(skaters.filter((r) => r.skater.goals > 0), (r) => r.skater.goals, (r) => r.skater.gp),
    assists: top(skaters.filter((r) => r.skater.assists > 0), (r) => r.skater.assists, (r) => r.skater.gp),
    pim: top(skaters.filter((r) => r.skater.pim > 0), (r) => r.skater.pim, (r) => r.skater.gp),
    save_pct: top(qualified, (r) => r.goalie.save_pct, (r) => r.goalie.gp),
    gaa: top(qualified, (r) => r.goalie.gaa, (r) => r.goalie.gp, 1),
    wins: top(goalies.filter((r) => r.goalie.wins > 0), (r) => r.goalie.wins, (r) => r.goalie.gp),
    goalie_min_gp: minGp,
  });
});

/** The organization's awards, with the winner's player page when the name matches a player. */
async function awardsWithPlayers(org) {
  const db = require("../db");
  const row = await db.one("SELECT awards FROM organizations WHERE id = $1", [org.id]);
  const awards = (row && row.awards) || [];
  return Promise.all(awards.map(async (a) => {
    const [first, ...rest] = String(a.name || "").trim().split(/\s+/);
    const p = first && rest.length ? await db.one(
      "SELECT id FROM players WHERE lower(first_name) = lower($1) AND lower(last_name) = lower($2) ORDER BY id LIMIT 1", [first, rest.join(" ")]) : null;
    return { title: a.title, name: a.name, note: a.note || null, player_id: p ? p.id : null };
  }));
}

router.get("/awards", async (req, res) => res.json(await awardsWithPlayers(req.org)));

/** [{ title, name, note? }] — up to 12. */
router.put("/admin/awards", require("../middleware/auth").requireInteractiveAdmin, async (req, res) => {
  const list = req.body.awards;
  if (!Array.isArray(list) || list.length > 12) throw badRequest("awards must be a list (at most 12)");
  const clean = list.map((a, i) => {
    const title = optString(a && a.title, `awards[${i}].title`, { max: 60 });
    const name = optString(a && a.name, `awards[${i}].name`, { max: 80 });
    if (!title || !name) throw badRequest("each award needs a title and a name");
    return { title, name, ...(a.note ? { note: optString(a.note, `awards[${i}].note`, { max: 140 }) } : {}) };
  });
  await require("../db").query("UPDATE organizations SET awards = $2, updated_at = now() WHERE id = $1", [req.org.id, JSON.stringify(clean)]);
  res.json(await awardsWithPlayers(req.org));
});

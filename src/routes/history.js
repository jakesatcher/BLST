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

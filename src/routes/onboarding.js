const { Router } = require("express");
const db = require("../db");
const { requireRole, requireInteractiveAdmin } = require("../middleware/auth");
const { badRequest } = require("../lib/http");
const { invalidateOrgCache } = require("../middleware/org");

// League setup for a new organization's admins (/setup): the league and its
// divisions, this season, connecting SportsEngine / LeagueApps, importing
// past seasons, and inviting people. Each step counts as done when its
// result exists (a league, a season, a connection…) or the admin skips it.

const router = Router();
const admin = requireRole("admin");
const STEPS = ["league", "season", "connect", "history", "people"];

async function progress(org) {
  const saved = (await db.one("SELECT onboarding FROM organizations WHERE id = $1", [org.id])).onboarding || {};
  const leagues = await db.many("SELECT id, name, short_name FROM leagues ORDER BY id");
  const league = leagues.find((l) => l.id === saved.league_id) || leagues[0] || null;
  const [divisions, seasons, comps, se, la, history, results, members, invites] = await Promise.all([
    league ? db.many("SELECT id, name, rank FROM league_divisions WHERE league_id = $1 ORDER BY rank", [league.id]) : [],
    league ? db.many("SELECT id, name, year, start_date, end_date FROM league_seasons WHERE league_id = $1 ORDER BY year DESC NULLS LAST, id DESC", [league.id]) : [],
    league ? db.many("SELECT id, name, imported, league_season_id, league_division_id FROM tournaments WHERE league_id = $1", [league.id]) : [],
    db.one("SELECT se_organization_name FROM sportsengine_connections WHERE org_id = blst_org()"),
    require("../services/leagueapps").isConfigured(),
    db.one("SELECT count(*)::int AS n FROM historical_stats"),
    db.one("SELECT count(*)::int AS n FROM games WHERE result_only"),
    db.one("SELECT count(*)::int AS n FROM org_members"),
    db.one("SELECT count(*)::int AS n FROM org_invites"),
  ]);
  const skipped = new Set(saved.skipped || []);
  const has = {
    league: Boolean(league && divisions.length),
    season: comps.some((c) => !c.imported),
    connect: Boolean(se) || la,
    history: history.n > 0 || results.n > 0,
    people: members.n + invites.n > 1,
  };
  const steps = STEPS.map((id) => ({ id, done: has[id], skipped: !has[id] && skipped.has(id) }));
  return {
    completed: Boolean(saved.completed), steps,
    next: (steps.find((s) => !s.done && !s.skipped) || { id: "finish" }).id,
    org: { name: org.name, slug: org.slug, tournament_types: org.tournament_types || [] },
    league: league ? { ...league, divisions, seasons, competitions: comps } : null,
    connections: { sportsengine: se ? se.se_organization_name || "connected" : null, leagueapps: la },
    counts: { history_rows: history.n, imported_results: results.n, people: members.n, invites: invites.n },
  };
}

router.get("/admin/onboarding", admin, async (req, res) => res.json(await progress(req.org)));

/** { league_id?, skip?: step, unskip?: step, completed?: bool } */
router.put("/admin/onboarding", requireInteractiveAdmin, async (req, res) => {
  const saved = (await db.one("SELECT onboarding FROM organizations WHERE id = $1", [req.org.id])).onboarding || {};
  const next = { ...saved, skipped: [...new Set(saved.skipped || [])] };
  if (req.body.league_id !== undefined) {
    const l = await db.one("SELECT id FROM leagues WHERE id = $1", [Number(req.body.league_id)]);
    if (!l) throw badRequest("no such league");
    next.league_id = l.id;
  }
  for (const [k, add] of [["skip", true], ["unskip", false]]) {
    if (req.body[k] === undefined) continue;
    if (!STEPS.includes(req.body[k])) throw badRequest(`step must be one of ${STEPS.join(", ")}`);
    next.skipped = add ? [...new Set([...next.skipped, req.body[k]])] : next.skipped.filter((s) => s !== req.body[k]);
  }
  if (req.body.completed !== undefined) next.completed = Boolean(req.body.completed);
  await db.query("UPDATE organizations SET onboarding = $2, updated_at = now() WHERE id = $1", [req.org.id, JSON.stringify(next)]);
  invalidateOrgCache();
  res.json(await progress(req.org));
});

module.exports = router;

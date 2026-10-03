const { Router } = require("express");
const se = require("../services/sportsengine");
const { requireRole, requireInteractiveAdmin } = require("../middleware/auth");
const { badRequest, intParam, optString, optBool } = require("../lib/http");

// SportsEngine integration (organization admins). Credentials can only be
// set by an admin signed in with their account, not an API key.

const router = Router();
const admin = requireRole("admin");

router.get("/integrations/sportsengine", admin, async (_req, res) => res.json(await se.status()));

router.put("/integrations/sportsengine", requireInteractiveAdmin, async (req, res) => {
  res.json(await se.connect({
    client_id: optString(req.body.client_id, "client_id", { max: 200 }),
    client_secret: optString(req.body.client_secret, "client_secret", { max: 500 }),
    se_organization_id: optString(req.body.se_organization_id, "se_organization_id", { max: 100 }),
    auto_push: optBool(req.body.auto_push, "auto_push"),
  }));
});

router.patch("/integrations/sportsengine", requireInteractiveAdmin, async (req, res) => {
  res.json(await se.setOptions({
    auto_push: optBool(req.body.auto_push, "auto_push"),
    se_organization_id: optString(req.body.se_organization_id, "se_organization_id", { max: 100 }),
  }));
});

router.delete("/integrations/sportsengine", requireInteractiveAdmin, async (_req, res) => {
  await se.disconnect();
  res.status(204).end();
});

router.get("/integrations/sportsengine/teams", admin, async (_req, res) => res.json(await se.teams()));

router.get("/tournaments/:id/sportsengine", admin, async (req, res) => res.json(await se.tournamentLinks(intParam(req.params.id))));

/** SportsEngine teams (with rosters) into this tournament or league division. */
router.post("/tournaments/:id/sportsengine/teams", admin, async (req, res) => {
  const ids = Array.isArray(req.body.team_ids) ? req.body.team_ids.map((x) => String(x).slice(0, 100)) : null;
  if (!ids || !ids.length) throw badRequest("team_ids (SportsEngine team ids) are required");
  res.json(await se.importTeams(intParam(req.params.id), ids));
});

/** SportsEngine games between this competition's linked teams into its schedule. */
router.post("/tournaments/:id/sportsengine/schedule", admin, async (req, res) => {
  res.json(await se.importSchedule(intParam(req.params.id), {
    start: optString(req.body.start, "start", { max: 40 }), end: optString(req.body.end, "end", { max: 40 }),
    include_results: optBool(req.body.include_results, "include_results") ?? true,
  }));
});

/** Sends a final game's score to SportsEngine now (also automatic at the final whistle). */
router.post("/games/:id/sportsengine/result", admin, async (req, res) => res.json(await se.pushResult(intParam(req.params.id))));

module.exports = router;

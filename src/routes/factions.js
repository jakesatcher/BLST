const { Router } = require("express");
const { invalidateOrgCache } = require("../middleware/org");
const factions = require("../services/factions");
const { requireRole } = require("../middleware/auth");
const { badRequest, intParam, optInt, optString, optBool, optEnum } = require("../lib/http");

// BLPA Factions. Standings, events and leaderboards are public (aggregates
// and display names only). Members are keyed by email and their ids are a
// reversible encoding of it, so everything about members is admin-only.

const router = Router();
const admin = requireRole("admin");
// Factions is optional per organization: while it's off, its pages and API
// don't exist (404) for that organization. The designer below works either
// way, so admins can set factions up before turning the feature on.
const enabled = async (_req, _res, next) => {
  await factions.requireEnabled();
  next();
};
const slugParam = (v, name = "faction") => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(v)) throw badRequest(`invalid ${name}`);
  return v;
};
const idParam = (v, what = "id") => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,400}$/.test(v)) throw badRequest(`invalid ${what}`);
  return v;
};
const date = (v, name) => {
  const s = optString(v, name, { max: 30 });
  if (s && !/^\d{4}-\d{2}-\d{2}/.test(s)) throw badRequest(`${name} must be a date (YYYY-MM-DD)`);
  return s ? s.slice(0, 10) : null;
};
const publicEvent = (e) => ({
  id: e.id, name: e.name, start_date: e.start_date, end_date: e.end_date,
  tournament_id: e.tournament_id, tournament_name: e.tournament_name, participants: e.participants, points: e.points,
});

// ---------------------------------------------------------------------------
// Public

/** Everything the Factions page needs in one call. */
router.get("/factions", enabled, async (_req, res) => {
  const [orders, events, leaders] = await Promise.all([factions.orderTotals(), factions.listEvents(), factions.leaders({ limit: 10 })]);
  res.json({ orders, events: events.map(publicEvent), leaders });
});

router.get("/factions/orders", enabled, async (_req, res) => {
  res.json(await factions.orderTotals());
});

router.get("/factions/leaders", enabled, async (req, res) => {
  const order = slugParam(req.query.order, "order");
  res.json(await factions.leaders({ order, limit: optInt(req.query.limit, "limit", { min: 1, max: 100 }) || 25 }));
});

router.get("/factions/events", enabled, async (_req, res) => {
  res.json((await factions.listEvents()).map(publicEvent));
});

router.get("/factions/events/:id/totals", enabled, async (req, res) => {
  res.json(await factions.eventTotals(idParam(req.params.id)));
});

// ---------------------------------------------------------------------------
// Admin: members

router.get("/factions/status", admin, enabled, async (_req, res) => {
  res.json(await factions.status());
});

router.get("/factions/members", admin, enabled, async (req, res) => {
  res.json(await factions.listMembers({
    q: optString(req.query.q, "q", { max: 100 }),
    order: slugParam(req.query.order, "order"),
    limit: optInt(req.query.limit, "limit", { min: 1, max: 500 }) || 50,
    offset: optInt(req.query.offset, "offset", { min: 0 }) || 0,
  }));
});

/** Find or create by email (POST so emails stay out of URLs and logs). */
router.post("/factions/members", admin, enabled, async (req, res) => {
  const { member, created } = await factions.getOrCreateMember({
    email: optString(req.body.email, "email", { max: 254 }),
    display_name: optString(req.body.display_name, "display_name", { max: 120 }),
    leagueapps_user_id: optString(req.body.leagueapps_user_id, "leagueapps_user_id", { max: 40 }),
  });
  res.status(created ? 201 : 200).json({ ...(await factions.getMember(member.id)), created });
});

router.post("/factions/members/find", admin, enabled, async (req, res) => {
  const email = optString(req.body.email, "email", { max: 254 });
  if (!email) throw badRequest("email is required");
  res.json(await factions.findMemberByEmail(email));
});

router.post("/factions/members/import", admin, enabled, async (req, res) => {
  const csv = typeof req.body === "string" ? req.body : req.body.csv;
  if (typeof csv !== "string") throw badRequest("send the CSV as text/csv, or as {csv: \"...\"}");
  const dryRun = (typeof req.body === "string" ? req.query.dry_run === "true" : optBool(req.body.dry_run, "dry_run")) || false;
  res.status(dryRun ? 200 : 201).json(await factions.importMembers(csv, { dryRun }));
});

router.get("/factions/members/:id", admin, enabled, async (req, res) => {
  res.json(await factions.getMember(idParam(req.params.id)));
});

router.post("/factions/members/:id/points", admin, enabled, async (req, res) => {
  const points = optInt(req.body.points, "points", { min: -100000, max: 100000 });
  if (!points) throw badRequest("points must be a whole number other than 0 (negative takes points away)");
  res.json(await factions.addBonusPoints(idParam(req.params.id), points));
});

router.post("/factions/members/:id/achievements", admin, enabled, async (req, res) => {
  const code = optString(req.body.code, "code", { max: 120 });
  const title = optString(req.body.title, "title", { max: 200 });
  if (!code || !title) throw badRequest("code and title are required");
  if (!/^[A-Za-z0-9_.:-]+$/.test(code)) throw badRequest("code may only contain letters, digits and _ . : -");
  const r = await factions.awardAchievement(idParam(req.params.id), { code, title, event_id: optString(req.body.event_id, "event_id", { max: 100 }) });
  res.status(r.created ? 201 : 200).json(r);
});

// ---------------------------------------------------------------------------
// Admin: events

router.post("/factions/events", admin, enabled, async (req, res) => {
  const name = optString(req.body.name, "name", { max: 120 });
  if (!name) throw badRequest("name is required");
  res.status(201).json(await factions.createEvent({
    name,
    leagueapps_event_id: optString(req.body.leagueapps_event_id, "leagueapps_event_id", { max: 40 }),
    start_date: date(req.body.start_date, "start_date"),
    end_date: date(req.body.end_date, "end_date"),
  }));
});

router.get("/factions/events/:id", admin, enabled, async (req, res) => {
  res.json(await factions.getEvent(idParam(req.params.id)));
});

router.post("/factions/events/:id/participation", admin, enabled, async (req, res) => {
  const memberId = req.body.member_id === undefined ? undefined : idParam(req.body.member_id, "member_id");
  const email = optString(req.body.email, "email", { max: 254 });
  if (!memberId && !email) throw badRequest("member_id or email is required");
  res.status(201).json(await factions.recordParticipation(idParam(req.params.id), {
    member_id: memberId,
    email,
    points_earned: optInt(req.body.points_earned, "points_earned", { min: -100000, max: 100000 }) ?? 0,
    placement: optInt(req.body.placement, "placement", { min: 1, max: 1000 }) ?? null,
  }));
});

// ---------------------------------------------------------------------------
// Tournaments

router.post("/tournaments/:id/factions/link", admin, enabled, async (req, res) => {
  const eventId = req.body.event_id === undefined || req.body.event_id === null || req.body.event_id === "" ? undefined : idParam(req.body.event_id, "event_id");
  res.json(await factions.linkTournament(intParam(req.params.id), { event_id: eventId }));
});

router.delete("/tournaments/:id/factions/link", admin, enabled, async (req, res) => {
  res.json(await factions.unlinkTournament(intParam(req.params.id)));
});

router.get("/tournaments/:id/factions/preview", admin, enabled, async (req, res) => {
  res.json(await factions.participationPreview(intParam(req.params.id)));
});

router.post("/tournaments/:id/factions/award", admin, enabled, async (req, res) => {
  res.json(await factions.awardResults(intParam(req.params.id)));
});

/** Public: per-Order totals for the tournament's event (no personal data). */
router.get("/tournaments/:id/factions/order-totals", enabled, async (req, res) => {
  const t = await require("../services/data").getTournament(intParam(req.params.id));
  if (!t.factions_event_id) throw new factions.HttpError(409, "this tournament doesn't count for Factions");
  res.json(await factions.eventTotals(t.factions_event_id));
});

// ---------------------------------------------------------------------------
// Designing the organization's factions (admin; works while Factions is off)

router.get("/factions-setup", admin, async (_req, res) => {
  res.json({ ...(await factions.settings()), factions: await factions.listFactions(), presets: factions.PRESETS });
});

router.put("/factions-setup", admin, async (req, res) => {
  const on = optBool(req.body.enabled, "enabled");
  if (on === undefined) throw badRequest("enabled (true or false) is required");
  const r = await factions.setEnabled(on);
  invalidateOrgCache(); // pages and the menu pick it up straight away
  res.json(r);
});

router.post("/factions-setup/factions", admin, async (req, res) => {
  if (req.body.preset !== undefined) return res.status(201).json(await factions.applyPreset(optString(req.body.preset, "preset", { max: 20 })));
  res.status(201).json(await factions.createFaction(req.body));
});

router.patch("/factions-setup/factions/:slug", admin, async (req, res) => {
  res.json(await factions.updateFaction(slugParam(req.params.slug), req.body));
});

router.delete("/factions-setup/factions/:slug", admin, async (req, res) => {
  res.json(await factions.deleteFaction(slugParam(req.params.slug)));
});

/** Public: the organization's factions (names, emoji, colours) for the UI. */
router.get("/factions/definitions", enabled, async (_req, res) => {
  res.json(await factions.listFactions());
});

module.exports = router;

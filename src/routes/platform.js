const { Router } = require("express");
const config = require("../config");
const db = require("../db");
const accounts = require("../services/accounts");
const notify = require("../services/notify");
const { withOrg } = require("../lib/context");
const { requireAccount, requirePlatformAdmin, requireInteractiveAdmin } = require("../middleware/auth");
const { RESERVED, SLUG_RE, invalidateOrgCache } = require("../middleware/org");
const { HttpError, badRequest, conflict, notFound, intParam, optString, optEnum, optBool } = require("../lib/http");

// The platform: organizations ask to join, platform admins approve them.
// Organizations live at <slug>.<APP_DOMAIN>; this API works on any address.

const router = Router();

/** Public address of an organization. */
function orgUrl(slug, req) {
  if (config.appDomain) return `${scheme(req)}://${slug}.${config.appDomain}${port(req)}`;
  return `${req.protocol}://${req.get("host")}`;
}
const platformUrl = (req) => (config.appDomain ? `${scheme(req)}://${config.appDomain}${port(req)}` : `${req.protocol}://${req.get("host")}`);
// Real domains are always https; local development (APP_DOMAIN=localhost)
// keeps the scheme and port it's running on.
const isLocal = () => config.appDomain === "localhost";
const scheme = (req) => (isLocal() ? req.protocol : "https");
const port = (req) => (isLocal() ? (/:\d+$/.exec(req.get("host") || "") || [""])[0] : "");

function orgView(o, req) {
  return {
    id: o.id, slug: o.slug, name: o.name, status: o.status, factions_enabled: o.factions_enabled,
    url: orgUrl(o.slug, req), created_at: o.created_at, decided_at: o.decided_at,
  };
}

/** Where am I? The organization for this address (null on the platform). */
router.get("/org", (req, res) => {
  res.json({
    org: req.org ? { slug: req.org.slug, name: req.org.name, factions_enabled: req.org.factions_enabled, tournament_types: req.org.tournament_types || [], url: orgUrl(req.org.slug, req),
      setup_needed: !(req.org.onboarding && req.org.onboarding.completed) } : null,
    platform: { app_domain: config.appDomain || null, url: platformUrl(req) },
  });
});

function checkSlug(raw) {
  const slug = String(raw || "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw badRequest("the address can use letters, numbers and dashes (2-40), like \"metro-hockey\"");
  if (slug.length < 2) throw badRequest("the address needs at least 2 characters");
  if (RESERVED.has(slug)) throw badRequest("that address is reserved");
  return slug;
}

router.get("/platform/orgs/check", async (req, res) => {
  let slug;
  try {
    slug = checkSlug(req.query.slug);
  } catch (err) {
    return res.json({ available: false, reason: err.message });
  }
  const taken = await db.one("SELECT 1 FROM organizations WHERE slug = $1", [slug]);
  res.json({ available: !taken, slug, reason: taken ? "that address is taken" : null, url: orgUrl(slug, req) });
});

/** Anyone signed in can ask for an organization; it waits for approval. */
router.post("/platform/orgs", requireAccount, async (req, res) => {
  const name = optString(req.body.name, "name", { max: 80 });
  if (!name || name.length < 2) throw badRequest("give the organization a name");
  const slug = checkSlug(req.body.slug);
  const note = optString(req.body.note, "note", { max: 500 }) ?? null;
  const pending = await db.one("SELECT count(*)::int AS n FROM organizations WHERE requested_by = $1 AND status = 'pending'", [req.auth.accountId]);
  if (pending.n >= 3) throw new HttpError(429, "you already have 3 organizations waiting for approval");
  let org;
  try {
    org = await db.one(
      "INSERT INTO organizations (slug, name, status, requested_by, request_note) VALUES ($1, $2, 'pending', $3, $4) RETURNING *",
      [slug, name, req.auth.accountId, note],
    );
  } catch (err) {
    if (err.code === "23505") throw conflict("that address is taken");
    throw err;
  }
  // The person who asked runs it.
  await withOrg(org.id, () => db.query("INSERT INTO org_members (account_id, role) VALUES ($1, 'admin')", [req.auth.accountId]));
  const admins = await db.many("SELECT email FROM accounts WHERE role = 'admin' AND disabled_at IS NULL");
  for (const a of admins) {
    notify.sendEmail(a.email, `New organization waiting for approval: ${name}`,
      `${req.auth.email} asked for "${name}" at ${orgUrl(slug, req)}.${note ? `\n\nNote: ${note}` : ""}\n\nReview it at ${platformUrl(req)}/platform`).catch(() => {});
  }
  res.status(201).json(orgView(org, req));
});

/** The leagues this account can open: where it's staff or a viewer, and where its email is on a player. */
router.get("/platform/orgs/mine", requireAccount, async (req, res) => {
  const a = await accounts.accountView(req.auth.accountId);
  const played = await withOrg("*", () => db.many(
    `SELECT DISTINCT o.id, o.slug, o.name, o.status, o.factions_enabled, 'player' AS role
       FROM players p JOIN organizations o ON o.id = p.org_id
      WHERE lower(p.email) = lower($1) AND o.status = 'active'`, [a.email]));
  const all = [...a.orgs, ...played.filter((p) => !a.orgs.some((o) => o.id === p.id))];
  res.json(all.map((o) => ({ ...o, url: orgUrl(o.slug, req) })));
});

// ---------------------------------------------------------------------------
// Platform admins

router.get("/platform/orgs", requirePlatformAdmin, async (req, res) => {
  const rows = await withOrg("*", () => db.many(
    `SELECT o.*, r.email AS requested_by_email,
            (SELECT count(*) FROM org_members m WHERE m.org_id = o.id)::int AS members,
            (SELECT count(*) FROM tournaments t WHERE t.org_id = o.id)::int AS tournaments,
            (SELECT count(*) FROM players p WHERE p.org_id = o.id)::int AS players
       FROM organizations o LEFT JOIN accounts r ON r.id = o.requested_by
      ORDER BY o.status = 'pending' DESC, o.created_at DESC`));
  res.json(rows.map((o) => ({ ...orgView(o, req), requested_by: o.requested_by_email, request_note: o.request_note,
    members: o.members, tournaments: o.tournaments, players: o.players })));
});

/** Approve, reject, suspend or reactivate; rename or move to a new address. */
router.patch("/platform/orgs/:id", requireInteractiveAdmin, requirePlatformAdmin, async (req, res) => {
  const id = intParam(req.params.id);
  const status = optEnum(req.body.status, "status", ["active", "rejected", "suspended"]);
  const name = optString(req.body.name, "name", { max: 80 });
  const slug = req.body.slug === undefined ? undefined : checkSlug(req.body.slug);
  let org;
  try {
    org = await db.one(
      `UPDATE organizations SET status = COALESCE($2, status), name = COALESCE($3, name), slug = COALESCE($4, slug),
              decided_by = CASE WHEN $2::text IS NULL THEN decided_by ELSE $5 END,
              decided_at = CASE WHEN $2::text IS NULL THEN decided_at ELSE now() END, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, status ?? null, name ?? null, slug ?? null, req.auth.accountId ?? null],
    );
  } catch (err) {
    if (err.code === "23505") throw conflict("that address is taken");
    throw err;
  }
  if (!org) throw notFound("organization");
  invalidateOrgCache();
  if (status && org.requested_by) {
    const who = await db.one("SELECT email FROM accounts WHERE id = $1", [org.requested_by]);
    const text = status === "active"
      ? `"${org.name}" is approved and live at ${orgUrl(org.slug, req)}\n\nSet up your league (divisions, this season, past seasons' stats, SportsEngine or LeagueApps, scorekeepers) at ${orgUrl(org.slug, req)}/setup — sign in there with this email.`
      : status === "rejected" ? `"${org.name}" wasn't approved. Reply to this email if you have questions.` : `"${org.name}" has been suspended.`;
    if (who) notify.sendEmail(who.email, `Your organization on Beer League Stats: ${org.name}`, text).catch(() => {});
  }
  res.json(orgView(org, req));
});

router.get("/platform/accounts", requirePlatformAdmin, async (_req, res) => {
  res.json(await accounts.listAccounts());
});

router.patch("/platform/accounts/:id", requireInteractiveAdmin, requirePlatformAdmin, async (req, res) => {
  res.json(await accounts.updateAccount(intParam(req.params.id), {
    platformAdmin: optBool(req.body.platform_admin, "platform_admin"),
    disabled: optBool(req.body.disabled, "disabled"),
  }));
});

router.post("/platform/accounts/:id/logout", requireInteractiveAdmin, requirePlatformAdmin, async (req, res) => {
  res.json({ ended: await accounts.endAllSessions(intParam(req.params.id)) });
});

/** Lost authenticator/passkey: removes every second factor so they can set up a new one. */
router.post("/platform/accounts/:id/reset-mfa", requireInteractiveAdmin, requirePlatformAdmin, async (req, res) => {
  await require("../services/mfa").resetAll(intParam(req.params.id));
  res.json({ ok: true });
});

router.delete("/platform/accounts/:id", requireInteractiveAdmin, requirePlatformAdmin, async (req, res) => {
  await accounts.deleteAccount(intParam(req.params.id));
  res.status(204).end();
});

module.exports = router;
module.exports.orgUrl = orgUrl;

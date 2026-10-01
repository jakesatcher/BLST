const { Router } = require("express");
const config = require("../config");
const accounts = require("../services/accounts");
const notify = require("../services/notify");
const { rateLimit } = require("../lib/rateLimit");
const { requireAccount, requireRole, requireInteractiveAdmin } = require("../middleware/auth");
const { badRequest } = require("../lib/http");

// Public sign-up / sign-in endpoints (/api/v1/auth/*) and the signed-in
// account's own settings (/api/v1/account*).

const router = Router();
const FIFTEEN_MIN = 15 * 60 * 1000;
const starts = rateLimit({ windowMs: FIFTEEN_MIN, max: config.rateLimits.authStartsPer15Min, name: "sign-in attempts" });
const verifies = rateLimit({ windowMs: FIFTEEN_MIN, max: config.rateLimits.authVerifiesPer15Min, name: "code attempts" });

const str = (v) => (typeof v === "string" ? v : "");

router.get("/auth/status", async (req, res) => {
  const setup = await accounts.setupStatus();
  res.json({
    signed_in: req.auth.via === "session",
    setup_needed: setup.needed,
    setup_key_required: setup.key_required,
    email_ready: notify.emailConfigured() || config.auth.logCodes,
    sms_ready: notify.smsConfigured() || config.auth.logCodes,
    dev_codes: !notify.emailConfigured() && config.auth.logCodes ? "codes are printed in the server log" : null,
    sms_country_codes: config.auth.smsCountryCodes,
  });
});

router.post("/auth/signup", starts, async (req, res) => {
  res.status(202).json(await accounts.startSignup(str(req.body.email), str(req.body.phone)));
});

router.post("/auth/login", starts, async (req, res) => {
  res.status(202).json(await accounts.startLogin(str(req.body.email)));
});

router.post("/auth/setup", starts, async (req, res) => {
  res.status(202).json(await accounts.startSetup(str(req.body.setup_key), str(req.body.email), str(req.body.phone)));
});

router.post("/auth/verify", verifies, async (req, res) => {
  if (!req.body.code) throw badRequest("Enter the 6-digit code.");
  const r = await accounts.verify(str(req.body.challenge_id), str(String(req.body.code)), { accountId: req.auth.accountId, sessionId: req.auth.sessionId });
  // The audit log records who signed in (by account id, never email).
  if (r.account) req.auth.actor = `account:${r.account.id}`;
  res.json(r);
});

router.post("/auth/resend", starts, async (req, res) => {
  res.json(await accounts.resend(str(req.body.challenge_id)));
});

router.post("/auth/logout", async (req, res) => {
  const header = req.header("authorization") || "";
  await accounts.endSession(header.replace(/^bearer\s+/i, "").trim());
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// The signed-in account

router.get("/account", requireAccount, async (req, res) => {
  const a = await accounts.accountView(req.auth.accountId);
  res.json({ ...a, orgs: a.orgs.map((o) => ({ ...o, url: orgUrl(o.slug, req) })) });
});

/** New mobile number: confirm by email code, then a code to the new number. */
router.post("/account/phone", requireAccount, starts, async (req, res) => {
  res.status(202).json(await accounts.startPhoneChange(req.auth.accountId, str(req.body.phone)));
});

router.post("/account/logout-all", requireAccount, async (req, res) => {
  res.json({ ended: await accounts.endAllSessions(req.auth.accountId) });
});

router.delete("/account", requireAccount, async (req, res) => {
  await accounts.deleteAccount(req.auth.accountId);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Organization admins: who can run this organization

const admin = requireRole("admin");
const { intParam, optEnum, optInt, optString: optStr } = require("../lib/http");
const { orgUrl } = require("./platform");

router.get("/admin/members", admin, async (_req, res) => {
  res.json(await accounts.listMembers());
});

/** Adds someone by email; without an account yet they're invited. */
router.post("/admin/members", requireInteractiveAdmin, async (req, res) => {
  const r = await accounts.addMember({
    email: optStr(req.body.email, "email", { max: 254 }),
    role: optEnum(req.body.role, "role", ["admin", "scorekeeper"]),
    tournament_id: optInt(req.body.tournament_id, "tournament_id", { min: 1 }) ?? null,
  }, { invitedBy: req.auth.accountId, orgName: req.org.name, orgUrl: orgUrl(req.org.slug, req) });
  res.status(201).json(r);
});

router.patch("/admin/members/:accountId", requireInteractiveAdmin, async (req, res) => {
  res.json(await accounts.updateMember(intParam(req.params.accountId, "accountId"), {
    role: optEnum(req.body.role, "role", ["admin", "scorekeeper"]) ?? undefined,
    tournament_id: optInt(req.body.tournament_id, "tournament_id", { min: 1 }),
  }));
});

router.delete("/admin/members/:accountId", requireInteractiveAdmin, async (req, res) => {
  await accounts.removeMember(intParam(req.params.accountId, "accountId"));
  res.status(204).end();
});

router.delete("/admin/invites/:email", requireInteractiveAdmin, async (req, res) => {
  await accounts.removeInvite(optStr(req.params.email, "email", { max: 254 }) || "");
  res.status(204).end();
});

module.exports = router;

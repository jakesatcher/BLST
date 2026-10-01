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
  res.json(await accounts.accountView(req.auth.accountId));
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
// Admin: manage accounts

const admin = requireRole("admin");
const { intParam, optEnum, optInt, optBool } = require("../lib/http");

router.get("/admin/accounts", admin, async (_req, res) => {
  res.json(await accounts.listAccounts());
});

router.patch("/admin/accounts/:id", requireInteractiveAdmin, async (req, res) => {
  const tid = optInt(req.body.tournament_id, "tournament_id", { min: 1 });
  res.json(await accounts.updateAccount(intParam(req.params.id), {
    role: optEnum(req.body.role, "role", ["user", "scorekeeper", "admin"]) ?? undefined,
    tournamentId: tid,
    disabled: optBool(req.body.disabled, "disabled"),
  }));
});

router.post("/admin/accounts/:id/logout", requireInteractiveAdmin, async (req, res) => {
  res.json({ ended: await accounts.endAllSessions(intParam(req.params.id)) });
});

router.delete("/admin/accounts/:id", requireInteractiveAdmin, async (req, res) => {
  await accounts.deleteAccount(intParam(req.params.id));
  res.status(204).end();
});

module.exports = router;

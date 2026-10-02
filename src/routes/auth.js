const { Router } = require("express");
const config = require("../config");
const accounts = require("../services/accounts");
const notify = require("../services/notify");
const { rateLimit } = require("../lib/rateLimit");
const { requireAccount, requireRole, requireInteractiveAdmin } = require("../middleware/auth");
const { badRequest, HttpError } = require("../lib/http");
const db = require("../db");
const mfa = require("../services/mfa");

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
    dev_codes: !notify.emailConfigured() && config.auth.logCodes ? "codes are printed in the server log" : null,
  });
});

router.post("/auth/signup", starts, async (req, res) => {
  res.status(202).json(await accounts.startSignup(str(req.body.email)));
});

router.post("/auth/login", starts, async (req, res) => {
  res.status(202).json(await accounts.startLogin(str(req.body.email)));
});

router.post("/auth/setup", starts, async (req, res) => {
  res.status(202).json(await accounts.startSetup(str(req.body.setup_key), str(req.body.email)));
});

router.post("/auth/verify", verifies, async (req, res) => {
  const passkey = req.body.passkey && typeof req.body.passkey === "object" ? req.body.passkey : null;
  if (!req.body.code && !passkey) throw badRequest("Enter the code.");
  const r = await accounts.verify(str(req.body.challenge_id), str(String(req.body.code || "")).slice(0, 40), { passkey, req });
  // The audit log records who signed in (by account id, never email).
  if (r.account) req.auth.actor = `account:${r.account.id}`;
  res.json(r);
});

/** Passkey sign-in: options for the second step of a sign-in. */
router.post("/auth/passkey-options", verifies, async (req, res) => {
  res.json(await accounts.passkeyOptions(req, str(req.body.challenge_id)));
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

// Second factor: authenticator app, passkeys and backup codes. Setting up the
// first one needs only a signed-in session (and upgrades it to verified);
// once an account has one, changes need a session that passed it.

function mfaChange(req, _res, next) {
  if (req.auth.sessionMfa) return next();
  mfa.hasSecondFactor(req.auth.accountId).then((has) => {
    if (has) return next(new HttpError(403, "Sign out and sign back in with your authenticator or passkey to change this."));
    next();
  }, next);
}
async function accountRow(req) {
  return db.one("SELECT id, email FROM accounts WHERE id = $1", [req.auth.accountId]);
}
async function afterFirstFactor(req) {
  if (!req.auth.sessionMfa) await accounts.markSessionMfa(req.auth.sessionId);
}
/** Staff must keep at least one second factor. */
async function assertCanRemove(req) {
  const acct = await db.one("SELECT * FROM accounts WHERE id = $1", [req.auth.accountId]);
  const s = await mfa.status(acct.id);
  const count = (s.totp ? 1 : 0) + s.passkeys.length;
  if (count <= 1 && (await accounts.strongestRole(acct)) !== "user") {
    throw new HttpError(409, "Admins and scorekeepers need a second factor. Add another one before removing this.");
  }
}

router.post("/account/mfa/totp", requireAccount, mfaChange, async (req, res) => {
  const acct = await accountRow(req);
  res.json(await mfa.startTotp(acct.id, acct.email));
});

router.post("/account/mfa/totp/confirm", requireAccount, verifies, mfaChange, async (req, res) => {
  const backupCodes = await mfa.confirmTotp(req.auth.accountId, str(String(req.body.code || "")));
  await afterFirstFactor(req);
  res.json({ ok: true, backup_codes: backupCodes });
});

router.delete("/account/mfa/totp", requireAccount, mfaChange, async (req, res) => {
  await assertCanRemove(req);
  await mfa.removeTotp(req.auth.accountId);
  res.status(204).end();
});

router.post("/account/mfa/passkeys/options", requireAccount, mfaChange, async (req, res) => {
  res.json(await mfa.passkeyRegistrationOptions(req, await accountRow(req)));
});

router.post("/account/mfa/passkeys", requireAccount, verifies, mfaChange, async (req, res) => {
  if (!req.body.response || typeof req.body.response !== "object") throw badRequest("response is required");
  const backupCodes = await mfa.finishPasskeyRegistration(req, await accountRow(req), req.body.response, str(req.body.name));
  await afterFirstFactor(req);
  res.status(201).json({ ok: true, backup_codes: backupCodes });
});

router.delete("/account/mfa/passkeys/:id", requireAccount, mfaChange, async (req, res) => {
  await assertCanRemove(req);
  await mfa.removePasskey(req.auth.accountId, String(req.params.id).slice(0, 512));
  res.status(204).end();
});

router.post("/account/mfa/backup-codes", requireAccount, mfaChange, async (req, res) => {
  if (!(await mfa.hasSecondFactor(req.auth.accountId))) throw badRequest("Set up an authenticator app or passkey first.");
  res.json({ backup_codes: await mfa.regenerateBackupCodes(req.auth.accountId) });
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

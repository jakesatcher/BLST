const crypto = require("crypto");
const config = require("../config");
const db = require("../db");
const notify = require("./notify");
const { HttpError, badRequest } = require("../lib/http");
const { withOrg } = require("../lib/context");

// Accounts: passwordless sign-in with two factors for everyone.
//   1. a one-time code emailed to the address (proves the email), then
//   2. a one-time code texted to the phone on file (proves the phone).
// The only personal data kept is the email address and phone number.
//
// Every flow is a "challenge" row that moves email -> sms -> done. Codes are
// stored as HMACs, expire after 10 minutes and allow 5 guesses. Responses
// never reveal whether an email has an account (see startLogin/startSignup).

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 5;
const RESEND_COOLDOWN_S = 30;
const SENDS_PER_TARGET_PER_HOUR = 6;
const SESSION_PREFIX = "blss_";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (s) => crypto.createHmac("sha256", config.auth.secret).update(s).digest("hex");

// ---------------------------------------------------------------------------
// Input normalization

function normEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw badRequest("Enter a valid email address.");
  return s;
}

/** "(555) 123-4567" -> "+15551234567". Only allowed country codes pass. */
function normPhone(v) {
  const raw = String(v || "").trim();
  let digits = raw.replace(/[^\d]/g, "");
  const codes = config.auth.smsCountryCodes;
  if (!raw.startsWith("+")) {
    if (codes.includes("1") && digits.length === 10) digits = `1${digits}`;
    else if (!(codes.includes("1") && digits.length === 11 && digits.startsWith("1"))) {
      throw badRequest("Enter a mobile number with its country code, for example +1 555 123 4567.");
    }
  }
  const e164 = `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw badRequest("Enter a valid mobile number.");
  if (!codes.some((c) => digits.startsWith(c))) throw badRequest("Text messages can't be sent to that country.");
  if (digits.startsWith("1") && digits.length !== 11) throw badRequest("Enter a valid mobile number.");
  return e164;
}

function maskEmail(e) {
  const [user, domain] = String(e).split("@");
  return `${user.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
}
function maskPhone(p) {
  return p ? `•••• ${String(p).slice(-4)}` : null;
}

// ---------------------------------------------------------------------------
// Sending, with per-address and global caps (stops SMS-pumping fraud and
// mailbombing someone through the sign-up form).

async function checkSendBudget(channel, target) {
  const th = hmac(`${channel}:${target}`);
  const r = await db.one(
    `SELECT count(*) FILTER (WHERE target_hash = $2) AS mine, count(*) AS total
       FROM auth_send_log WHERE channel = $1 AND at > now() - interval '1 hour'`,
    [channel, th],
  );
  if (r.mine >= SENDS_PER_TARGET_PER_HOUR) throw new HttpError(429, "Too many codes sent to that address. Wait an hour and try again.");
  if (channel === "sms" && r.total >= config.auth.smsMaxPerHour) {
    console.warn("[security] global SMS hourly cap reached");
    throw new HttpError(429, "Text messages are busy right now. Try again shortly.");
  }
  return th;
}

/**
 * Sends a code. Ghost challenges (unknown emails) go through the same
 * checks and send-budget bookkeeping without sending anything, so neither
 * the responses nor the rate limits reveal whether an account exists.
 * Emails are sent in the background for the same reason (equal timing).
 */
async function deliver(channel, target, code, purpose, ghost) {
  notify.assertCanSend(channel);
  const th = await checkSendBudget(channel, target);
  await db.query("INSERT INTO auth_send_log (channel, target_hash) VALUES ($1, $2)", [channel, th]);
  if (ghost) return;
  if (channel === "email") {
    const what = { signup: "finish creating your account", login: "sign in", setup_admin: "set up the admin account", change_phone: "change your phone number" }[purpose];
    notify.sendEmail(target, `${code} is your BLST code`,
      `Your BLST code is ${code}\n\nEnter it to ${what}. It expires in ${CODE_TTL_MIN} minutes.\n\n` +
      "If you didn't ask for this, ignore this email; nothing changes without the code.").catch(() => {});
  } else if (code === null) {
    await notify.startSmsVerification(target);
  } else {
    // The last line lets phones offer the code automatically (WebOTP).
    const host = config.auth.appHost;
    await notify.sendSms(target, `Your BLST code is ${code}. It expires in ${CODE_TTL_MIN} min. Don't share it.${host ? `\n\n@${host} #${code}` : ""}`);
  }
}

const newCode = () => String(crypto.randomInt(0, 1e6)).padStart(6, "0");
const codeHash = (challengeId, step, code) => hmac(`${challengeId}:${step}:${code}`);

function stepTarget(ch) {
  return ch.step === "email" ? ch.email : ch.phone;
}

/** Sends the code for the challenge's current step (unless it's a ghost). */
// Marks an SMS step whose code Twilio Verify generated and will check.
const VERIFY_MARK = "twilio-verify";
const usesVerify = (ch) => ch.step === "sms" && !ch.ghost && notify.smsVerifyConfigured();

async function sendStep(ch) {
  if (usesVerify(ch)) {
    await db.query(
      "UPDATE auth_challenges SET code_hash = $2, attempts = 0, sends = sends + 1, last_sent_at = now() WHERE id = $1",
      [ch.id, VERIFY_MARK],
    );
    return deliver("sms", ch.phone, null, ch.purpose, false);
  }
  const code = newCode();
  await db.query(
    "UPDATE auth_challenges SET code_hash = $2, attempts = 0, sends = sends + 1, last_sent_at = now() WHERE id = $1",
    [ch.id, codeHash(ch.id, ch.step, code)],
  );
  await deliver(ch.step, stepTarget(ch), code, ch.purpose, ch.ghost);
}

async function createChallenge({ purpose, email, phone = null, accountId = null, ghost = false }) {
  const id = crypto.randomBytes(24).toString("base64url");
  const ch = await db.one(
    `INSERT INTO auth_challenges (id, purpose, email, phone, account_id, ghost, step, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'email', now() + make_interval(mins => $7)) RETURNING *`,
    [id, purpose, email, phone, accountId, ghost, CODE_TTL_MIN],
  );
  await sendStep(ch);
  return { challenge_id: id, step: "email", sent_to: maskEmail(email), expires_in: CODE_TTL_MIN * 60 };
}

// ---------------------------------------------------------------------------
// Starting flows

/** Sign in: email only. Unknown or disabled emails get an identical "ghost" flow. */
async function startLogin(rawEmail) {
  const email = normEmail(rawEmail);
  const acct = await db.one("SELECT id, phone FROM accounts WHERE email = $1 AND disabled_at IS NULL", [email]);
  if (!acct) {
    // Nothing is sent (the response looks the same, so it doesn't reveal who
    // has an account). Operators can see why in the log.
    console.log(`[auth] sign-in for ${maskEmail(email)}: no account with that email, so no code was sent. Use "Create account" (or "Set up admin" on a new install).`);
    return createChallenge({ purpose: "login", email, ghost: true });
  }
  return createChallenge({ purpose: "login", email, phone: acct.phone, accountId: acct.id });
}

/**
 * Sign up: email + mobile number. If the email already has an account this
 * quietly becomes a sign-in (codes go to the email and the phone on file),
 * so the response can't be used to discover who has an account.
 */
async function startSignup(rawEmail, rawPhone) {
  const email = normEmail(rawEmail);
  const phone = normPhone(rawPhone);
  const acct = await db.one("SELECT id, phone, disabled_at FROM accounts WHERE email = $1", [email]);
  if (acct && acct.disabled_at) return createChallenge({ purpose: "login", email, ghost: true });
  if (acct) return createChallenge({ purpose: "login", email, phone: acct.phone, accountId: acct.id });
  return createChallenge({ purpose: "signup", email, phone });
}

async function adminCount() {
  return (await db.one("SELECT count(*) AS n FROM accounts WHERE role = 'admin' AND disabled_at IS NULL")).n;
}

/** Whether the first global admin can still be created, and how. */
async function setupStatus() {
  const needed = (await adminCount()) === 0;
  return { needed, key_required: needed && !(config.allowOpenDev && !config.adminToken), key_source: config.adminToken ? "config" : "log" };
}

/**
 * First global admin. Allowed only while no admin account exists, and only
 * with the setup key (the ADMIN_TOKEN config var, or without it the key
 * generated at boot and printed to the log), then email + SMS codes.
 */
async function startSetup(setupKey, rawEmail, rawPhone) {
  const { safeEqual } = require("../middleware/auth");
  const status = await setupStatus();
  if (!status.needed) throw new HttpError(409, "An admin account already exists. Sign in, or ask an admin to make you one.");
  if (status.key_required) {
    const ok = config.adminToken
      ? Boolean(setupKey) && safeEqual(setupKey, config.adminToken)
      : await require("./bootstrap").checkSetupKey(setupKey);
    if (!ok) throw new HttpError(403, "That setup key isn't right. It's the ADMIN_TOKEN config var, or the setup key printed in the server log.");
  }
  return createChallenge({ purpose: "setup_admin", email: normEmail(rawEmail), phone: normPhone(rawPhone) });
}

/** Signed-in user changing their number: prove the email again, then the new phone. */
async function startPhoneChange(accountId, rawPhone) {
  const acct = await db.one("SELECT id, email FROM accounts WHERE id = $1", [accountId]);
  return createChallenge({ purpose: "change_phone", email: acct.email, phone: normPhone(rawPhone), accountId: acct.id });
}

// ---------------------------------------------------------------------------
// Verifying

async function loadChallenge(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw badRequest("challenge_id is missing");
  const ch = await db.one("SELECT * FROM auth_challenges WHERE id = $1", [id]);
  if (!ch || ch.expires_at < new Date()) throw new HttpError(410, "This code has expired. Start again.");
  if (ch.attempts >= MAX_ATTEMPTS) throw new HttpError(410, "Too many wrong codes. Start again.");
  return ch;
}

/**
 * Checks a code. After the email step the SMS code is sent; after the SMS
 * step the flow completes and (except for a phone change) a session starts.
 */
async function verify(challengeId, rawCode, { accountId, sessionId } = {}) {
  const ch = await loadChallenge(challengeId);
  if (ch.purpose === "change_phone" && ch.account_id !== accountId) throw new HttpError(403, "Sign in as the account that asked for this change.");
  const code = String(rawCode || "").replace(/\s/g, "");
  // Count the guess first so parallel requests can't exceed the limit.
  const counted = await db.one(
    "UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1 AND attempts < $2 RETURNING attempts",
    [ch.id, MAX_ATTEMPTS],
  );
  if (!counted) throw new HttpError(410, "Too many wrong codes. Start again.");
  const ok = ch.code_hash === VERIFY_MARK
    ? ch.step === "sms" && /^\d{4,10}$/.test(code) && (await notify.checkSmsVerification(ch.phone, code))
    : !ch.ghost && /^\d{6}$/.test(code) && ch.code_hash &&
      crypto.timingSafeEqual(Buffer.from(codeHash(ch.id, ch.step, code)), Buffer.from(ch.code_hash));
  if (!ok) {
    const left = MAX_ATTEMPTS - counted.attempts;
    throw new HttpError(400, left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Start again.");
  }

  if (ch.step === "email") {
    // Move to the SMS step with a fresh window; the code is single-use.
    const next = await db.one(
      `UPDATE auth_challenges SET step = 'sms', code_hash = NULL, attempts = 0, sends = 0,
              expires_at = now() + make_interval(mins => $2) WHERE id = $1 AND step = 'email' RETURNING *`,
      [ch.id, CODE_TTL_MIN],
    );
    if (!next) throw new HttpError(409, "This code was already used.");
    await sendStep(next);
    return { step: "sms", challenge_id: ch.id, sent_to: maskPhone(next.phone), expires_in: CODE_TTL_MIN * 60 };
  }

  // SMS step passed: consume the challenge so it can't be replayed.
  const used = await db.query("DELETE FROM auth_challenges WHERE id = $1", [ch.id]);
  if (!used.rowCount) throw new HttpError(409, "This code was already used.");
  return complete(ch, { sessionId });
}

async function complete(ch, { sessionId } = {}) {
  if (ch.purpose === "change_phone") {
    await db.query("UPDATE accounts SET phone = $2 WHERE id = $1", [ch.account_id, ch.phone]);
    // A new second factor ends every other session (OWASP session management).
    const ended = (await db.query("DELETE FROM auth_sessions WHERE account_id = $1 AND id IS DISTINCT FROM $2", [ch.account_id, sessionId ?? null])).rowCount;
    return { step: "done", phone_changed: true, other_sessions_ended: ended, account: await accountView(ch.account_id) };
  }
  let acct;
  if (ch.purpose === "login") {
    acct = await db.one("SELECT * FROM accounts WHERE id = $1 AND disabled_at IS NULL", [ch.account_id]);
    if (!acct) throw new HttpError(403, "This account is disabled.");
  } else if (ch.purpose === "signup") {
    acct = await db.one(
      "INSERT INTO accounts (email, phone) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING *",
      [ch.email, ch.phone],
    );
    if (!acct) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  } else if (ch.purpose === "setup_admin") {
    acct = await db.tx(async (c) => {
      // Serialize concurrent setups and re-check that no admin exists.
      await c.query("LOCK TABLE accounts IN SHARE ROW EXCLUSIVE MODE");
      const n = (await c.query("SELECT count(*) AS n FROM accounts WHERE role = 'admin' AND disabled_at IS NULL")).rows[0].n;
      if (n > 0) throw new HttpError(409, "An admin account already exists. Sign in instead.");
      return (await c.query(
        `INSERT INTO accounts (email, phone, role) VALUES ($1, $2, 'admin')
         ON CONFLICT (email) DO UPDATE SET role = 'admin', phone = EXCLUDED.phone, disabled_at = NULL
         RETURNING *`,
        [ch.email, ch.phone],
      )).rows[0];
    });
    invalidateAdminCache();
    // The first platform admin also runs the first organization.
    await withOrg(1, () => db.query(
      `INSERT INTO org_members (account_id, role) SELECT $1, 'admin'
        WHERE NOT EXISTS (SELECT 1 FROM org_members WHERE role = 'admin') ON CONFLICT (org_id, account_id) DO UPDATE SET role = 'admin'`,
      [acct.id],
    )).catch(() => {});
  }
  await claimInvites(acct);
  await db.query("UPDATE accounts SET last_login_at = now() WHERE id = $1", [acct.id]);
  const token = await createSession(acct);
  return { step: "done", token, account: await accountView(acct.id) };
}

/** Re-sends the current step's code (new code; the old one stops working). */
async function resend(challengeId) {
  const ch = await loadChallenge(challengeId);
  const wait = ch.last_sent_at ? RESEND_COOLDOWN_S - Math.floor((Date.now() - ch.last_sent_at.getTime()) / 1000) : 0;
  if (wait > 0) throw new HttpError(429, `Wait ${wait}s before asking for another code.`);
  if (ch.sends >= MAX_SENDS) throw new HttpError(429, "Too many codes for this sign-in. Start again.");
  await sendStep(ch);
  return { step: ch.step, challenge_id: ch.id, sent_to: ch.step === "email" ? maskEmail(ch.email) : maskPhone(ch.phone) };
}

// ---------------------------------------------------------------------------
// Sessions (bearer tokens; only a SHA-256 of each is stored)

function sessionHours(role) {
  return config.auth.sessionHours[role] || config.auth.sessionHours.user;
}

/**
 * The strongest access an account has anywhere (platform admin, an admin
 * or scorekeeper of any organization). Session limits follow it, so an
 * organization admin gets the short admin session everywhere.
 */
async function strongestRole(acct) {
  if (acct.role === "admin") return "admin";
  const r = await withOrg("*", () => db.one(
    "SELECT max(CASE role WHEN 'admin' THEN 2 ELSE 1 END) AS r FROM org_members WHERE account_id = $1", [acct.id]));
  return r && r.r === 2 ? "admin" : r && r.r === 1 ? "scorekeeper" : "user";
}

async function createSession(acct) {
  const token = `${SESSION_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  await db.query(
    "INSERT INTO auth_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))",
    [acct.id, sha256(token), sessionHours(await strongestRole(acct))],
  );
  return token;
}

const isSessionToken = (t) => typeof t === "string" && t.startsWith(SESSION_PREFIX);

/**
 * Resolves a session token to its account. Access is read live, and the
 * session's age is checked against the *current* strongest role, so someone
 * made an admin is held to the admin limit straight away.
 */
async function resolveSession(token) {
  const row = await db.one(
    `SELECT s.id AS session_id, s.created_at AS session_created, s.expires_at, s.last_used_at, a.*
       FROM auth_sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1`,
    [sha256(token)],
  );
  if (!row) return null;
  const top = await strongestRole(row);
  const maxAge = sessionHours(top) * 3600e3;
  // Admin sessions also end after a period without use (idle timeout).
  const idle = top === "admin" && Date.now() - row.last_used_at.getTime() > config.auth.adminIdleMinutes * 60e3;
  if (row.disabled_at || idle || row.expires_at < new Date() || Date.now() - row.session_created.getTime() > maxAge) {
    db.query("DELETE FROM auth_sessions WHERE id = $1", [row.session_id]).catch(() => {});
    return null;
  }
  if (Date.now() - row.last_used_at.getTime() > 60_000) {
    db.query("UPDATE auth_sessions SET last_used_at = now() WHERE id = $1", [row.session_id]).catch(() => {});
  }
  return row;
}

async function endSession(token) {
  if (isSessionToken(token)) await db.query("DELETE FROM auth_sessions WHERE token_hash = $1", [sha256(token)]);
}

async function endAllSessions(accountId) {
  return (await db.query("DELETE FROM auth_sessions WHERE account_id = $1", [accountId])).rowCount;
}

// ---------------------------------------------------------------------------
// Admin-exists cache: once a platform admin exists ADMIN_TOKEN is retired.

let adminCache = { at: 0, exists: false };
function invalidateAdminCache() {
  adminCache = { at: 0, exists: false };
}
async function adminAccountsExist() {
  if (Date.now() - adminCache.at < 15_000) return adminCache.exists;
  adminCache = { at: Date.now(), exists: (await adminCount()) > 0 };
  return adminCache.exists;
}

// ---------------------------------------------------------------------------
// Views

function view(a) {
  return {
    id: a.id, email: a.email, phone: maskPhone(a.phone), platform_admin: a.role === "admin",
    created_at: a.created_at, last_login_at: a.last_login_at, disabled: Boolean(a.disabled_at),
  };
}

/** The account plus the organizations it belongs to (or has asked for). */
async function accountView(id) {
  const a = await db.one("SELECT * FROM accounts WHERE id = $1", [id]);
  if (!a) return null;
  const orgs = await withOrg("*", () => db.many(
    `SELECT o.id, o.slug, o.name, o.status, o.factions_enabled, m.role
       FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE m.account_id = $1 ORDER BY o.name`, [id]));
  return { ...view(a), orgs };
}

// ---------------------------------------------------------------------------
// Platform: every account (platform admins only)

async function listAccounts() {
  const rows = await withOrg("*", () => db.many(
    `SELECT a.*,
            (SELECT count(*) FROM auth_sessions s WHERE s.account_id = a.id AND s.expires_at > now()) AS sessions,
            (SELECT coalesce(json_agg(json_build_object('slug', o.slug, 'name', o.name, 'role', m.role) ORDER BY o.name), '[]')
               FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE m.account_id = a.id) AS orgs
       FROM accounts a ORDER BY a.role = 'admin' DESC, a.email`));
  return rows.map((a) => ({ ...view(a), sessions: a.sessions, orgs: a.orgs }));
}

/** Refuses changes that would leave no active platform admin. */
async function assertNotLastPlatformAdmin(c, id) {
  const r = (await c.query(
    `SELECT (SELECT role = 'admin' AND disabled_at IS NULL FROM accounts WHERE id = $1) AS is_admin,
            (SELECT count(*) FROM accounts WHERE role = 'admin' AND disabled_at IS NULL) AS admins`,
    [id],
  )).rows[0];
  if (r.is_admin && r.admins <= 1) throw new HttpError(409, "This is the only platform admin. Make someone else a platform admin first.");
}

/** Refuses deleting someone who is the only admin of an organization. */
async function assertNotSoleOrgAdmin(id) {
  const orgs = await withOrg("*", () => db.many(
    `SELECT o.name FROM org_members m JOIN organizations o ON o.id = m.org_id
      WHERE m.account_id = $1 AND m.role = 'admin'
        AND (SELECT count(*) FROM org_members x WHERE x.org_id = m.org_id AND x.role = 'admin') = 1`, [id]));
  if (orgs.length) throw new HttpError(409, `This is the only admin of ${orgs.map((o) => o.name).join(", ")}. Make someone else an admin there first.`);
}

async function updateAccount(id, { platformAdmin, disabled }) {
  const out = await db.tx(async (c) => {
    await c.query("LOCK TABLE accounts IN SHARE ROW EXCLUSIVE MODE");
    const cur = (await c.query("SELECT * FROM accounts WHERE id = $1", [id])).rows[0];
    if (!cur) throw new HttpError(404, "account not found");
    const nextRole = platformAdmin === undefined ? cur.role : platformAdmin ? "admin" : "user";
    if ((cur.role === "admin" && nextRole !== "admin") || disabled === true) await assertNotLastPlatformAdmin(c, id);
    const row = (await c.query(
      `UPDATE accounts SET role = $2,
              disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN COALESCE(disabled_at, now()) ELSE NULL END
        WHERE id = $1 RETURNING *`,
      [id, nextRole, disabled ?? null],
    )).rows[0];
    // Platform role changes and disabling take effect immediately.
    if (disabled === true || nextRole !== cur.role) await c.query("DELETE FROM auth_sessions WHERE account_id = $1", [id]);
    return row;
  });
  invalidateAdminCache();
  return view(out);
}

async function deleteAccount(id) {
  await assertNotSoleOrgAdmin(id);
  await db.tx(async (c) => {
    await c.query("LOCK TABLE accounts IN SHARE ROW EXCLUSIVE MODE");
    await assertNotLastPlatformAdmin(c, id);
    const r = await c.query("DELETE FROM accounts WHERE id = $1", [id]);
    if (!r.rowCount) throw new HttpError(404, "account not found");
  });
  invalidateAdminCache();
}

// ---------------------------------------------------------------------------
// Organization members (runs in the current organization's context)

async function listMembers() {
  const members = await db.many(
    `SELECT m.account_id, m.role, m.tournament_id, m.created_at, t.name AS tournament,
            a.email, a.phone, a.last_login_at, a.disabled_at, a.role = 'admin' AS platform_admin
       FROM org_members m JOIN accounts a ON a.id = m.account_id LEFT JOIN tournaments t ON t.id = m.tournament_id
      ORDER BY m.role, a.email`,
  );
  const invites = await db.many(
    `SELECT i.email, i.role, i.tournament_id, i.created_at, t.name AS tournament
       FROM org_invites i LEFT JOIN tournaments t ON t.id = i.tournament_id ORDER BY i.created_at DESC`,
  );
  return {
    members: members.map(({ phone, disabled_at: d, ...m }) => ({ ...m, phone: maskPhone(phone), disabled: Boolean(d) })),
    invites,
  };
}

async function checkTournament(c, role, tournamentId) {
  const tid = role === "scorekeeper" ? tournamentId ?? null : null; // only scorekeepers are limited to one
  if (tid && !(await c.query("SELECT 1 FROM tournaments WHERE id = $1", [tid])).rowCount) throw badRequest("tournament not found");
  return tid;
}

async function assertNotLastOrgAdmin(c, accountId) {
  const r = (await c.query(
    `SELECT (SELECT role FROM org_members WHERE account_id = $1) AS role,
            (SELECT count(*) FROM org_members WHERE role = 'admin') AS admins`, [accountId])).rows[0];
  if (r.role === "admin" && r.admins <= 1) throw new HttpError(409, "This is the organization's only admin. Make someone else an admin first.");
}

/**
 * Gives someone access to this organization. If they have no account yet
 * an invitation is kept, and claimed when they sign up with that email.
 */
async function addMember({ email: rawEmail, role, tournament_id: tournamentId }, { invitedBy, orgName, orgUrl } = {}) {
  const email = normEmail(rawEmail);
  if (!["admin", "scorekeeper"].includes(role)) throw badRequest("role must be admin or scorekeeper");
  return db.tx(async (c) => {
    const tid = await checkTournament(c, role, tournamentId);
    const acct = (await c.query("SELECT id FROM accounts WHERE email = $1", [email])).rows[0];
    if (acct) {
      await c.query(
        `INSERT INTO org_members (account_id, role, tournament_id) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, account_id) DO UPDATE SET role = EXCLUDED.role, tournament_id = EXCLUDED.tournament_id`,
        [acct.id, role, tid],
      );
      return { added: true, account_id: acct.id };
    }
    await c.query(
      `INSERT INTO org_invites (email, role, tournament_id, invited_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, email) DO UPDATE SET role = EXCLUDED.role, tournament_id = EXCLUDED.tournament_id`,
      [email, role, tid, invitedBy || null],
    );
    if (orgName && orgUrl) {
      notify.sendEmail(email, `You're invited to ${orgName} on Beer League Stats`,
        `You've been given ${role} access to ${orgName}.\n\nCreate your account with this email address at ${orgUrl}/account#signup ` +
        "(you'll confirm it with a code sent to this email and one texted to your phone).").catch(() => {});
    }
    return { invited: true };
  });
}

async function updateMember(accountId, { role, tournament_id: tournamentId }) {
  return db.tx(async (c) => {
    const cur = (await c.query("SELECT * FROM org_members WHERE account_id = $1", [accountId])).rows[0];
    if (!cur) throw new HttpError(404, "member not found");
    const nextRole = role ?? cur.role;
    if (!["admin", "scorekeeper"].includes(nextRole)) throw badRequest("role must be admin or scorekeeper");
    if (cur.role === "admin" && nextRole !== "admin") await assertNotLastOrgAdmin(c, accountId);
    const tid = await checkTournament(c, nextRole, tournamentId === undefined ? cur.tournament_id : tournamentId);
    return (await c.query("UPDATE org_members SET role = $2, tournament_id = $3 WHERE account_id = $1 RETURNING *", [accountId, nextRole, tid])).rows[0];
  });
}

async function removeMember(accountId) {
  await db.tx(async (c) => {
    await assertNotLastOrgAdmin(c, accountId);
    const r = await c.query("DELETE FROM org_members WHERE account_id = $1", [accountId]);
    if (!r.rowCount) throw new HttpError(404, "member not found");
  });
}

async function removeInvite(email) {
  const r = await db.query("DELETE FROM org_invites WHERE email = $1", [String(email).toLowerCase()]);
  if (!r.rowCount) throw new HttpError(404, "invitation not found");
}

/** Turns invitations for this email into memberships (at every sign-in). */
async function claimInvites(acct) {
  return withOrg("*", async () => {
    const r = await db.query(
      `INSERT INTO org_members (org_id, account_id, role, tournament_id)
       SELECT org_id, $1, role, tournament_id FROM org_invites WHERE email = $2
       ON CONFLICT (org_id, account_id) DO NOTHING`, [acct.id, acct.email]);
    await db.query("DELETE FROM org_invites WHERE email = $1", [acct.email]);
    return r.rowCount;
  });
}

/** Housekeeping: expired challenges, sessions and old send-log rows. */
async function prune() {
  await db.query("DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 hour'");
  await db.query("DELETE FROM auth_sessions WHERE expires_at < now()");
  await db.query("DELETE FROM auth_send_log WHERE at < now() - interval '1 day'");
}

module.exports = {
  normEmail, normPhone, maskEmail, maskPhone,
  startLogin, startSignup, startSetup, startPhoneChange, setupStatus, verify, resend,
  isSessionToken, resolveSession, endSession, endAllSessions, adminAccountsExist, invalidateAdminCache,
  accountView, listAccounts, updateAccount, deleteAccount, prune, SESSION_PREFIX, strongestRole,
  listMembers, addMember, updateMember, removeMember, removeInvite, claimInvites,
};

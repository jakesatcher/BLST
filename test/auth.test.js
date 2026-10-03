// Accounts: an emailed one-time code for everyone, plus an authenticator app
// or passkey for admins and scorekeepers; the platform admin bootstrap,
// sessions and account administration.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, ADMIN } = require("./helpers");

let ctx;
let db;
let config;
let outbox;
let mfa;
let ipSeq = 10;
const nextIp = () => `203.0.113.${ipSeq++}`;
const secrets = {}; // email -> authenticator secret

async function call(method, path, { body, token, ip = "203.0.113.1" } = {}) {
  const headers = { "x-forwarded-for": ip };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${ctx.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Latest code emailed to an address via the dev outbox. */
function codeFor(to) {
  const msg = [...outbox].reverse().find((m) => m.to === to);
  assert.ok(msg, `a code was sent to ${to}`);
  return msg.text.match(/\b(\d{6})\b/)[1];
}

/** A fresh authenticator code (the replay guard is reset so tests can sign in repeatedly). */
async function totpFor(email) {
  await db.query("UPDATE accounts SET totp_last_step = 0 WHERE email = $1", [email]);
  return mfa.totpCode(secrets[email]);
}

/** Runs a started flow through its steps and returns the final response. */
async function finish(start, email, ip) {
  assert.equal(start.status, 202, JSON.stringify(start.body));
  assert.equal(start.body.step, "email");
  let r = await call("POST", "/auth/verify", { body: { challenge_id: start.body.challenge_id, code: codeFor(email) }, ip });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.step === "mfa") {
    r = await call("POST", "/auth/verify", { body: { challenge_id: start.body.challenge_id, code: await totpFor(email) }, ip });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal(r.body.step, "done");
  return r.body;
}

async function signUp(email) {
  const ip = nextIp();
  return finish(await call("POST", "/auth/signup", { body: { email }, ip }), email.toLowerCase(), ip);
}

async function signIn(email) {
  await db.query("DELETE FROM auth_send_log"); // tests sign in more than the hourly per-address cap
  const ip = nextIp();
  return finish(await call("POST", "/auth/login", { body: { email }, ip }), email, ip);
}

/** Sets up an authenticator app for the signed-in account; returns its backup codes. */
async function enroll(token, email) {
  const s = await call("POST", "/account/mfa/totp", { token, ip: nextIp() });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.match(s.body.uri, /^otpauth:\/\/totp\//);
  assert.match(s.body.qr, /^data:image\/svg\+xml;base64,/);
  secrets[email] = s.body.secret.replace(/\s/g, "");
  const c = await call("POST", "/account/mfa/totp/confirm", { token, body: { code: mfa.totpCode(secrets[email]) }, ip: nextIp() });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return c.body.backup_codes;
}

test.before(async () => {
  ctx = await startApp();
  db = require("../src/db");
  config = require("../src/config");
  outbox = require("../src/services/notify").outbox;
  mfa = require("../src/services/mfa");
});

test.after(async () => {
  ctx.server.close();
  await db.close();
});

test("standard user signs up with an emailed code; only the email is stored", async () => {
  const r = await signUp("Fan@Example.com");
  assert.match(r.token, /^blss_/);
  assert.equal(r.account.email, "fan@example.com");
  assert.equal(r.account.platform_admin, false);
  assert.equal(r.account.staff, false);
  assert.equal(r.mfa_setup_required, false, "ordinary accounts don't need a second factor");
  assert.deepEqual(r.account.orgs, [], "a new account has no access to any organization");
  assert.equal(r.account.phone, undefined);

  const me = await call("GET", "/account", { token: r.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, "fan@example.com");
  assert.equal((await call("POST", "/tournaments", { token: r.token, body: { name: "x" } })).status, 403);

  // Data minimization: the only personal data is the email; the rest is sign-in state.
  const cols = (await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts' ORDER BY ordinal_position")).map((c) => c.column_name);
  assert.deepEqual(cols, ["id", "email", "role", "created_at", "last_login_at", "disabled_at", "totp_secret_enc", "totp_pending_enc", "totp_last_step"]);
  // Codes and session tokens are stored only as hashes.
  const s = await db.one("SELECT token_hash FROM auth_sessions LIMIT 1");
  assert.notEqual(s.token_hash, r.token);
  assert.ok(!(await db.one("SELECT 1 FROM auth_challenges WHERE code_hash ~ '^[0-9]{6}$'")));

  // Without a second factor, signing in again is just the emailed code.
  assert.match((await signIn("fan@example.com")).token, /^blss_/);
});

test("wrong codes are limited and codes are single-use", async () => {
  const ip = nextIp();
  await signUp("limits@example.com");
  const start = await call("POST", "/auth/login", { body: { email: "limits@example.com" }, ip });
  for (let i = 4; i >= 1; i--) {
    const r = await call("POST", "/auth/verify", { body: { challenge_id: start.body.challenge_id, code: "000000" }, ip });
    assert.equal(r.status, 400);
    assert.match(r.body.error, new RegExp(`${i} tr`));
  }
  assert.equal((await call("POST", "/auth/verify", { body: { challenge_id: start.body.challenge_id, code: "000001" }, ip })).status, 400);
  // Even the right code is refused once the attempts are used up.
  const r = await call("POST", "/auth/verify", { body: { challenge_id: start.body.challenge_id, code: codeFor("limits@example.com") }, ip });
  assert.equal(r.status, 410);

  // Replaying a finished challenge fails.
  const s2 = await call("POST", "/auth/login", { body: { email: "limits@example.com" }, ip: nextIp() });
  const ec = codeFor("limits@example.com");
  assert.equal((await call("POST", "/auth/verify", { body: { challenge_id: s2.body.challenge_id, code: ec }, ip })).body.step, "done");
  assert.equal((await call("POST", "/auth/verify", { body: { challenge_id: s2.body.challenge_id, code: ec }, ip })).status, 410);
});

test("sign-in and sign-up don't reveal whether an email has an account", async () => {
  await signUp("known@example.com");
  const sent = outbox.length;
  const unknown = await call("POST", "/auth/login", { body: { email: "nobody@example.com" }, ip: nextIp() });
  const known = await call("POST", "/auth/login", { body: { email: "known@example.com" }, ip: nextIp() });
  assert.equal(unknown.status, known.status);
  assert.deepEqual(Object.keys(unknown.body).sort(), Object.keys(known.body).sort());
  assert.equal(outbox.length, sent + 1, "nothing is sent for an unknown email");
  // A ghost flow can never be completed.
  const bad = await call("POST", "/auth/verify", { body: { challenge_id: unknown.body.challenge_id, code: "123456" } });
  assert.equal(bad.status, 400);

  // Signing up with a taken email turns into a sign-in; no second account.
  const ip = nextIp();
  const r = await finish(await call("POST", "/auth/signup", { body: { email: "known@example.com" }, ip }), "known@example.com", ip);
  assert.equal(r.account.email, "known@example.com");
  assert.equal((await db.one("SELECT count(*) AS n FROM accounts WHERE email = 'known@example.com'")).n, 1);
});

test("input checks and per-address send caps", async () => {
  assert.equal((await call("POST", "/auth/signup", { body: { email: "not-an-email" }, ip: nextIp() })).status, 400);
  // Mailbombing one address is capped (unknown addresses too, so the cap
  // itself doesn't reveal which emails have accounts).
  let last;
  for (let i = 0; i < 7; i++) last = await call("POST", "/auth/login", { body: { email: "target@example.com" }, ip: nextIp() });
  assert.equal(last.status, 429);
});

test("resend has a cooldown", async () => {
  await signUp("resend@example.com");
  const ip = nextIp();
  const start = await call("POST", "/auth/login", { body: { email: "resend@example.com" }, ip });
  const r = await call("POST", "/auth/resend", { body: { challenge_id: start.body.challenge_id }, ip });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Wait \d+s/);
});

test("platform admin setup: setup key, emailed code, then an authenticator before any admin access", async () => {
  let st = (await call("GET", "/auth/status")).body;
  assert.equal(st.setup_needed, true);
  assert.equal(st.setup_key_required, true);
  // Before any admin account exists the admin password still works.
  assert.equal((await call("GET", "/admin/members", { token: ADMIN })).status, 200);

  assert.equal((await call("POST", "/auth/setup", { body: { setup_key: "wrong", email: "boss@example.com" }, ip: nextIp() })).status, 403);
  const ip = nextIp();
  const done = await finish(await call("POST", "/auth/setup", { body: { setup_key: ADMIN, email: "boss@example.com" }, ip }), "boss@example.com", ip);
  assert.equal(done.account.platform_admin, true);
  assert.deepEqual(done.account.orgs.map((o) => [o.slug, o.role]), [["blpa", "admin"]], "and runs the first organization");
  assert.equal(done.mfa_setup_required, true);
  const first = done.token;

  // No admin access until a second factor is set up.
  let me = (await call("GET", "/me", { token: first })).body;
  assert.equal(me.role, "readonly", "can view the league, nothing more");
  assert.equal(me.mfa_required, true);
  assert.equal(me.platform_admin, false);
  assert.equal((await call("POST", "/tournaments", { token: first, body: { name: "x" } })).status, 403);
  assert.equal((await call("GET", "/platform/accounts", { token: first })).status, 403);

  // A wrong code doesn't turn it on.
  await call("POST", "/account/mfa/totp", { token: first, ip: nextIp() });
  assert.equal((await call("POST", "/account/mfa/totp/confirm", { token: first, body: { code: "000000" }, ip: nextIp() })).status, 400);
  const backup = await enroll(first, "boss@example.com");
  assert.equal(backup.length, 10);
  assert.match(backup[0], /^[a-z2-7]{4}-[a-z2-7]{4}$/);
  // The secret is stored encrypted, never as the base32 key.
  const row = await db.one("SELECT totp_secret_enc FROM accounts WHERE email = 'boss@example.com'");
  assert.ok(!row.totp_secret_enc.includes(secrets["boss@example.com"]));
  me = (await call("GET", "/me", { token: first })).body;
  assert.equal(me.role, "admin", "the session that set it up is now verified");
  assert.equal(me.platform_admin, true);

  st = (await call("GET", "/auth/status")).body;
  assert.equal(st.setup_needed, false);
  assert.equal((await call("POST", "/auth/setup", { body: { setup_key: ADMIN, email: "x@example.com" }, ip: nextIp() })).status, 409);

  // ADMIN_TOKEN no longer grants access.
  const retired = await call("GET", "/admin/members", { token: ADMIN, ip: nextIp() });
  assert.equal(retired.status, 401);
  assert.match(retired.body.error, /retired/);

  // Signing in now needs the authenticator after the email code.
  const ip2 = nextIp();
  const s = await call("POST", "/auth/login", { body: { email: "boss@example.com" }, ip: ip2 });
  const step2 = await call("POST", "/auth/verify", { body: { challenge_id: s.body.challenge_id, code: codeFor("boss@example.com") }, ip: ip2 });
  assert.equal(step2.body.step, "mfa");
  assert.deepEqual(step2.body.methods, { totp: true, passkey: false, backup_code: true });
  assert.equal((await call("POST", "/auth/verify", { body: { challenge_id: s.body.challenge_id, code: "000000" }, ip: ip2 })).status, 400);
  const code = await totpFor("boss@example.com");
  const ok = await call("POST", "/auth/verify", { body: { challenge_id: s.body.challenge_id, code }, ip: ip2 });
  assert.equal(ok.body.step, "done");
  assert.equal((await call("GET", "/me", { token: ok.body.token })).body.role, "admin");
  assert.equal((await call("POST", "/tournaments", { token: ok.body.token, body: { name: "Admin-made" } })).status, 201);

  // The same authenticator code can't be used twice.
  const ip3 = nextIp();
  const s3 = await call("POST", "/auth/login", { body: { email: "boss@example.com" }, ip: ip3 });
  await call("POST", "/auth/verify", { body: { challenge_id: s3.body.challenge_id, code: codeFor("boss@example.com") }, ip: ip3 });
  assert.equal((await call("POST", "/auth/verify", { body: { challenge_id: s3.body.challenge_id, code }, ip: ip3 })).status, 400, "replay refused");
  // A backup code works, once.
  const b = await call("POST", "/auth/verify", { body: { challenge_id: s3.body.challenge_id, code: backup[0].toUpperCase() }, ip: ip3 });
  assert.equal(b.body.step, "done");
  const ip4 = nextIp();
  const s4 = await call("POST", "/auth/login", { body: { email: "boss@example.com" }, ip: ip4 });
  await call("POST", "/auth/verify", { body: { challenge_id: s4.body.challenge_id, code: codeFor("boss@example.com") }, ip: ip4 });
  assert.equal((await call("POST", "/auth/verify", { body: { challenge_id: s4.body.challenge_id, code: backup[0] }, ip: ip4 })).status, 400);

  // Break-glass brings ADMIN_TOKEN back (for a lost phone).
  config.auth.adminTokenBreakGlass = true;
  try {
    assert.equal((await call("GET", "/admin/members", { token: ADMIN, ip: nextIp() })).status, 200);
  } finally {
    config.auth.adminTokenBreakGlass = false;
  }

  // Admin sessions are short-lived.
  await db.query("UPDATE auth_sessions SET created_at = now() - interval '13 hours' WHERE account_id = $1", [done.account.id]);
  const old = await call("GET", "/me", { token: first, ip: nextIp() });
  assert.equal(old.status, 401);
  assert.match(old.body.error, /expired/);
});

test("passkeys: options for registration and for the sign-in step", async () => {
  const boss = (await signIn("boss@example.com")).token;
  const reg = await call("POST", "/account/mfa/passkeys/options", { token: boss, ip: nextIp() });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.rp.name, "Beer League Stats");
  assert.ok(reg.body.challenge && reg.body.user.id);
  assert.equal(reg.body.attestation, "none");
  // A made-up response is refused, and the request is used up.
  const bad = await call("POST", "/account/mfa/passkeys", { token: boss, body: { response: { id: "x", rawId: "x", type: "public-key", response: {} } }, ip: nextIp() });
  assert.equal(bad.status, 400);
  // Passkey options at sign-in only come after the emailed code, for accounts with passkeys.
  const ip = nextIp();
  const s = await call("POST", "/auth/login", { body: { email: "boss@example.com" }, ip });
  assert.equal((await call("POST", "/auth/passkey-options", { body: { challenge_id: s.body.challenge_id }, ip })).status, 400);
  await call("POST", "/auth/verify", { body: { challenge_id: s.body.challenge_id, code: codeFor("boss@example.com") }, ip });
  assert.equal((await call("POST", "/auth/passkey-options", { body: { challenge_id: s.body.challenge_id }, ip })).status, 400, "no passkeys yet");
  // A forged passkey assertion doesn't sign in.
  const forged = await call("POST", "/auth/verify", { body: { challenge_id: s.body.challenge_id, passkey: { id: "nope", response: {} } }, ip });
  assert.equal(forged.status, 400);
});

test("organization admins give people access by email; staff need a second factor", async () => {
  const boss = (await signIn("boss@example.com")).token;
  const sk = await signUp("rink@example.com");
  const t = await call("POST", "/tournaments", { token: boss, body: { name: "Scoped Cup", num_teams: 2 } });
  const t2 = await call("POST", "/tournaments", { token: boss, body: { name: "Other Cup", num_teams: 2 } });

  assert.equal((await call("GET", "/admin/members", { token: sk.token })).status, 403);

  const add = await call("POST", "/admin/members", { token: boss, body: { email: "Rink@Example.com", role: "scorekeeper", tournament_id: t.body.id } });
  assert.equal(add.status, 201);
  assert.equal(add.body.added, true);
  // Scorekeeper access waits for a second factor.
  let me = (await call("GET", "/me", { token: sk.token })).body;
  assert.equal(me.role, "readonly", "can view, not score, until then");
  assert.equal(me.mfa_required, true);
  await enroll(sk.token, "rink@example.com");
  me = (await call("GET", "/me", { token: sk.token })).body;
  assert.equal(me.role, "scorekeeper");
  assert.equal(me.tournament_id, t.body.id);
  const teams = (await call("GET", `/tournaments/${t.body.id}`, { token: boss })).body.teams;
  const teams2 = (await call("GET", `/tournaments/${t2.body.id}`, { token: boss })).body.teams;
  const g = await call("POST", `/tournaments/${t.body.id}/games`, { token: boss, body: { home_team_id: teams[0].id, away_team_id: teams[1].id } });
  const g2 = await call("POST", `/tournaments/${t2.body.id}/games`, { token: boss, body: { home_team_id: teams2[0].id, away_team_id: teams2[1].id } });
  assert.equal((await call("POST", `/games/${g.body.id}/start`, { token: sk.token })).status, 200);
  assert.equal((await call("POST", `/games/${g2.body.id}/start`, { token: sk.token })).status, 403, "scoped to one tournament");

  // Staff can't remove their only second factor.
  assert.equal((await call("DELETE", "/account/mfa/totp", { token: sk.token })).status, 409);

  // Someone without an account is invited, and gets access when they sign up (after a second factor).
  const inv = await call("POST", "/admin/members", { token: boss, body: { email: "newbie@example.com", role: "admin" } });
  assert.equal(inv.body.invited, true);
  const members = (await call("GET", "/admin/members", { token: boss })).body;
  assert.ok(members.members.every((m) => m.phone === undefined));
  assert.equal(members.members.find((m) => m.email === "rink@example.com").second_factor, true);
  assert.deepEqual(members.invites.map((i) => i.email), ["newbie@example.com"]);
  const newbie = await signUp("newbie@example.com");
  assert.deepEqual(newbie.account.orgs.map((o) => [o.slug, o.role]), [["blpa", "admin"]]);
  assert.equal(newbie.mfa_setup_required, true);
  assert.equal((await call("GET", "/admin/members", { token: newbie.token })).status, 403);
  await enroll(newbie.token, "newbie@example.com");
  assert.equal((await call("GET", "/admin/members", { token: newbie.token })).status, 200);
  assert.equal((await call("GET", "/admin/members", { token: boss })).body.invites.length, 0);
  assert.equal((await call("GET", "/platform/accounts", { token: newbie.token })).status, 403, "org admins aren't platform admins");
  await db.query("UPDATE auth_sessions SET created_at = now() - interval '13 hours' WHERE account_id = $1", [newbie.account.id]);
  assert.equal((await call("GET", "/me", { token: newbie.token, ip: nextIp() })).status, 401, "short admin sessions");
  await call("DELETE", `/admin/members/${newbie.account.id}`, { token: boss });

  // The only admin of an organization can't step down or delete themselves.
  const bossId = (await call("GET", "/account", { token: boss })).body.id;
  assert.equal((await call("PATCH", `/admin/members/${bossId}`, { token: boss, body: { role: "scorekeeper" } })).status, 409);
  assert.equal((await call("DELETE", `/admin/members/${bossId}`, { token: boss })).status, 409);
  assert.equal((await call("DELETE", "/account", { token: boss })).status, 409);
  assert.equal((await call("PATCH", `/platform/accounts/${bossId}`, { token: boss, body: { platform_admin: false } })).status, 409);
  assert.equal((await call("PATCH", `/platform/accounts/${bossId}`, { token: boss, body: { disabled: true } })).status, 409);

  // Lost phone: a platform admin resets the second factor; they set up a new one.
  const list = (await call("GET", "/platform/accounts", { token: boss })).body;
  const rinkRow = list.find((a) => a.email === "rink@example.com");
  assert.equal(rinkRow.second_factor, true);
  assert.ok(rinkRow.orgs.some((o) => o.slug === "blpa" && o.role === "scorekeeper"));
  assert.equal((await call("POST", `/platform/accounts/${sk.account.id}/reset-mfa`, { token: boss })).status, 200);
  assert.equal((await call("GET", "/me", { token: sk.token, ip: nextIp() })).status, 401, "their sessions end");
  const back = await signIn("rink@example.com");
  assert.equal(back.mfa_setup_required, true);

  // Platform admins can disable an account: sessions end, sign-in is ghosted.
  assert.equal((await call("PATCH", `/platform/accounts/${sk.account.id}`, { token: boss, body: { disabled: true } })).status, 200);
  assert.equal((await call("GET", "/me", { token: back.token, ip: nextIp() })).status, 401);
  const before = outbox.length;
  const s = await call("POST", "/auth/login", { body: { email: "rink@example.com" }, ip: nextIp() });
  assert.equal(s.status, 202);
  assert.equal(outbox.length, before);
});

test("self-service: second factor for anyone, changes need a verified session, sign out everywhere, delete", async () => {
  const a = await signUp("self@example.com");
  const backup = await enroll(a.token, "self@example.com");
  assert.equal(backup.length, 10);
  // Another session that only passed the email step can't change the second factor…
  const ip = nextIp();
  const s = await call("POST", "/auth/login", { body: { email: "self@example.com" }, ip });
  const step = await call("POST", "/auth/verify", { body: { challenge_id: s.body.challenge_id, code: codeFor("self@example.com") }, ip });
  assert.equal(step.body.step, "mfa", "once set up, it's asked for at every sign-in");
  const unverified = (await signUp("self2@example.com")).token; // a separate account without one
  assert.equal((await call("POST", "/account/mfa/totp", { token: unverified, ip: nextIp() })).status, 200, "first setup needs only a session");
  // …but the verified session can: new backup codes, remove (not staff, so allowed).
  const codes = await call("POST", "/account/mfa/backup-codes", { token: a.token, ip: nextIp() });
  assert.equal(codes.body.backup_codes.length, 10);
  assert.notDeepEqual(codes.body.backup_codes, backup);
  const view = (await call("GET", "/account", { token: a.token })).body;
  assert.equal(view.mfa.enabled, true);
  assert.equal(view.mfa.backup_codes_left, 10);
  assert.equal((await call("DELETE", "/account/mfa/totp", { token: a.token })).status, 204);
  assert.equal((await call("GET", "/account", { token: a.token })).body.mfa.enabled, false);

  const b = await signIn("self@example.com");
  assert.equal((await call("POST", "/auth/logout", { token: a.token })).status, 204);
  assert.equal((await call("GET", "/account", { token: a.token, ip: nextIp() })).status, 401);
  assert.equal((await call("POST", "/account/logout-all", { token: b.token })).body.ended, 1);
  assert.equal((await call("GET", "/account", { token: b.token, ip: nextIp() })).status, 401);

  const c = await signIn("self@example.com");
  assert.equal((await call("DELETE", "/account", { token: c.token })).status, 204);
  assert.ok(!(await db.one("SELECT 1 FROM accounts WHERE email = 'self@example.com'")));
  assert.ok(!(await db.one("SELECT 1 FROM auth_sessions s LEFT JOIN accounts a ON a.id = s.account_id WHERE a.id IS NULL")));
});

test("account routes need a signed-in account, not an API key", async () => {
  assert.equal((await call("GET", "/account")).status, 401);
  assert.equal((await call("POST", "/account/mfa/totp")).status, 401);
  config.auth.adminTokenBreakGlass = true;
  try {
    assert.equal((await call("GET", "/account", { token: ADMIN })).status, 401);
  } finally {
    config.auth.adminTokenBreakGlass = false;
  }
});

test("admin sessions also end after 2 hours without use", async () => {
  const s = await signIn("boss@example.com");
  assert.equal((await call("GET", "/me", { token: s.token, ip: nextIp() })).status, 200);
  await db.query("UPDATE auth_sessions SET last_used_at = now() - interval '3 hours' WHERE account_id = $1", [s.account.id]);
  const r = await call("GET", "/me", { token: s.token, ip: nextIp() });
  assert.equal(r.status, 401);
});

test("email can go through Resend's HTTPS API (for hosts that block SMTP)", async () => {
  const config = require("../src/config");
  const notify = require("../src/services/notify");
  const realFetch = global.fetch;
  const calls = [];
  config.email.resendApiKey = "re_test_key";
  try {
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({ id: "x" }), { status: calls.length === 1 ? 200 : 422 });
    };
    assert.equal(notify.emailConfigured(), true);
    await notify.sendEmail("someone@example.com", "123456 is your BLST code", "Your BLST code is 123456");
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].opts.headers.authorization, "Bearer re_test_key");
    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(body.to, ["someone@example.com"]);
    assert.equal(body.subject, "123456 is your BLST code");
    await assert.rejects(notify.sendEmail("someone@example.com", "s", "t"), (err) => err.status === 502);
  } finally {
    global.fetch = realFetch;
    config.email.resendApiKey = "";
  }
});

// Accounts: email + SMS one-time codes (MFA for everyone), the global admin
// bootstrap, sessions and account administration.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, ADMIN } = require("./helpers");

let ctx;
let db;
let config;
let outbox;
let ipSeq = 10;
const nextIp = () => `203.0.113.${ipSeq++}`;

async function call(method, path, { body, token, ip = "203.0.113.1" } = {}) {
  const headers = { "x-forwarded-for": ip };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${ctx.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Latest code sent to an address via the dev outbox. */
function codeFor(to) {
  const msg = [...outbox].reverse().find((m) => m.to === to);
  assert.ok(msg, `a code was sent to ${to}`);
  return msg.text.match(/\b(\d{6})\b/)[1];
}

/** Runs a started flow through both steps and returns the final response. */
async function finish(start, rawEmail, rawPhone, ip) {
  const accounts = require("../src/services/accounts");
  const email = accounts.normEmail(rawEmail);
  const phone = accounts.normPhone(rawPhone);
  assert.equal(start.status, 202, JSON.stringify(start.body));
  assert.equal(start.body.step, "email");
  const step2 = await call("POST", "/auth/verify", { body: { challenge_id: start.body.challenge_id, code: codeFor(email) }, ip });
  assert.equal(step2.status, 200, JSON.stringify(step2.body));
  assert.equal(step2.body.step, "sms");
  assert.match(step2.body.sent_to, new RegExp(`${phone.slice(-4)}$`));
  const done = await call("POST", "/auth/verify", { body: { challenge_id: start.body.challenge_id, code: codeFor(phone) }, ip });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.step, "done");
  return done.body;
}

async function signUp(email, phone) {
  const ip = nextIp();
  return finish(await call("POST", "/auth/signup", { body: { email, phone }, ip }), email, phone, ip);
}

async function signIn(email, phone) {
  const ip = nextIp();
  return finish(await call("POST", "/auth/login", { body: { email }, ip }), email, phone, ip);
}

test.before(async () => {
  ctx = await startApp();
  db = require("../src/db");
  config = require("../src/config");
  outbox = require("../src/services/notify").outbox;
});

test.after(async () => {
  ctx.server.close();
  await db.close();
});

test("standard user signs up with email + SMS codes; only email and phone are stored", async () => {
  const r = await signUp("Fan@Example.com", "(555) 201-0001");
  assert.match(r.token, /^blss_/);
  assert.equal(r.account.email, "fan@example.com");
  assert.equal(r.account.platform_admin, false);
  assert.deepEqual(r.account.orgs, [], "a new account has no access to any organization");
  assert.equal(r.account.phone, "•••• 0001", "phone is masked in responses");

  const me = await call("GET", "/account", { token: r.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, "fan@example.com");
  // A standard account has no staff access.
  assert.equal((await call("POST", "/tournaments", { token: r.token, body: { name: "x" } })).status, 403);

  // Data minimization: the only personal data columns are email and phone.
  const cols = (await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts' ORDER BY ordinal_position")).map((c) => c.column_name);
  assert.deepEqual(cols, ["id", "email", "phone", "role", "created_at", "last_login_at", "disabled_at"]);
  const row = await db.one("SELECT email, phone FROM accounts WHERE email = 'fan@example.com'");
  assert.equal(row.phone, "+15552010001");
  // Codes and session tokens are stored only as hashes.
  const s = await db.one("SELECT token_hash FROM auth_sessions LIMIT 1");
  assert.notEqual(s.token_hash, r.token);
  assert.ok(!(await db.one("SELECT 1 FROM auth_challenges WHERE code_hash ~ '^[0-9]{6}$'")));

  // Signing in again needs both factors.
  const again = await signIn("fan@example.com", "+15552010001");
  assert.match(again.token, /^blss_/);
});

test("wrong codes are limited and codes are single-use", async () => {
  const ip = nextIp();
  await signUp("limits@example.com", "+15552010002");
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

  // Replaying a used code / finished challenge fails.
  const s2 = await call("POST", "/auth/login", { body: { email: "limits@example.com" }, ip: nextIp() });
  const ec = codeFor("limits@example.com");
  assert.equal((await call("POST", "/auth/verify", { body: { challenge_id: s2.body.challenge_id, code: ec }, ip })).body.step, "sms");
  const sc = codeFor("+15552010002");
  assert.equal((await call("POST", "/auth/verify", { body: { challenge_id: s2.body.challenge_id, code: sc }, ip })).body.step, "done");
  assert.equal((await call("POST", "/auth/verify", { body: { challenge_id: s2.body.challenge_id, code: sc }, ip })).status, 410);
});

test("sign-in and sign-up don't reveal whether an email has an account", async () => {
  await signUp("known@example.com", "+15552010003");
  const sent = outbox.length;
  const unknown = await call("POST", "/auth/login", { body: { email: "nobody@example.com" }, ip: nextIp() });
  const known = await call("POST", "/auth/login", { body: { email: "known@example.com" }, ip: nextIp() });
  assert.equal(unknown.status, known.status);
  assert.deepEqual(Object.keys(unknown.body).sort(), Object.keys(known.body).sort());
  assert.equal(outbox.length, sent + 1, "nothing is sent for an unknown email");
  // A ghost flow can never be completed.
  const bad = await call("POST", "/auth/verify", { body: { challenge_id: unknown.body.challenge_id, code: "123456" } });
  assert.equal(bad.status, 400);

  // Signing up with a taken email turns into a sign-in: the SMS goes to the
  // number on file, not the one typed, and no second account is created.
  const ip = nextIp();
  const start = await call("POST", "/auth/signup", { body: { email: "known@example.com", phone: "+15559999999" }, ip });
  assert.equal(start.status, 202);
  const r = await finish(start, "known@example.com", "+15552010003", ip);
  assert.equal(r.account.email, "known@example.com");
  assert.ok(!outbox.some((m) => m.to === "+15559999999"));
  assert.equal((await db.one("SELECT count(*) AS n FROM accounts WHERE email = 'known@example.com'")).n, 1);
});

test("input checks, SMS country allow-list and per-address send caps", async () => {
  assert.equal((await call("POST", "/auth/signup", { body: { email: "not-an-email", phone: "+15552010004" }, ip: nextIp() })).status, 400);
  assert.equal((await call("POST", "/auth/signup", { body: { email: "a@example.com", phone: "12" }, ip: nextIp() })).status, 400);
  const intl = await call("POST", "/auth/signup", { body: { email: "a@example.com", phone: "+447700900123" }, ip: nextIp() });
  assert.equal(intl.status, 400);
  assert.match(intl.body.error, /country/);

  // Mailbombing one address is capped (unknown addresses too, so the cap
  // itself doesn't reveal which emails have accounts).
  let last;
  for (let i = 0; i < 7; i++) last = await call("POST", "/auth/login", { body: { email: "target@example.com" }, ip: nextIp() });
  assert.equal(last.status, 429);
});

test("resend has a cooldown", async () => {
  await signUp("resend@example.com", "+15552010005");
  const ip = nextIp();
  const start = await call("POST", "/auth/login", { body: { email: "resend@example.com" }, ip });
  const r = await call("POST", "/auth/resend", { body: { challenge_id: start.body.challenge_id }, ip });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Wait \d+s/);
});

test("global admin setup: setup key once, MFA required, then ADMIN_TOKEN is retired", async () => {
  let st = (await call("GET", "/auth/status")).body;
  assert.equal(st.setup_needed, true);
  assert.equal(st.setup_key_required, true);
  // Before any admin account exists the admin password still works.
  assert.equal((await call("GET", "/admin/members", { token: ADMIN })).status, 200);

  assert.equal((await call("POST", "/auth/setup", { body: { setup_key: "wrong", email: "boss@example.com", phone: "+15552010010" }, ip: nextIp() })).status, 403);
  const ip = nextIp();
  const start = await call("POST", "/auth/setup", { body: { setup_key: ADMIN, email: "boss@example.com", phone: "+15552010010" }, ip });
  const done = await finish(start, "boss@example.com", "+15552010010", ip);
  assert.equal(done.account.platform_admin, true);
  assert.deepEqual(done.account.orgs.map((o) => [o.slug, o.role]), [["blpa", "admin"]], "and runs the first organization");
  const boss = done.token;

  st = (await call("GET", "/auth/status")).body;
  assert.equal(st.setup_needed, false);
  assert.equal((await call("POST", "/auth/setup", { body: { setup_key: ADMIN, email: "x@example.com", phone: "+15552010011" }, ip: nextIp() })).status, 409);

  // ADMIN_TOKEN no longer grants access; the MFA'd admin session does.
  const retired = await call("GET", "/admin/members", { token: ADMIN, ip: nextIp() });
  assert.equal(retired.status, 401);
  assert.match(retired.body.error, /retired/);
  const me = await call("GET", "/me", { token: boss });
  assert.equal(me.body.role, "admin");
  assert.equal(me.body.via, "session");
  assert.equal((await call("POST", "/tournaments", { token: boss, body: { name: "Admin-made" } })).status, 201);

  // Break-glass brings it back (for a lost phone).
  config.auth.adminTokenBreakGlass = true;
  try {
    assert.equal((await call("GET", "/admin/members", { token: ADMIN, ip: nextIp() })).status, 200);
  } finally {
    config.auth.adminTokenBreakGlass = false;
  }

  // Admin sessions are short-lived.
  await db.query("UPDATE auth_sessions SET created_at = now() - interval '13 hours' WHERE account_id = $1", [done.account.id]);
  const old = await call("GET", "/me", { token: boss, ip: nextIp() });
  assert.equal(old.status, 401);
  assert.match(old.body.error, /expired/);
});

test("organization admins give people access by email; platform admins manage accounts", async () => {
  const boss = (await signIn("boss@example.com", "+15552010010")).token;
  const sk = await signUp("rink@example.com", "+15552010020");
  const t = await call("POST", "/tournaments", { token: boss, body: { name: "Scoped Cup", num_teams: 2 } });
  const t2 = await call("POST", "/tournaments", { token: boss, body: { name: "Other Cup", num_teams: 2 } });

  // Standard users can't administer anything.
  assert.equal((await call("GET", "/admin/members", { token: sk.token })).status, 403);
  assert.equal((await call("POST", "/tournaments", { token: sk.token, body: { name: "x" } })).status, 403);

  // An existing account gets access right away (no new sign-in needed).
  const add = await call("POST", "/admin/members", { token: boss, body: { email: "Rink@Example.com", role: "scorekeeper", tournament_id: t.body.id } });
  assert.equal(add.status, 201);
  assert.equal(add.body.added, true);
  const me = (await call("GET", "/me", { token: sk.token })).body;
  assert.equal(me.role, "scorekeeper");
  assert.equal(me.tournament_id, t.body.id);
  const teams = (await call("GET", `/tournaments/${t.body.id}`)).body.teams;
  const teams2 = (await call("GET", `/tournaments/${t2.body.id}`)).body.teams;
  const g = await call("POST", `/tournaments/${t.body.id}/games`, { token: boss, body: { home_team_id: teams[0].id, away_team_id: teams[1].id } });
  const g2 = await call("POST", `/tournaments/${t2.body.id}/games`, { token: boss, body: { home_team_id: teams2[0].id, away_team_id: teams2[1].id } });
  assert.equal((await call("POST", `/games/${g.body.id}/start`, { token: sk.token })).status, 200);
  assert.equal((await call("POST", `/games/${g2.body.id}/start`, { token: sk.token })).status, 403, "scoped to one tournament");

  // Someone without an account is invited, and gets access when they sign up.
  const inv = await call("POST", "/admin/members", { token: boss, body: { email: "newbie@example.com", role: "admin" } });
  assert.equal(inv.body.invited, true);
  const members = (await call("GET", "/admin/members", { token: boss })).body;
  assert.ok(members.members.every((m) => /^•••• \d{4}$/.test(m.phone)), "admins see masked phones only");
  assert.deepEqual(members.invites.map((i) => i.email), ["newbie@example.com"]);
  const newbie = await signUp("newbie@example.com", "+15552010021");
  assert.deepEqual(newbie.account.orgs.map((o) => [o.slug, o.role]), [["blpa", "admin"]]);
  assert.equal((await call("GET", "/admin/members", { token: boss })).body.invites.length, 0);
  // Organization admins aren't platform admins.
  assert.equal((await call("GET", "/platform/accounts", { token: newbie.token })).status, 403);
  // …but they get the short admin session.
  await db.query("UPDATE auth_sessions SET created_at = now() - interval '13 hours' WHERE account_id = $1", [newbie.account.id]);
  assert.equal((await call("GET", "/me", { token: newbie.token, ip: nextIp() })).status, 401);
  await call("DELETE", `/admin/members/${newbie.account.id}`, { token: boss });

  // The only admin of an organization can't step down or delete themselves.
  const bossId = (await call("GET", "/account", { token: boss })).body.id;
  assert.equal((await call("PATCH", `/admin/members/${bossId}`, { token: boss, body: { role: "scorekeeper" } })).status, 409);
  assert.equal((await call("DELETE", `/admin/members/${bossId}`, { token: boss })).status, 409);
  assert.equal((await call("DELETE", "/account", { token: boss })).status, 409);
  // …nor stop being the only platform admin.
  assert.equal((await call("PATCH", `/platform/accounts/${bossId}`, { token: boss, body: { platform_admin: false } })).status, 409);
  assert.equal((await call("PATCH", `/platform/accounts/${bossId}`, { token: boss, body: { disabled: true } })).status, 409);

  // Platform admins can disable an account: sessions end, sign-in is ghosted.
  const list = (await call("GET", "/platform/accounts", { token: boss })).body;
  assert.ok(list.find((a) => a.email === "rink@example.com").orgs.some((o) => o.slug === "blpa" && o.role === "scorekeeper"));
  assert.equal((await call("PATCH", `/platform/accounts/${sk.account.id}`, { token: boss, body: { disabled: true } })).status, 200);
  assert.equal((await call("GET", "/me", { token: sk.token, ip: nextIp() })).status, 401);
  const before = outbox.length;
  const s = await call("POST", "/auth/login", { body: { email: "rink@example.com" }, ip: nextIp() });
  assert.equal(s.status, 202);
  assert.equal(outbox.length, before);
});

test("self-service: change phone with both factors, sign out everywhere, delete", async () => {
  const a = await signUp("self@example.com", "+15552010030");
  const b = await signIn("self@example.com", "+15552010030");
  const ip = nextIp();
  const start = await call("POST", "/account/phone", { token: a.token, body: { phone: "+15552010031" }, ip });
  assert.equal(start.status, 202);
  // Someone else's session can't finish this change.
  const other = await signUp("other@example.com", "+15552010032");
  const hijack = await call("POST", "/auth/verify", { token: other.token, body: { challenge_id: start.body.challenge_id, code: codeFor("self@example.com") }, ip });
  assert.equal(hijack.status, 403);
  const s1 = await call("POST", "/auth/verify", { token: a.token, body: { challenge_id: start.body.challenge_id, code: codeFor("self@example.com") }, ip });
  assert.equal(s1.body.step, "sms");
  const s2 = await call("POST", "/auth/verify", { token: a.token, body: { challenge_id: start.body.challenge_id, code: codeFor("+15552010031") }, ip });
  assert.equal(s2.body.phone_changed, true);
  assert.equal(s2.body.other_sessions_ended, 1, "a new phone ends the account's other sessions");
  assert.equal((await call("GET", "/account", { token: b.token, ip: nextIp() })).status, 401);
  assert.equal((await call("GET", "/account", { token: a.token, ip: nextIp() })).status, 200, "the session that changed it stays");
  assert.equal((await db.one("SELECT phone FROM accounts WHERE email = 'self@example.com'")).phone, "+15552010031");

  assert.equal((await call("POST", "/auth/logout", { token: a.token })).status, 204);
  assert.equal((await call("GET", "/account", { token: a.token, ip: nextIp() })).status, 401);
  const b2 = await signIn("self@example.com", "+15552010031");
  assert.equal((await call("POST", "/account/logout-all", { token: b2.token })).body.ended, 1);
  assert.equal((await call("GET", "/account", { token: b2.token, ip: nextIp() })).status, 401);

  const c = await signIn("self@example.com", "+15552010031");
  assert.equal((await call("DELETE", "/account", { token: c.token })).status, 204);
  assert.ok(!(await db.one("SELECT 1 FROM accounts WHERE email = 'self@example.com'")));
  assert.ok(!(await db.one("SELECT 1 FROM auth_sessions s LEFT JOIN accounts a ON a.id = s.account_id WHERE a.id IS NULL")));
});

test("account routes need a signed-in account, not an API key", async () => {
  assert.equal((await call("GET", "/account")).status, 401);
  config.auth.adminTokenBreakGlass = true;
  try {
    assert.equal((await call("GET", "/account", { token: ADMIN })).status, 401);
  } finally {
    config.auth.adminTokenBreakGlass = false;
  }
});

test("admin sessions also end after 2 hours without use", async () => {
  const s = await signIn("boss@example.com", "+15552010010");
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

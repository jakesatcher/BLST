// Zero-config first boot (Railway Deploy button / dashboard): no secrets in
// the platform's settings. The server generates the code-signing secret and
// a one-time setup key, and switches its queries to a least-privilege role.
const test = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");
delete process.env.ADMIN_TOKEN; // nothing configured
delete process.env.AUTH_SECRET;
process.env.DATABASE_APP_ROLE = "blst_app_boot";

let ctx;
let db;
let config;
let bootstrap;
let outbox;

test.before(async () => {
  ctx = await helpers.startApp({ asAppRole: false });
  db = require("../src/db");
  config = require("../src/config");
  bootstrap = require("../src/services/bootstrap");
  outbox = require("../src/services/notify").outbox;
  await db.query("DROP OWNED BY blst_app_boot").catch(() => {});
  await db.query("DROP ROLE IF EXISTS blst_app_boot");
});

test.after(async () => {
  await db.useRuntimeUrl(null);
  await db.query("DROP OWNED BY blst_app_boot").catch(() => {});
  await db.query("DROP ROLE IF EXISTS blst_app_boot").catch(() => {});
  ctx.server.close();
  await db.close();
});

async function call(method, path, body) {
  const res = await fetch(`${ctx.base}/api/v1${path}`, {
    method, headers: { "content-type": "application/json", "x-forwarded-for": `198.18.0.${Math.floor(Math.random() * 200)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const codeFor = (to) => [...outbox].reverse().find((m) => m.to === to).text.match(/\b(\d{6})\b/)[1];

test("the code-signing secret is generated once and kept in the database", async () => {
  assert.equal(config.adminToken, "");
  assert.equal(await bootstrap.ensureAuthSecret(), "database");
  const first = config.auth.secret;
  assert.match(first, /^[0-9a-f]{64}$/);
  config.auth.secret = "something else";
  await bootstrap.ensureAuthSecret();
  assert.equal(config.auth.secret, first, "every start (and instance) reads the same secret");
});

test("without ADMIN_TOKEN, a one-time setup key is printed and only it can create the first admin", async () => {
  const printed = [];
  const key = await bootstrap.ensureSetupKey({ log: (l) => printed.push(l) });
  assert.match(key, /^setup-[\w-]{20,}$/);
  assert.ok(printed.some((l) => l.includes(key)), "printed to the log");
  assert.ok(!JSON.stringify(await db.many("SELECT value FROM integration_settings")).includes(key), "only its hash is stored");

  // A restart prints a new key; the previous one keeps working for a while
  // (instances overlap during deploys).
  const key2 = await bootstrap.ensureSetupKey({ log: () => {} });
  assert.notEqual(key2, key);
  assert.equal(await bootstrap.checkSetupKey(key), true);
  assert.equal(await bootstrap.checkSetupKey("setup-wrong"), false);

  const st = (await call("GET", "/auth/status")).body;
  assert.equal(st.setup_needed, true);
  assert.equal(st.setup_key_required, true);
  assert.equal((await call("POST", "/auth/setup", { setup_key: "nope", email: "first@example.com" })).status, 403);
  const start = await call("POST", "/auth/setup", { setup_key: key2, email: "first@example.com" });
  assert.equal(start.status, 202);
  const done = await call("POST", "/auth/verify", { challenge_id: start.body.challenge_id, code: codeFor("first@example.com") });
  assert.equal(done.body.step, "done");
  assert.equal(done.body.account.platform_admin, true);
  assert.equal(done.body.mfa_setup_required, true, "then an authenticator or passkey");

  // Once an admin exists no key is printed and the stored hashes are gone.
  assert.equal(await bootstrap.ensureSetupKey({ log: () => {} }), null);
  assert.equal(await bootstrap.checkSetupKey(key2), false);
  // Nothing configured never means "open": anonymous writes are refused.
  assert.equal((await call("POST", "/tournaments", { name: "x" })).status, 401);
});

test("queries switch to a least-privilege role automatically; migrations keep the owner login", async () => {
  const { ensureRuntimeRole } = require("../src/db/create-app-role");
  const lines = [];
  assert.equal(await ensureRuntimeRole({ log: (l) => lines.push(l) }), "auto");
  assert.match(lines.join("\n"), /requests run as "blst_app_boot"/);
  assert.equal((await db.one("SELECT current_user AS u")).u, "blst_app_boot");
  await assert.rejects(db.query("CREATE TABLE nope (id int)"), /permission denied/);
  // The app keeps working as the role…
  assert.equal((await call("GET", "/auth/status")).status, 200);
  // …and migrations still run (as the owner).
  await db.migrate({ log: () => {} });

  // A restart finds the role already in place and reuses it.
  await db.useRuntimeUrl(null);
  assert.equal((await db.one("SELECT current_user AS u")).u, new URL(process.env.DATABASE_URL).username);
  assert.equal(await ensureRuntimeRole({ log: () => {} }), "auto");
  assert.equal((await db.one("SELECT current_user AS u")).u, "blst_app_boot");

  // Opting out, or a separate migration login, leaves the pool alone.
  await db.useRuntimeUrl(null);
  process.env.DB_AUTO_APP_ROLE = "false";
  assert.equal(await ensureRuntimeRole({ log: () => {} }), "owner");
  delete process.env.DB_AUTO_APP_ROLE;
});

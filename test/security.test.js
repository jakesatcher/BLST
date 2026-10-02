// Security regression tests, mapped to OWASP Top 10 (2021) and OWASP API
// Security Top 10 (2023). See SECURITY.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, ADMIN, waitFor } = require("./helpers");

let ctx;
let api;
let config;
let db;
const S = {};

// Each test sends from its own client IP so rate limits don't interfere.
let ipSeq = 10;
const nextIp = () => `198.51.100.${ipSeq++}`;
async function call(method, path, { body, token, ip = "198.51.100.1", headers = {} } = {}) {
  const h = { "x-forwarded-for": ip, ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  const res = await fetch(`${ctx.base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

test.before(async () => {
  ctx = await startApp();
  api = ctx.api;
  config = require("../src/config");
  db = require("../src/db");
  for (const name of ["Scope A", "Scope B"]) {
    const t = await api("POST", "/tournaments", { name, num_teams: 2 });
    const teams = (await api("GET", `/tournaments/${t.body.id}`)).body.teams;
    const g = await api("POST", `/tournaments/${t.body.id}/games`, { home_team_id: teams[0].id, away_team_id: teams[1].id });
    S[name] = { tid: t.body.id, gid: g.body.id };
  }
});

test.after(async () => {
  ctx.server.close();
  await db.close();
});

test("API5 / A01: every write route rejects anonymous callers", async () => {
  const modules = ["platform", "auth", "media", "streams", "tournaments", "players", "games", "importExport", "registrations", "factions", "admin"];
  const checked = [];
  for (const m of modules) {
    const router = require(`../src/routes/${m}`);
    for (const layer of router.stack) {
      // Sign-up / sign-in endpoints are public by design (test/auth.test.js).
      if (!layer.route || layer.route.path.startsWith("/auth/")) continue;
      const path = layer.route.path.replace(/:[A-Za-z]+/g, "1");
      for (const method of Object.keys(layer.route.methods)) {
        if (method === "get" || method === "head") continue;
        const res = await call(method.toUpperCase(), path, { body: {}, ip: "198.51.100.200" });
        assert.equal(res.status, 401, `${method.toUpperCase()} ${layer.route.path} should need a key, got ${res.status}`);
        checked.push(`${method} ${path}`);
      }
    }
  }
  assert.ok(checked.length > 40, `swept ${checked.length} write routes`);

  for (const path of ["/account", "/admin/members", "/platform/orgs", "/platform/accounts", "/platform/orgs/mine", "/factions-setup", "/factions/members", "/factions/status", "/factions/events/x", "/admin/api-keys", "/admin/webhooks", "/admin/audit-log", "/admin/security", "/import/batches",
    `/tournaments/${S["Scope A"].tid}/roster.csv`, `/tournaments/${S["Scope A"].tid}/factions/preview`, `/games/${S["Scope A"].gid}/events/raw`]) {
    assert.equal((await call("GET", path, { ip: "198.51.100.201" })).status, 401, `GET ${path} must be private`);
  }
});

test("A07 / API2: fails closed without ADMIN_TOKEN", async () => {
  const saved = config.adminToken;
  config.adminToken = "";
  try {
    assert.equal((await call("POST", "/tournaments", { body: { name: "x" } })).status, 401);
    assert.equal(config.allowOpenDev, false);
  } finally {
    config.adminToken = saved;
  }
});

test("A07 / API2: brute-force lockout per IP", async () => {
  const { failures } = require("../src/middleware/auth");
  failures.reset();
  const ip = nextIp();
  for (let i = 0; i < config.rateLimits.authFailuresPer15Min; i++) {
    assert.equal((await call("GET", "/me", { token: `wrong-${i}`, ip })).status, 401);
  }
  const locked = await call("GET", "/me", { token: ADMIN, ip });
  assert.equal(locked.status, 429, "even the right key is refused while locked out");
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.equal((await call("GET", "/me", { token: ADMIN, ip: nextIp() })).body.role, "admin", "other IPs unaffected");
  failures.reset();
});

test("API2: keys in the URL are refused", async () => {
  assert.equal((await call("GET", `/tournaments?token=${ADMIN}`)).status, 400);
  assert.equal((await call("GET", "/tournaments?api_key=abc")).status, 400);
});

test("API2: expired and revoked keys stop working", async () => {
  const k = await api("POST", "/admin/api-keys", { name: "temp", role: "scorekeeper", expires_in_days: 1 });
  assert.equal(k.status, 201);
  assert.ok(k.body.expires_at);
  const ip = nextIp();
  assert.equal((await call("GET", "/me", { token: k.body.key, ip })).body.role, "scorekeeper");
  await db.query("UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [k.body.id]);
  assert.equal((await call("GET", "/me", { token: k.body.key, ip })).status, 401);

  const r = await api("POST", "/admin/api-keys", { name: "revoke-me", role: "readonly" });
  await api("DELETE", `/admin/api-keys/${r.body.id}`);
  assert.equal((await call("GET", "/me", { token: r.body.key, ip })).status, 401);
  require("../src/middleware/auth").failures.reset();
});

test("API1 / A01: tournament-scoped scorekeeper keys can't touch other tournaments", async () => {
  const k = await api("POST", "/admin/api-keys", { name: "Rink A iPad", role: "scorekeeper", tournament_id: S["Scope A"].tid });
  assert.equal(k.status, 201);
  const ip = nextIp();
  const mine = await call("POST", `/games/${S["Scope A"].gid}/start`, { token: k.body.key, ip, body: {} });
  assert.equal(mine.status, 200);
  const theirs = await call("POST", `/games/${S["Scope B"].gid}/start`, { token: k.body.key, ip, body: {} });
  assert.equal(theirs.status, 403);
  assert.equal((await call("GET", `/games/${S["Scope B"].gid}/events/raw`, { token: k.body.key, ip })).status, 403);
  assert.equal((await call("GET", "/me", { token: k.body.key, ip })).body.tournament_id, S["Scope A"].tid);
  assert.equal((await api("POST", "/admin/api-keys", { name: "bad", role: "admin", tournament_id: S["Scope A"].tid })).status, 400);
});

test("API3: private fields never leak to the public", async () => {
  const p = await api("POST", "/players", { first_name: "Priv", last_name: "Acy", email: "priv@example.com" });
  await db.query("UPDATE players SET factions_player_id = 'cHJpdkBleGFtcGxlLmNvbQ' WHERE id = $1", [p.body.id]);
  const pub = await call("GET", `/players/${p.body.id}`);
  assert.equal(pub.body.email, undefined);
  assert.equal(pub.body.factions_player_id, undefined);
  const list = await call("GET", "/players?q=priv");
  assert.ok(!JSON.stringify(list.body).includes("priv@example.com"));
  assert.equal((await call("GET", "/players?q=priv@example")).body.length, 0, "anonymous search can't probe by email");
  const hook = await api("POST", "/admin/webhooks", { name: "h", url: "https://example.com/hook" });
  const hooks = (await api("GET", "/admin/webhooks")).body;
  assert.ok(!JSON.stringify(hooks).includes(hook.body.secret), "webhook secrets are masked after creation");
  const keys = (await api("GET", "/admin/api-keys")).body;
  assert.ok(keys.every((k) => !("key_hash" in k)));
});

test("API7 / A10: SSRF: internal targets are refused", async () => {
  config.allowPrivateUrls = false;
  try {
    for (const url of ["http://127.0.0.1:5432/", "http://localhost/x", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://[::1]/", "http://user:pass@example.com/"]) {
      const r = await api("POST", "/admin/webhooks", { name: "ssrf", url });
      assert.equal(r.status, 400, `${url} should be refused`);
    }
    const check = await api("POST", "/streams/check", { url: "https://127.0.0.1/" });
    assert.equal(check.body.embeddable, false);
    assert.match(check.body.reason, /private or internal/);
  } finally {
    config.allowPrivateUrls = true;
  }
});

test("A03: CSV exports neutralize spreadsheet formulas", async () => {
  const t = S["Scope A"];
  const p = await api("POST", "/players", { first_name: "=HYPERLINK(\"http://evil\",\"x\")", last_name: "+cmd" });
  const teams = (await api("GET", `/tournaments/${t.tid}`)).body.teams;
  await api("POST", `/tournaments/${t.tid}/roster`, { player_id: p.body.id, team_id: teams[0].id });
  const csv = (await call("GET", `/tournaments/${t.tid}/roster.csv`, { token: ADMIN })).body;
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /,'\+cmd,/);
  assert.doesNotMatch(csv, /,=HYPERLINK/);
});

test("A03: injection-shaped input is treated as data", async () => {
  const name = "Robert'); DROP TABLE players;--";
  const r = await api("POST", "/players", { first_name: name, last_name: "<img src=x onerror=alert(1)>" });
  assert.equal(r.status, 201);
  assert.equal((await call("GET", `/players/${r.body.id}`)).body.first_name, name);
  assert.ok((await call("GET", "/players?q=%25'%20OR%201=1--")).status === 200);
  assert.equal((await call("GET", "/games/1%20OR%201=1")).status, 400);
});

test("A05: security headers", async () => {
  const res = await fetch(`${ctx.base}/admin.html`);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'(;|$)/, "only our own scripts");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(res.headers.get("strict-transport-security"), /max-age=31536000/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("permissions-policy"), /camera=\(\)/);
  assert.equal(res.headers.get("x-powered-by"), null);
  const authed = await call("GET", "/me", { token: ADMIN, ip: nextIp() });
  assert.equal(authed.headers.get("cache-control"), "no-store");
  const hls = await fetch(`${ctx.base}/vendor/hls.min.js`);
  assert.equal(hls.status, 200, "hls.js is self-hosted, no CDN script");
});

test("API4: request size, rate and connection limits", async () => {
  const big = JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) });
  assert.equal((await call("POST", "/tournaments", { token: ADMIN, body: big, ip: nextIp() })).status, 413);

  const { rateLimit } = require("../src/lib/rateLimit");
  const limiter = rateLimit({ windowMs: 60_000, max: 2 });
  const results = [];
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => {
      const res = { headers: {}, set(k, v) { this.headers[k] = v; } };
      limiter({ ip: "1.2.3.4" }, res, (err) => { results.push(err ? err.status : 200); resolve(); });
    });
  }
  assert.deepEqual(results, [200, 200, 429]);

  const saved = config.rateLimits.streamsPerIp;
  config.rateLimits.streamsPerIp = 2;
  const ip = nextIp();
  const controllers = [];
  try {
    for (let i = 0; i < 2; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      const r = await fetch(`${ctx.base}/api/v1/stream`, { headers: { "x-forwarded-for": ip }, signal: ac.signal });
      assert.equal(r.status, 200);
    }
    const third = await fetch(`${ctx.base}/api/v1/stream`, { headers: { "x-forwarded-for": ip } });
    assert.equal(third.status, 429);
  } finally {
    controllers.forEach((c) => c.abort());
    config.rateLimits.streamsPerIp = saved;
  }
});

test("A08: uploads are checked by content, and SVGs can't run scripts", async () => {
  const t = S["Scope A"];
  const teams = (await api("GET", `/tournaments/${t.tid}`)).body.teams;
  const html = await fetch(`${ctx.base}/api/v1/teams/${teams[0].id}/logo`, {
    method: "PUT", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "image/png" }, body: "<html><script>alert(1)</script></html>",
  });
  assert.equal(html.status, 415);
  const svg = await fetch(`${ctx.base}/api/v1/teams/${teams[0].id}/logo`, {
    method: "PUT", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "image/svg+xml" },
    body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  });
  assert.equal(svg.status, 200);
  const got = await fetch(`${ctx.base}/api/v1/teams/${teams[0].id}/logo`);
  assert.match(got.headers.get("content-security-policy"), /sandbox/);
  assert.match(got.headers.get("content-security-policy"), /default-src 'none'/);
});

test("A09: changes and rejected requests are audited, without secrets", async () => {
  const ip = nextIp();
  await call("POST", "/tournaments", { token: ADMIN, ip, body: { name: "Audited Cup" } });
  await call("DELETE", "/admin/api-keys/1", { ip });
  // Audit rows are written right after the response goes out.
  const log = await waitFor(async () => {
    const rows = (await api("GET", "/admin/audit-log?limit=100")).body;
    return rows.some((r) => r.ip === ip && r.status === 401) && rows.some((r) => r.ip === ip && r.method === "POST") ? rows : null;
  });
  const write = log.find((r) => r.ip === ip && r.method === "POST" && r.path === "/api/v1/tournaments");
  assert.ok(write, "write recorded");
  assert.equal(write.actor, "admin-token");
  assert.equal(write.status, 201);
  assert.ok(log.find((r) => r.ip === ip && r.status === 401), "denied request recorded");
  assert.ok(!JSON.stringify(log).includes(ADMIN), "no tokens in the audit log");
  const sec = (await api("GET", "/admin/security")).body;
  assert.equal(sec.admin_token_strong, true);
});

// ---------------------------------------------------------------------------
// Audit 2026-10 (docs/SECURITY-AUDIT.md): regression tests for each fix.

test("Audit F1 / API4: behind Railway, the client address comes from X-Real-IP", async () => {
  const { failures } = require("../src/middleware/auth");
  failures.reset();
  config.clientIpHeader = "x-real-ip";
  try {
    // Every request reaches the app from the same proxy address; only
    // X-Real-IP tells clients apart. One attacker must not lock out everyone.
    const proxy = "10.0.0.1";
    for (let i = 0; i < config.rateLimits.authFailuresPer15Min; i++) {
      await call("GET", "/me", { token: `bad-${i}`, ip: proxy, headers: { "x-real-ip": "203.0.113.66" } });
    }
    assert.equal((await call("GET", "/me", { token: "bad-x", ip: proxy, headers: { "x-real-ip": "203.0.113.66" } })).status, 429);
    assert.equal((await call("GET", "/me", { token: ADMIN, ip: proxy, headers: { "x-real-ip": "203.0.113.77" } })).status, 200, "other clients unaffected");
    // A value that isn't an IP address is ignored.
    assert.equal((await call("GET", "/me", { token: ADMIN, ip: nextIp(), headers: { "x-real-ip": "not-an-ip" } })).status, 200);
  } finally {
    config.clientIpHeader = "";
    failures.reset();
  }
});

test("Audit F2 / API5: an admin API key can't hand out access or send data off-site", async () => {
  const key = (await api("POST", "/admin/api-keys", { name: "automation", role: "admin" })).body.key;
  const ip = nextIp();
  assert.equal((await call("GET", "/admin/api-keys", { token: key, ip })).status, 200, "reading is fine");
  for (const [method, path, body] of [
    ["POST", "/admin/api-keys", { name: "more", role: "admin" }],
    ["POST", "/admin/webhooks", { name: "x", url: "https://example.com/hook" }],
    ["PATCH", "/admin/webhooks/1", { url: "https://example.com/other" }],
    ["POST", "/admin/members", { email: "x@example.com", role: "admin" }],
    ["PATCH", "/admin/members/1", { role: "admin" }],
    ["DELETE", "/admin/members/1"],
    ["PATCH", "/platform/accounts/1", { platform_admin: true }],
    ["POST", "/platform/accounts/1/reset-mfa"],
    ["PATCH", "/platform/orgs/1", { status: "suspended" }],
  ]) {
    const r = await call(method, path, { token: key, ip, body: body || {} });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match(r.body.error, /signed in with their account/);
  }
  // Day-to-day admin work with a key still works.
  assert.equal((await call("POST", "/tournaments", { token: key, ip, body: { name: "Key-made Cup" } })).status, 201);
});

test("Audit F3 / API3: public tournament and player data is allow-listed", async () => {
  const t = S["Scope A"];
  await api("PUT", `/tournaments/${t.tid}/leagueapps`, { program_ids: ["12345"], registration_prefix: "SA26" });
  for (const body of [(await call("GET", `/tournaments/${t.tid}`)).body, (await call("GET", "/tournaments")).body.find((x) => x.id === t.tid)]) {
    for (const k of ["leagueapps_program_ids", "registration_seq", "registration_prefix", "factions_points"]) assert.equal(body[k], undefined, k);
  }
  assert.deepEqual((await api("GET", `/tournaments/${t.tid}`)).body.leagueapps_program_ids, ["12345"], "admins still see it");
  const p = (await api("POST", "/players", { first_name: "Allow", last_name: "List", email: "allow.list@example.com" })).body;
  const pub = (await call("GET", `/players/${p.id}`)).body;
  const allowed = ["id", "first_name", "last_name", "position", "shoots", "preferred_number", "external_id", "factions_order", "player_code",
    "created_at", "updated_at", "rosters", "factions"];
  assert.deepEqual(Object.keys(pub).filter((k) => !allowed.includes(k)), []);
});

test("Audit F4: database integrity errors become 409, not 500", async () => {
  const { pgToHttp } = require("../src/lib/http");
  const e = pgToHttp(Object.assign(new Error("a Factions member's Order is permanent"), { code: "P0001" }));
  assert.equal(e.status, 409);
});

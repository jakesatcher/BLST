// Organizations: <slug>.<APP_DOMAIN>, self-serve requests with approval,
// isolation between organizations (enforced by row-level security), and
// Factions as a per-organization feature with its own factions.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startApp, ADMIN, waitFor } = require("./helpers");

let ctx;
let db;
let config;
let outbox;
let port;
let ipSeq = 10;
const nextIp = () => `198.19.0.${ipSeq++}`;
const DOMAIN = "bls.test";
const host = (slug) => (slug ? `${slug}.${DOMAIN}` : DOMAIN);

/** HTTP with an explicit Host header (fetch can't set it). */
function call(method, hostName, path, { body, token, ip = nextIp() } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { host: hostName, "x-forwarded-for": ip };
    if (token) headers.authorization = `Bearer ${token}`;
    if (data) Object.assign(headers, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = text;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* html */
        }
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
// A league's data is only for its people: reads go in as one of them (BLPA's
// admin, Metro's owner) unless a test passes its own token or anon: true.
const memberOf = (slug) => (slug === "blpa" ? ADMIN : slug === "metro" && S.owner ? S.owner.token : undefined);
const api = (method, slug, path, opts = {}) => call(method, host(slug), `/api/v1${path}`,
  opts.token || opts.anon || method !== "GET" ? opts : { ...opts, token: memberOf(slug) });
const codeFor = (to) => [...outbox].reverse().find((m) => m.to === to).text.match(/\b(\d{6})\b/)[1];

/** Signs up and sets up an authenticator, so the session can use staff access it gets later. */
async function signUp(email) {
  const ip = nextIp();
  const s = await api("POST", "", "/auth/signup", { body: { email }, ip });
  const done = await api("POST", "", "/auth/verify", { body: { challenge_id: s.body.challenge_id, code: codeFor(email) }, ip });
  const token = done.body.token;
  const t = await api("POST", "", "/account/mfa/totp", { token, ip });
  const code = require("../src/services/mfa").totpCode(t.body.secret.replace(/\s/g, ""));
  assert.equal((await api("POST", "", "/account/mfa/totp/confirm", { token, body: { code }, ip })).status, 200);
  return done.body;
}

const S = {};

test.before(async () => {
  ctx = await startApp();
  db = require("../src/db");
  config = require("../src/config");
  outbox = require("../src/services/notify").outbox;
  port = new URL(ctx.base).port;
  config.appDomain = DOMAIN;
  config.defaultOrg = "";
  require("../src/services/factions").start();
});

test.after(async () => {
  require("../src/services/gameControl").disarmAll();
  ctx.server.close();
  await db.close();
});

test("addresses: the bare domain is the platform, <slug>.domain is that organization", async () => {
  assert.equal((await api("GET", "", "/org")).body.org, null);
  assert.equal((await api("GET", "blpa", "/org")).body.org.slug, "blpa");
  const page = await call("GET", host("blpa"), "/");
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, "/stats");
  assert.equal((await call("GET", host(""), "/")).status, 200, "platform landing");
  // Old links to league pages on the main site go to BLPA's address, path and query kept.
  const old = await call("GET", host(""), "/tournament?id=7");
  assert.equal(old.status, 301, "organization pages aren't on the platform");
  assert.equal(old.headers.location, "https://blpa.bls.test/tournament?id=7");
  assert.equal((await call("GET", `www.${DOMAIN}`, "/")).status, 200, "www is the main site too");
  assert.equal((await call("GET", `www.${DOMAIN}`, "/stats")).headers.location, "https://blpa.bls.test/stats");
  assert.equal((await api("GET", "", "/org")).body.platform.app_domain, DOMAIN);
  assert.equal((await call("GET", host(""), "/platform")).status, 200, "platform admin page");
  for (const p of ["/stats", "/admin", "/scorekeeper", "/account", "/tournament"]) assert.equal((await call("GET", host("blpa"), p)).status, 200, p);
  // Organization routes don't exist on the platform's own address.
  assert.equal((await api("GET", "", "/tournaments")).status, 404);
  // Unknown organizations are 404, pages included.
  assert.equal((await api("GET", "nope", "/tournaments")).status, 404);
  assert.equal((await call("GET", host("nope"), "/stats")).status, 404);
});

test("anyone can ask for an organization; it's live only after a platform admin approves it", async () => {
  S.owner = await signUp("owner@metro.example");
  const reserved = await api("POST", "", "/platform/orgs", { token: S.owner.token, body: { name: "Bad", slug: "www" } });
  assert.equal(reserved.status, 400);
  assert.equal((await api("GET", "", "/platform/orgs/check?slug=blpa")).body.available, false);
  assert.equal((await api("POST", "", "/platform/orgs", { body: { name: "Metro", slug: "metro" } })).status, 401, "must be signed in");

  const req = await api("POST", "", "/platform/orgs", { token: S.owner.token, body: { name: "Metro Hockey", slug: "metro", note: "Tuesday league" } });
  assert.equal(req.status, 201);
  assert.equal(req.body.status, "pending");
  assert.equal(req.body.url, "https://metro.bls.test");
  S.metroId = req.body.id;
  assert.equal((await api("POST", "", "/platform/orgs", { token: S.owner.token, body: { name: "Again", slug: "metro" } })).status, 409);

  // Not live yet.
  const waiting = await api("GET", "metro", "/tournaments");
  assert.equal(waiting.status, 404);
  assert.match(waiting.body.error, /waiting for approval/);
  // Only platform admins see and decide requests.
  assert.equal((await api("GET", "", "/platform/orgs", { token: S.owner.token })).status, 403);
  const list = (await api("GET", "", "/platform/orgs", { token: ADMIN })).body;
  assert.equal(list.find((o) => o.slug === "metro").requested_by, "owner@metro.example");
  const ok = await api("PATCH", "", `/platform/orgs/${S.metroId}`, { token: ADMIN, body: { status: "active" } });
  assert.equal(ok.status, 200);
  assert.ok(outbox.some((m) => m.to === "owner@metro.example" && /approved and live/.test(m.text)), "requester is told");

  // The requester runs it, and only it.
  const mine = (await api("GET", "", "/platform/orgs/mine", { token: S.owner.token })).body;
  assert.deepEqual(mine.map((o) => [o.slug, o.role, o.status]), [["metro", "admin", "active"]]);
  assert.equal((await api("POST", "metro", "/tournaments", { token: S.owner.token, body: { name: "Metro Cup", num_teams: 2 } })).status, 201);
  assert.equal((await api("POST", "blpa", "/tournaments", { token: S.owner.token, body: { name: "Sneaky" } })).status, 403);
});

test("organizations can't see or touch each other's data, even with the right ids", async () => {
  const blpaT = (await api("POST", "blpa", "/tournaments", { token: ADMIN, body: { name: "BLPA Cup", num_teams: 2 } })).body;
  const blpaTeams = (await api("GET", "blpa", `/tournaments/${blpaT.id}`)).body.teams;
  const blpaP = (await api("POST", "blpa", "/players", { token: ADMIN, body: { first_name: "Jane", last_name: "Both", email: "jane@example.com" } })).body;
  const metroT = (await api("GET", "metro", "/tournaments")).body[0];
  const metroTeams = (await api("GET", "metro", `/tournaments/${metroT.id}`)).body.teams;
  const tok = S.owner.token;

  // Lists only show your own.
  assert.ok(!(await api("GET", "metro", "/tournaments")).body.some((t) => t.id === blpaT.id));
  assert.ok(!(await api("GET", "metro", "/players?limit=500", { token: tok })).body.some((p) => p.id === blpaP.id));
  // Direct ids from another organization don't exist here.
  assert.equal((await api("GET", "metro", `/tournaments/${blpaT.id}`)).status, 404);
  assert.equal((await api("GET", "metro", `/players/${blpaP.id}`)).status, 404);
  assert.equal((await api("GET", "metro", `/export/tournaments/${blpaT.id}`)).status, 404);
  assert.equal((await api("PATCH", "metro", `/teams/${blpaTeams[0].id}`, { token: tok, body: { name: "Hijacked" } })).status, 404);
  assert.equal((await api("DELETE", "metro", `/players/${blpaP.id}`, { token: tok })).status, 404);
  // …and can't be linked into this organization's data.
  const link = await api("POST", "metro", `/tournaments/${metroT.id}/roster`, { token: tok, body: { player_id: blpaP.id, team_id: metroTeams[0].id } });
  assert.ok([400, 404].includes(link.status), `cross-organization roster link refused (${link.status})`);
  const game = await api("POST", "metro", `/tournaments/${metroT.id}/games`, { token: tok, body: { home_team_id: blpaTeams[0].id, away_team_id: metroTeams[1].id } });
  assert.ok([400, 404].includes(game.status), `cross-organization game refused (${game.status})`);
  // Cached stats for the same id never cross over.
  assert.equal((await api("GET", "blpa", `/tournaments/${blpaT.id}/standings`)).status, 200);
  assert.equal((await api("GET", "metro", `/tournaments/${blpaT.id}/standings`)).status, 404);

  // API keys only work in their organization.
  const key = (await api("POST", "blpa", "/admin/api-keys", { token: ADMIN, body: { name: "blpa rink", role: "admin" } })).body.key;
  assert.equal((await api("GET", "blpa", "/me", { token: key })).body.role, "admin");
  assert.equal((await api("GET", "metro", "/me", { token: key })).status, 401);

  // The same email is a separate player in each organization.
  const metroJane = await api("POST", "metro", "/players", { token: tok, body: { first_name: "Jane", last_name: "Both", email: "jane@example.com" } });
  assert.equal(metroJane.status, 201);
  assert.notEqual(metroJane.body.id, blpaP.id);

  // Audit logs are per organization.
  const metroLog = (await api("GET", "metro", "/admin/audit-log", { token: tok })).body;
  assert.ok(metroLog.length > 0 && metroLog.every((r) => !String(r.path).includes(`/tournaments/${blpaT.id}`) || r.status === 404));
  assert.equal((await api("GET", "metro", "/admin/members", { token: tok })).body.members.length, 1);
});

test("a player's stats belong to one organization: games, imports, history, clubs, leagues, ratings", async () => {
  const tok = S.owner.token;
  const as = (slug) => (slug === "blpa" ? ADMIN : tok);
  // The same person (same name and email) plays in both organizations.
  const jane = {};
  for (const slug of ["blpa", "metro"]) {
    const r = await api("POST", slug, "/players", { token: as(slug), body: { first_name: "Jo", last_name: "Twice", email: "jo.twice@example.com" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    jane[slug] = r.body.id;
  }
  assert.notEqual(jane.blpa, jane.metro);

  /** Rosters Jo on the first team of a competition and scores `goals` for her in one game. */
  async function play(slug, tid, goals) {
    const teams = (await api("GET", slug, `/tournaments/${tid}`)).body.teams;
    assert.equal((await api("POST", slug, `/tournaments/${tid}/roster`, { token: as(slug), body: { player_id: jane[slug], team_id: teams[0].id, jersey_number: 19 } })).status, 201);
    const g = (await api("POST", slug, `/tournaments/${tid}/games`, { token: as(slug), body: { home_team_id: teams[0].id, away_team_id: teams[1].id } })).body;
    assert.equal((await api("POST", slug, `/games/${g.id}/start`, { token: as(slug), body: {} })).status, 200);
    for (let i = 0; i < goals; i++) assert.equal((await api("POST", slug, `/games/${g.id}/events`, { token: as(slug), body: { type: "goal", player_id: jane[slug] } })).status, 201);
    assert.equal((await api("POST", slug, `/games/${g.id}/end`, { token: as(slug), body: {} })).status, 200);
  }

  // BLPA: a tournament (3 goals) plus an imported old tournament (10 goals) matched by her email.
  const blpaT = (await api("POST", "blpa", "/tournaments", { token: ADMIN, body: { name: "Shared Name Cup", format: "team", num_teams: 2, team_names: ["Wolves", "Bears"] } })).body;
  await play("blpa", blpaT.id, 3);
  const imp = await api("POST", "blpa", "/import/historical", { token: ADMIN, body: { city: "Pittsburgh", series: "DEX", year: 2024,
    rows: [{ first_name: "Jo", last_name: "Twice", email: "jo.twice@example.com", team: "Wolves", gp: 5, g: 10, a: 2 }] } });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.created_players, 0, "matched BLPA's Jo by email");

  // Metro: a league division (1 goal), same team names, and its own import with the same Tournament ID.
  const L = (await api("POST", "metro", "/leagues", { token: tok, body: { name: "Metro League", divisions: ["C"] } })).body;
  const season = (await api("POST", "metro", `/leagues/${L.id}/seasons`, { token: tok, body: { name: "2026", year: 2026 } })).body;
  const comp = (await api("POST", "metro", `/leagues/${L.id}/seasons/${season.id}/divisions/${L.divisions[0].id}`, { token: tok, body: { team_names: ["Wolves", "Bears"] } })).body;
  await api("PUT", "metro", `/leagues/${L.id}/rating-settings`, { token: tok, body: { min_games: 1 } });
  await play("metro", comp.id, 1);
  const mImp = await api("POST", "metro", "/import/historical", { token: tok, body: { city: "Pittsburgh", series: "DEX", year: 2024,
    rows: [{ first_name: "Jo", last_name: "Twice", email: "jo.twice@example.com", gp: 1, g: 2, a: 0 }] } });
  assert.equal(mImp.status, 200, "the same Tournament ID is free in another organization");
  assert.equal(mImp.body.created_players, 0, "matched Metro's Jo, not BLPA's");

  // Careers count only their own organization's games.
  const blpaCareer = (await api("GET", "blpa", `/players/${jane.blpa}/career`)).body;
  const metroCareer = (await api("GET", "metro", `/players/${jane.metro}/career`)).body;
  assert.equal(blpaCareer.career.skater.goals, 13, "3 live + 10 imported, BLPA only");
  assert.equal(metroCareer.career.skater.goals, 3, "1 live + 2 imported, Metro only");
  assert.equal((await api("GET", "metro", `/players/${jane.blpa}/career`)).status, 404);
  assert.equal((await api("GET", "metro", `/export/players/${jane.blpa}`)).status, 404);

  // History leaderboards and clubs.
  const hist = async (slug) => (await api("GET", slug, "/history/players?q=twice")).body;
  const bh = await hist("blpa");
  const mh = await hist("metro");
  const rows = (x) => (Array.isArray(x) ? x : x.players);
  assert.deepEqual(rows(bh).map((p) => p.player_id), [jane.blpa]);
  assert.deepEqual(rows(mh).map((p) => p.player_id), [jane.metro]);
  const clubs = async (slug) => (await api("GET", slug, "/clubs")).body;
  const bw = (await clubs("blpa")).find((c) => c.name === "Wolves");
  const mw = (await clubs("metro")).find((c) => c.name === "Wolves");
  assert.ok(bw && mw && bw.id !== mw.id, "same team name, separate clubs");
  assert.equal((await api("GET", "metro", `/clubs/${bw.id}`)).status, 404);

  // League stats and ratings only see Metro.
  const lstats = (await api("GET", "metro", `/leagues/${L.id}/stats`)).body;
  assert.deepEqual(lstats.skaters.filter((x) => x.goals > 0).map((x) => [x.player_id, x.goals]), [[jane.metro, 1]]);
  const ratings = (await api("GET", "metro", `/leagues/${L.id}/ratings`)).body;
  assert.ok(ratings.skaters.every((r) => r.player_id !== jane.blpa));
  assert.ok(ratings.skaters.some((r) => r.player_id === jane.metro));
  assert.equal((await api("GET", "blpa", `/leagues/${L.id}`)).status, 404);
  assert.equal((await api("GET", "blpa", `/leagues/${L.id}/ratings`)).status, 404);
  assert.ok(!(await api("GET", "blpa", "/leagues")).body.some((x) => x.id === L.id));
});

test("a new organization's admin is guided through league setup", async () => {
  const tok = S.owner.token;
  assert.ok(outbox.some((m) => m.to === "owner@metro.example" && /metro\.bls\.test\/setup/.test(m.text)), "approval email links to setup");
  assert.equal((await api("GET", "blpa", "/org")).body.org.setup_needed, false, "existing organizations are already set up");
  assert.equal((await api("GET", "metro", "/org")).body.org.setup_needed, true);
  assert.equal((await api("GET", "metro", "/admin/onboarding", { anon: true })).status, 401, "admins only");

  let p = (await api("GET", "metro", "/admin/onboarding", { token: tok })).body;
  // Earlier tests already gave Metro a league with divisions and imported history.
  assert.equal(p.steps.find((x) => x.id === "league").done, true);
  assert.equal(p.steps.find((x) => x.id === "history").done, true);
  assert.equal(p.steps.find((x) => x.id === "connect").done, false);
  assert.equal(p.next, "connect", "a live season already exists, so connecting is next");

  // A second league becomes the one being set up; steps can be skipped.
  const L2 = (await api("POST", "metro", "/leagues", { token: tok, body: { name: "Metro Summer", divisions: ["A", "B"] } })).body;
  p = (await api("PUT", "metro", "/admin/onboarding", { token: tok, body: { league_id: L2.id, skip: "connect" } })).body;
  assert.equal(p.league.name, "Metro Summer");
  assert.deepEqual(p.league.divisions.map((d) => d.name), ["A", "B"]);
  assert.equal(p.steps.find((x) => x.id === "connect").skipped, true);
  assert.equal((await api("PUT", "metro", "/admin/onboarding", { token: tok, body: { skip: "nonsense" } })).status, 400);

  // The new league has no season yet; one that isn't imported history counts.
  assert.equal(p.steps.find((x) => x.id === "season").done, false);
  const season = (await api("POST", "metro", `/leagues/${L2.id}/seasons`, { token: tok, body: { name: "2026" } })).body;
  await api("POST", "metro", `/leagues/${L2.id}/seasons/${season.id}/divisions/${p.league.divisions[0].id}`, { token: tok, body: { team_names: ["Sharks", "Jets"] } });
  p = (await api("GET", "metro", "/admin/onboarding", { token: tok })).body;
  assert.equal(p.steps.find((x) => x.id === "season").done, true);

  p = (await api("PUT", "metro", "/admin/onboarding", { token: tok, body: { completed: true } })).body;
  assert.equal(p.completed, true);
  assert.equal((await api("GET", "metro", "/org")).body.org.setup_needed, false);
  assert.equal((await call("GET", host("metro"), "/setup")).status, 200, "the setup page is served on the organization's address");
});

test("the live stream only carries an organization's own events", async () => {
  const seen = [];
  const reqStream = http.request({ host: "127.0.0.1", port, path: "/api/v1/stream", headers: { host: host("metro"), "x-forwarded-for": nextIp(), authorization: `Bearer ${S.owner.token}` } }, (res) => {
    res.on("data", (c) => seen.push(String(c)));
  });
  reqStream.end();
  await new Promise((r) => setTimeout(r, 300));
  await api("POST", "blpa", "/tournaments", { token: ADMIN, body: { name: "Should not stream to metro" } });
  await api("POST", "metro", "/tournaments", { token: S.owner.token, body: { name: "Metro event" } });
  await waitFor(() => seen.join("").includes("tournament.changed") || null);
  reqStream.destroy();
  const events = seen.join("").split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  const changed = events.filter((e) => e.event);
  assert.ok(changed.length >= 1);
  const metroIds = new Set((await api("GET", "metro", "/tournaments")).body.map((t) => t.id));
  assert.ok(changed.every((e) => e.tournament_id === null || metroIds.has(e.tournament_id)), "no BLPA events");
});

test("Factions is off until an organization turns it on, with factions it designs itself", async () => {
  const tok = S.owner.token;
  // Off: the feature doesn't exist for metro.
  assert.equal((await api("GET", "metro", "/factions")).status, 404);
  assert.equal((await call("GET", host("metro"), "/factions")).status, 302);
  assert.equal((await api("GET", "metro", "/org")).body.org.factions_enabled, false);
  // BLPA still has its six Orders.
  assert.equal((await api("GET", "blpa", "/factions/definitions")).body.length, 6);

  // Design: custom factions (or a preset), then turn it on.
  assert.equal((await api("POST", "metro", "/factions-setup/factions", { token: tok, body: { name: "Lumberjacks", emoji: "🪓", color: "#8b4513" } })).status, 201);
  assert.equal((await api("POST", "metro", "/factions-setup/factions", { token: tok, body: { name: "Lumberjacks" } })).status, 409, "names are unique");
  const two = (await api("POST", "metro", "/factions-setup/factions", { token: tok, body: { name: "Sailors", emoji: "⚓", color: "#1d4ed8" } })).body;
  assert.deepEqual(two.map((f) => [f.slug, f.position]), [["lumberjacks", 0], ["sailors", 1]]);
  assert.equal((await api("POST", "metro", "/factions-setup/factions", { token: tok, body: { name: "Bad", color: "red" } })).status, 400);
  const on = await api("PUT", "metro", "/factions-setup", { token: tok, body: { enabled: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);

  // Players with emails joined metro's factions (Jane, added earlier).
  const factions = require("../src/services/factions");
  const jane = (await api("GET", "metro", "/factions/members?q=jane", { token: tok })).body.members[0];
  assert.equal(jane.order_slug, factions.assignOrder("jane@example.com", two));
  assert.ok(["lumberjacks", "sailors"].includes(jane.order_slug));
  const orders = (await api("GET", "metro", "/factions/orders")).body;
  assert.deepEqual(orders.map((o) => o.slug).sort(), ["lumberjacks", "sailors"]);
  // BLPA's Jane is a different member with an Order.
  const blpaJane = (await api("POST", "blpa", "/factions/members/find", { token: ADMIN, body: { email: "jane@example.com" } })).body;
  assert.ok(factions.ORDERS.some((o) => o.slug === blpaJane.order_slug));

  // Once people are in factions they can be renamed/recoloured, not removed.
  assert.equal((await api("PATCH", "metro", "/factions-setup/factions/sailors", { token: tok, body: { name: "Mariners", color: "#0e7490" } })).status, 200);
  assert.equal((await api("DELETE", "metro", "/factions-setup/factions/sailors", { token: tok })).status, 409);
  // Scorekeepers and the public can't design factions.
  assert.equal((await api("POST", "metro", "/factions-setup/factions", { body: { name: "X" } })).status, 401);

  // Off again: hidden, data kept.
  await api("PUT", "metro", "/factions-setup", { token: tok, body: { enabled: false } });
  assert.equal((await api("GET", "metro", "/factions/orders")).status, 404);
  await api("PUT", "metro", "/factions-setup", { token: tok, body: { enabled: true } });
  assert.equal((await api("GET", "metro", "/factions/members?q=jane", { token: tok })).body.members[0].id, jane.id);
});

test("league data is only for its people: players by email, viewers, display keys; never anonymous", async () => {
  // The main site lists no leagues to anyone who isn't signed in.
  assert.equal((await api("GET", "", "/platform/leagues")).status, 404);
  assert.equal((await api("GET", "blpa", "/tournaments", { anon: true })).status, 401);
  assert.equal((await api("GET", "blpa", "/leaders", { anon: true })).status, 401);
  assert.equal((await api("GET", "blpa", "/org", { anon: true })).status, 200, "the league's name for the sign-in screen");

  // Jo plays in both leagues (same email on both player records): signing up
  // is enough to see both, read-only, without being added.
  const jo = await signUp("jo.twice@example.com");
  const mine = (await api("GET", "", "/platform/orgs/mine", { token: jo.token })).body;
  assert.deepEqual(mine.map((o) => [o.slug, o.role]).sort(), [["blpa", "player"], ["metro", "player"]]);
  assert.equal(mine.find((o) => o.slug === "metro").url, "https://metro.bls.test");
  const me = (await api("GET", "blpa", "/me", { token: jo.token })).body;
  assert.equal(me.can_view, true);
  assert.equal(me.viewer, "player");
  assert.equal((await api("GET", "blpa", "/tournaments", { token: jo.token })).status, 200);
  assert.equal((await api("POST", "blpa", "/tournaments", { token: jo.token, body: { name: "Nope" } })).status, 403, "viewing only");

  // Someone else's account sees nothing, until an admin adds them as a viewer.
  const fan = await signUp("fan@example.com");
  assert.equal((await api("GET", "metro", "/me", { token: fan.token })).body.can_view, false);
  const denied = await api("GET", "metro", "/tournaments", { token: fan.token });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /isn't part of this league/);
  const add = await api("POST", "metro", "/admin/members", { token: S.owner.token, body: { email: "fan@example.com", role: "viewer" } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal((await api("GET", "metro", "/tournaments", { token: fan.token })).status, 200);
  assert.equal((await api("GET", "metro", "/admin/members", { token: fan.token })).status, 403);
  assert.equal((await api("GET", "blpa", "/tournaments", { token: fan.token })).status, 403, "only the league that added them");
  const fanAcct = (await api("GET", "", "/account", { token: fan.token })).body;
  assert.equal(fanAcct.staff, false, "viewers aren't staff (no second factor needed)");

  // A display link's view-only key works for its league only.
  const key = (await api("POST", "metro", "/admin/api-keys", { token: S.owner.token, body: { name: "Rink TV", role: "readonly" } })).body.key;
  assert.equal((await api("GET", "metro", "/tournaments", { token: key })).status, 200);
  assert.equal((await api("GET", "blpa", "/tournaments", { token: key })).status, 401);
});

test("platform admins can suspend an organization", async () => {
  await api("PATCH", "", `/platform/orgs/${S.metroId}`, { token: ADMIN, body: { status: "suspended" } });
  const r = await api("GET", "metro", "/tournaments");
  assert.equal(r.status, 404);
  assert.equal((await call("GET", host("metro"), "/stats")).status, 404);
  await api("PATCH", "", `/platform/orgs/${S.metroId}`, { token: ADMIN, body: { status: "active" } });
  assert.equal((await api("GET", "metro", "/tournaments")).status, 200);
});

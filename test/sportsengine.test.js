// SportsEngine integration against a mock SportsEngine (OAuth client
// credentials + GraphQL): connect, teams and rosters in, schedule in, final
// scores out, admin-only, credentials encrypted at rest.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startApp, waitFor } = require("./helpers");

let ctx;
let api;
let db;
const S = {};

const CLIENT_ID = "se-client";
const SECRET = "se-very-secret-value";
const state = { tokens: 0, calls: [], mutations: [], expireNext: false };

const ROSTERS = {
  "t-1": { id: "t-1", name: "Ice Hogs", roster: { players: [
    { profileId: "p-1", firstName: "Sam", lastName: "Sniper", jerseyNumber: "9", rosterStatus: "active" },
    { profileId: "p-2", firstName: "Nora", lastName: "New", jerseyNumber: 12, rosterStatus: "active" },
    { profileId: "p-3", firstName: "Gone", lastName: "Guy", jerseyNumber: 3, rosterStatus: "inactive" },
  ] } },
  "t-2": { id: "t-2", name: "Puck Bunnies", roster: { players: [
    { profileId: "p-4", firstName: "Ray", lastName: "Rocket", jerseyNumber: "150", rosterStatus: "active" },
  ] } },
};
const PROFILES = {
  "p-1": { id: "p-1", firstName: "Sam", lastName: "Sniper", email: "SAM@example.com", dateOfBirth: "1990-04-02" },
  "p-2": { id: "p-2", firstName: "Nora", lastName: "New", email: "nora@example.com", dateOfBirth: null },
  "p-4": { id: "p-4", firstName: "Ray", lastName: "Rocket", email: null, dateOfBirth: null },
};
const EVENTS = [
  { id: "e-1", name: "Hogs vs Bunnies", type: "game", start: "2026-11-01T19:00:00Z", location: { name: "Rink A" },
    eventTeams: [{ teamId: "t-2", homeTeam: false, score: null }, { teamId: "t-1", homeTeam: true, score: null }] },
  { id: "e-2", name: "Practice", type: "practice", start: "2026-11-02T19:00:00Z", eventTeams: [{ teamId: "t-1" }, { teamId: "t-2" }] },
  { id: "e-3", name: "vs outsiders", type: "game", start: "2026-11-03T19:00:00Z", eventTeams: [{ teamId: "t-1" }, { teamId: "t-99" }] },
];

function startMock() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const send = (code, obj) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/oauth/token") {
        if (body.grant_type !== "client_credentials" || body.client_id !== CLIENT_ID || body.client_secret !== SECRET) return send(401, { error: "invalid_client" });
        state.tokens += 1;
        return send(200, { access_token: `tok-${state.tokens}`, token_type: "bearer", expires_in: 7200 });
      }
      if (req.url !== "/graphql") return send(404, {});
      if (!/^Bearer tok-\d+$/.test(req.headers.authorization || "")) return send(401, { errors: [{ message: "unauthorized" }] });
      if (state.expireNext) {
        state.expireNext = false;
        return send(401, { errors: [{ message: "token expired" }] });
      }
      const op = /^\s*(query|mutation)\s+(\w+)/.exec(body.query)[2];
      const v = body.variables || {};
      state.calls.push(op);
      const page = (results) => ({ pageInformation: { pages: 1, page: 1 }, results });
      switch (op) {
        case "Organizations": return send(200, { data: { organizations: page([{ id: "org-77", name: "Burgh Beer League" }]) } });
        case "Teams":
          assert.equal(v.organizationId, "org-77");
          return send(200, { data: { teams: page([{ id: "t-1", name: "Ice Hogs", status: "active" }, { id: "t-2", name: "Puck Bunnies", status: "active" }]) } });
        case "Team": return send(200, { data: { team: ROSTERS[v.id] || null } });
        case "Profile": return PROFILES[v.id] ? send(200, { data: { profile: PROFILES[v.id] } }) : send(200, { errors: [{ message: "not found" }], data: null });
        case "Events": return send(200, { data: { events: { nodes: EVENTS } } }); // a different connection shape on purpose
        case "UpdateEventScore":
          state.mutations.push(v.input);
          return send(200, { data: { updateEvent: { event: { id: v.input.id, status: "final" } } } });
        default: return send(400, { errors: [{ message: `unknown operation ${op}` }] });
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

test.before(async () => {
  S.mock = await startMock();
  const base = `http://127.0.0.1:${S.mock.address().port}`;
  process.env.SPORTSENGINE_TOKEN_URL = `${base}/oauth/token`;
  process.env.SPORTSENGINE_GRAPHQL_URL = `${base}/graphql`;
  ctx = await startApp();
  api = ctx.api;
  db = require("../src/db");
  require("../src/services/sportsengine").start();
  S.sam = (await api("POST", "/players", { first_name: "Sam", last_name: "Sniper", email: "sam@example.com" })).body.id;
  const t = await api("POST", "/tournaments", { name: "Fall League", season: "2026", num_teams: 2, team_names: ["Ice Hogs", "Other"] });
  S.tid = t.body.id;
});

test.after(async () => {
  ctx.server.close();
  S.mock.close();
  await db.close();
});

test("not connected yet; bad credentials aren't kept", async () => {
  assert.equal((await api("GET", "/integrations/sportsengine")).body.connected, false);
  const r = await api("GET", "/integrations/sportsengine/teams");
  assert.equal(r.status, 400);
  const bad = await api("PUT", "/integrations/sportsengine", { client_id: CLIENT_ID, client_secret: "wrong" });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /sign-in failed/);
  assert.equal((await api("GET", "/integrations/sportsengine")).body.connected, false);
});

test("connect: credentials checked, organization picked, secret encrypted", async () => {
  const r = await api("PUT", "/integrations/sportsengine", { client_id: CLIENT_ID, client_secret: SECRET });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.connected, true);
  assert.equal(r.body.se_organization_id, "org-77");
  assert.equal(r.body.se_organization_name, "Burgh Beer League");
  assert.equal(r.body.auto_push, true);
  assert.equal(r.body.client_secret, undefined);
  const row = await db.one("SELECT * FROM sportsengine_connections");
  assert.ok(!row.client_secret_enc.includes(SECRET), "secret is encrypted");
  assert.match(row.client_secret_enc, /^v1:/);
  assert.ok(row.access_token_enc && !row.access_token_enc.includes("tok-"), "token is encrypted");
  const st = (await api("GET", "/integrations/sportsengine")).body;
  assert.ok(!JSON.stringify(st).includes(SECRET));
  assert.ok(st.log.some((l) => l.action === "connect" && l.ok));
});

test("only admins; credentials only by a signed-in admin, not an API key", async () => {
  const key = (await api("POST", "/admin/api-keys", { name: "desk", role: "admin" })).body.key;
  const sk = (await api("POST", "/admin/api-keys", { name: "rink", role: "scorekeeper" })).body.key;
  assert.equal((await api("GET", "/integrations/sportsengine", undefined, null)).status, 401);
  assert.equal((await api("GET", "/integrations/sportsengine", undefined, sk)).status, 403);
  assert.equal((await api("GET", "/integrations/sportsengine", undefined, key)).status, 200);
  assert.equal((await api("PUT", "/integrations/sportsengine", { client_id: "x", client_secret: "y" }, key)).status, 403);
  assert.equal((await api("DELETE", "/integrations/sportsengine", undefined, key)).status, 403);
});

test("teams and rosters come in: matched by email, new players added, jerseys kept", async () => {
  const teams = (await api("GET", "/integrations/sportsengine/teams")).body;
  assert.deepEqual(teams.map((t) => t.name), ["Ice Hogs", "Puck Bunnies"]);
  assert.equal(teams[0].linked, null);

  state.expireNext = true; // a 401 mid-way gets one retry with a fresh token
  const r = await api("POST", `/tournaments/${S.tid}/sportsengine/teams`, { team_ids: ["t-1", "t-2"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.teams, 2);
  assert.equal(r.body.created_teams, 1, "Ice Hogs existed; Puck Bunnies added");
  assert.equal(r.body.players, 3, "inactive roster entries skipped");
  assert.equal(r.body.created_players, 2);
  assert.deepEqual(r.body.errors, []);

  const t = (await api("GET", `/tournaments/${S.tid}`)).body;
  const rosterOf = () => db.many("SELECT r.*, p.first_name FROM roster_entries r JOIN players p ON p.id = r.player_id WHERE r.tournament_id = $1", [S.tid]);
  const roster = await rosterOf();
  const hogs = t.teams.find((x) => x.name === "Ice Hogs").id;
  const sam = roster.find((e) => e.player_id === S.sam);
  assert.ok(sam, "existing Sam matched by email, not duplicated");
  assert.equal(sam.team_id, hogs);
  assert.equal(sam.jersey_number, 9);
  const ray = roster.find((e) => e.first_name === "Ray");
  assert.ok(ray);
  assert.equal(ray.jersey_number, null, "jersey 150 isn't a hockey number");

  const linked = (await api("GET", "/integrations/sportsengine/teams")).body;
  assert.equal(linked[0].linked.team, "Ice Hogs");
  assert.equal(linked[0].linked.tournament_id, S.tid);

  // Again: nothing duplicated.
  const again = await api("POST", `/tournaments/${S.tid}/sportsengine/teams`, { team_ids: ["t-1", "t-2"] });
  assert.equal(again.body.created_players, 0);
  assert.equal(again.body.created_teams, 0);
  assert.equal((await rosterOf()).length, roster.length);
});

test("schedule comes in between linked teams; practices and outside games skipped", async () => {
  const r = await api("POST", `/tournaments/${S.tid}/sportsengine/schedule`, { start: "2026-10-01", end: "2026-12-31" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 1);
  const games = (await api("GET", `/tournaments/${S.tid}/games`)).body;
  assert.equal(games.length, 1);
  const t = (await api("GET", `/tournaments/${S.tid}`)).body;
  const name = (id) => t.teams.find((x) => x.id === id).name;
  assert.equal(name(games[0].home_team_id), "Ice Hogs", "home team from SportsEngine");
  assert.equal(games[0].venue, "Rink A");
  assert.equal(new Date(games[0].scheduled_at).toISOString(), "2026-11-01T19:00:00.000Z");
  S.gid = games[0].id;

  EVENTS[0].start = "2026-11-01T20:30:00Z";
  const again = await api("POST", `/tournaments/${S.tid}/sportsengine/schedule`, { start: "2026-10-01", end: "2026-12-31" });
  assert.equal(again.body.created, 0);
  assert.equal(again.body.updated, 1);
  assert.equal(new Date((await api("GET", `/tournaments/${S.tid}/games`)).body[0].scheduled_at).toISOString(), "2026-11-01T20:30:00.000Z");
});

test("final whistle sends the score to SportsEngine", async () => {
  assert.equal((await api("POST", `/games/${S.gid}/sportsengine/result`, {})).status, 400, "not final yet");
  assert.equal((await api("POST", `/games/${S.gid}/start`, {})).status, 200);
  assert.equal((await api("POST", `/games/${S.gid}/events`, { type: "goal", player_id: S.sam })).status, 201);
  assert.equal((await api("POST", `/games/${S.gid}/end`, {})).status, 200);
  const sent = await waitFor(() => state.mutations[0]);
  assert.equal(sent.id, "e-1");
  assert.equal(sent.status, "final");
  assert.deepEqual(sent.eventTeams, [{ teamId: "t-1", score: 1 }, { teamId: "t-2", score: 0 }]);
  const st = await waitFor(async () => {
    const s = (await api("GET", "/integrations/sportsengine")).body;
    return s.log.some((l) => l.action === "result" && l.ok) && s;
  });
  assert.equal(st.linked.games, 1);

  // Off: nothing automatic, but it can still be sent by hand.
  assert.equal((await api("PATCH", "/integrations/sportsengine", { auto_push: false })).body.auto_push, false);
  const manual = await api("POST", `/games/${S.gid}/sportsengine/result`, {});
  assert.equal(manual.status, 200);
  assert.equal(manual.body.home_score, 1);
  assert.equal(state.mutations.length, 2);
});

test("disconnect removes the credentials", async () => {
  assert.equal((await api("DELETE", "/integrations/sportsengine")).status, 204);
  assert.equal((await api("GET", "/integrations/sportsengine")).body.connected, false);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM sportsengine_connections")).n, 0);
});

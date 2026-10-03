const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const { startApp, ADMIN } = require("./helpers");

let ctx;
let api;
let la;
const S = {};

// ---- mock LeagueApps (auth + registrations-2 export) ------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const CLIENT_ID = "blpa-test-client";
const SITE = "12345";
const state = { records: [], tokens: 0, exportCalls: 0, fail429Once: true, fail401Once: true, badAssertions: 0 };

function verifyAssertion(jwt) {
  const [h, p, sig] = jwt.split(".");
  const ok = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"));
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  return ok && header.alg === "RS256" && claims.aud === "https://auth.leagueapps.io/v2/auth/token" && claims.iss === CLIENT_ID &&
    claims.sub === CLIENT_ID && claims.exp - claims.iat === 300;
}

function startMock() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/v2/auth/token") {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !verifyAssertion(form.get("assertion"))) {
          state.badAssertions += 1;
          res.writeHead(401).end("bad assertion");
          return;
        }
        state.tokens += 1;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `tok-${state.tokens}`, expires_in: 900 }));
        return;
      }
      if (url.pathname === `/v2/sites/${SITE}/export/registrations-2`) {
        state.exportCalls += 1;
        if (!/^Bearer tok-\d+$/.test(req.headers.authorization || "")) return res.writeHead(401).end();
        if (state.fail401Once && state.exportCalls === 2) {
          state.fail401Once = false;
          return res.writeHead(401).end("expired");
        }
        if (state.fail429Once && state.exportCalls === 3) {
          state.fail429Once = false;
          return res.writeHead(429, { "retry-after": "0" }).end();
        }
        const lu = Number(url.searchParams.get("last-updated"));
        const li = Number(url.searchParams.get("last-id"));
        // Inclusive cursor (like LeagueApps): the boundary record comes back again.
        const sorted = [...state.records].sort((a, b) => a.lastUpdated - b.lastUpdated || a.id - b.id);
        const page = sorted.filter((r) => r.lastUpdated > lu || (r.lastUpdated === lu && r.id >= li)).slice(0, 2);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(page));
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const rec = (id, lastUpdated, programId, programName, userId, firstName, lastName, email, birthDate, status = "ACTIVE") =>
  ({ id, lastUpdated, programId, programName, userId, firstName, lastName, email, birthDate, registrationStatus: status });

test.before(async () => {
  ctx = await startApp();
  api = ctx.api;
  S.mock = await startMock();
  const base = `http://127.0.0.1:${S.mock.address().port}`;
  Object.assign(process.env, {
    LEAGUEAPPS_SITE_ID: SITE, LEAGUEAPPS_CLIENT_ID: CLIENT_ID, LEAGUEAPPS_API_BASE: base, LEAGUEAPPS_AUTH_URL: `${base}/v2/auth/token`,
    // Heroku-style: newlines escaped in a single-line config var.
    LEAGUEAPPS_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n"),
  });
  la = require("../src/services/leagueapps");
  la.timing.slotMs = 5;
  la._reset();

  const fall = await api("POST", "/tournaments", { name: "Fall Classic", season: "2026", num_teams: 2, team_names: ["North", "South"] });
  const winter = await api("POST", "/tournaments", { name: "Winter Cup", season: "2027", num_teams: 2 });
  S.fall = fall.body.id;
  S.winter = winter.body.id;
  // Sam already has imported history (from an older league) and an email on file.
  await api("POST", "/import/historical", { city: "Pastville", series: "Bash", year: 2025, rows: [{ first_name: "Sam", last_name: "Sniper", email: "sam@example.com", season: "2025", gp: 10, g: 8, a: 6 }] });
  state.records = [
    rec(101, 1000, 9001, "BLPA Fall Classic 2026", 5001, "Sam", "Sniper", "SAM@example.com", "1990-04-02"),
    rec(102, 1000, 9001, "BLPA Fall Classic 2026", 5002, "Kid", "One", "parent@example.com", "2012-01-01"),
    rec(103, 1001, 9001, "BLPA Fall Classic 2026", 5003, "Kiddo", "Two", "parent@example.com", "2014-05-05"),
    rec(104, 1002, 9999, "Summer Skills Camp", 5004, "Camp", "Kid", "camp@example.com", null),
  ];
});

test.after(async () => {
  S.mock.close();
  ctx.server.close();
  await require("../src/db").close();
});

test("LeagueApps sync: signed JWT auth, paging, retries, unlinked programs", async () => {
  const first = await api("POST", "/integrations/leagueapps/sync", {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(state.badAssertions, 0, "assertion verified with the public key");
  assert.equal(first.body.seen, 4, "boundary duplicates dropped, 401 and 429 retried");
  assert.equal(first.body.skipped_unlinked, 4, "no program linked yet");
  const status = (await api("GET", "/integrations/leagueapps")).body;
  assert.equal(status.configured, true);
  assert.deepEqual(status.programs.map((p) => p.name).sort(), ["BLPA Fall Classic 2026", "Summer Skills Camp"]);
  assert.equal((await api("GET", "/integrations/leagueapps", undefined, null)).status, 401);
});

test("linking a program replays the sync; codes, returning players, sibling guard", async () => {
  const link = await api("PUT", `/tournaments/${S.fall}/leagueapps`, { program_ids: [9001] });
  assert.equal(link.status, 200);
  const r = await api("POST", "/integrations/leagueapps/sync", {});
  assert.equal(r.body.created, 3);
  assert.equal(r.body.returning, 1, "Sam has imported history");
  assert.equal(r.body.skipped_unlinked, 1);

  const regs = (await api("GET", `/tournaments/${S.fall}/registrations`)).body;
  const byName = Object.fromEntries(regs.map((x) => [x.first_name, x]));
  assert.deepEqual(regs.map((x) => x.registration_code).sort(), ["FC26-0001", "FC26-0002", "FC26-0003"]);
  assert.equal(byName.Sam.match_method, "email");
  assert.equal(byName.Sam.has_history, true);
  assert.equal(byName.Sam.historical_gp, 10);
  assert.equal(String(byName.Sam.leagueapps_user_id), "5001", "identifiers filled in on the existing record");
  assert.notEqual(byName.Kid.player_id, byName.Kiddo.player_id, "siblings sharing a parent email stay separate people");
  assert.equal(byName.Kiddo.match_method, "new");
  S.sam = byName.Sam;

  const again = await api("POST", "/integrations/leagueapps/sync", { from_scratch: true });
  assert.equal(again.body.created, 0, "re-sync is idempotent");
  assert.equal((await api("GET", `/tournaments/${S.fall}/registrations`)).body.length, 3);
});

test("cancellations and a second tournament link to the same person", async () => {
  state.records.push(rec(102, 2000, 9001, "BLPA Fall Classic 2026", 5002, "Kid", "One", "parent@example.com", "2012-01-01", "CANCELLED"));
  state.records.push(rec(105, 2001, 9002, "BLPA Winter Cup 2027", 5001, "Samuel", "Sniper", null, null));
  state.records = state.records.filter((x) => !(x.id === 102 && x.lastUpdated === 1000));
  await api("PUT", `/tournaments/${S.winter}/leagueapps`, { program_ids: [9002] });
  const r = await api("POST", "/integrations/leagueapps/sync", {});
  assert.equal(r.status, 200);
  const fall = (await api("GET", `/tournaments/${S.fall}/registrations`)).body;
  assert.equal(fall.find((x) => x.first_name === "Kid").status, "cancelled");
  const winter = (await api("GET", `/tournaments/${S.winter}/registrations`)).body;
  assert.equal(winter.length, 1);
  assert.equal(winter[0].registration_code, "WC27-0001");
  assert.equal(winter[0].player_id, S.sam.player_id, "matched by LeagueApps user id despite a different first name");
  assert.equal(winter[0].match_method, "leagueapps_user_id");
  assert.equal(winter[0].prior_tournaments, 1);
});

test("walk-ups, ambiguous names flagged for review, and merging duplicates", async () => {
  const walk = await api("POST", `/tournaments/${S.winter}/registrations`, { first_name: "Sam", last_name: "Sniper", email: "sam@example.com" });
  assert.equal(walk.status, 200, "already registered: same registration returned");
  assert.equal(walk.body.registration_code, "WC27-0001");

  await api("POST", "/players", { first_name: "Alex", last_name: "Smith" });
  await api("POST", "/players", { first_name: "Alex", last_name: "Smith" });
  const amb = await api("POST", `/tournaments/${S.winter}/registrations`, { first_name: "alex", last_name: "SMITH" });
  assert.equal(amb.status, 201);
  assert.equal(amb.body.match_method, "new");
  assert.equal(amb.body.needs_review, true);
  assert.match(amb.body.review_note, /Possible duplicates: BLP-\d+, BLP-\d+/);

  const one = await api("POST", "/players", { first_name: "Jordan", last_name: "Lee" });
  const probable = await api("POST", `/tournaments/${S.fall}/registrations`, { first_name: "Jordan", last_name: "Lee" });
  assert.equal(probable.body.player.id, one.body.id);
  assert.equal(probable.body.match_method, "name");
  assert.equal(probable.body.needs_review, true);

  const dob = await api("POST", `/tournaments/${S.fall}/registrations`, { first_name: "Jordan", last_name: "Lee", birth_date: "1999-09-09" });
  assert.equal(dob.status, 200, "same person, same tournament: existing registration");

  // Merge the ambiguous new Alex into the first Alex.
  const alexes = (await api("GET", "/players?q=alex smith")).body;
  const keep = alexes[0].id;
  const merged = await api("POST", `/players/${keep}/merge`, { from_player_id: amb.body.player.id });
  assert.equal(merged.status, 200);
  const winter = (await api("GET", `/tournaments/${S.winter}/registrations`)).body;
  const alexReg = winter.find((x) => x.last_name === "Smith");
  assert.equal(alexReg.player_id, keep);
  assert.equal(alexReg.needs_review, false);
  assert.equal(alexReg.registration_code, amb.body.registration_code, "the code survives the merge");
  assert.equal((await api("POST", `/players/${keep}/merge`, { from_player_id: keep })).status, 400);
});

test("check-in lookup by registration or player code", async () => {
  const r = await api("GET", "/registrations/lookup?code=fc26-0001");
  assert.equal(r.status, 200);
  assert.equal(r.body.player.first_name, "Sam");
  assert.deepEqual(r.body.registrations.map((x) => x.registration_code), ["FC26-0001", "WC27-0001"]);
  assert.equal(r.body.historical_stats.length, 1);
  assert.equal(r.body.summary.has_history, true);
  const byPlayer = await api("GET", `/registrations/lookup?code=${r.body.player.player_code}`);
  assert.equal(byPlayer.body.player.id, r.body.player.id);
  assert.equal((await api("GET", "/registrations/lookup?code=NOPE-0000")).status, 404);

  const key = await api("POST", "/admin/api-keys", { name: "Winter desk", role: "scorekeeper", tournament_id: S.winter });
  const desk = (path) => fetch(`${ctx.base}/api/v1${path}`, { headers: { authorization: `Bearer ${key.body.key}`, "x-forwarded-for": "198.51.100.77" } });
  assert.equal((await desk("/registrations/lookup?code=WC27-0001")).status, 200);
  const limited = await (await desk("/registrations/lookup?code=WC27-0001")).json();
  assert.equal(limited.player.email, undefined, "scorekeepers don't see emails");
  assert.equal((await desk("/registrations/lookup?code=FC26-0001")).status, 403, "scoped key can't look up other tournaments");
  assert.equal((await desk(`/tournaments/${S.winter}/registrations`)).status, 403, "full list is admin-only");
});

test("registration codes flow into the draft sheet and roster upload; PII stays private", async () => {
  const tpl = (await api("GET", `/tournaments/${S.fall}/roster.csv?template=1`)).body;
  assert.match(tpl, /,FC26-0001,/);
  assert.doesNotMatch(tpl, /FC26-0002/, "cancelled registrations aren't in the draft pool");
  const up = await api("POST", `/import/roster/${S.fall}`, { csv: "team,number,registration_code\nNorth,9,FC26-0001\n,,FC26-0003\n" });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.imported, 1);
  assert.equal(up.body.unassigned.length, 1, "undrafted player listed, not an error");
  const north = (await api("GET", `/tournaments/${S.fall}/teams`)).body.find((t) => t.name === "North");
  assert.equal(north.roster[0].first_name, "Sam");

  const pub = await (await fetch(`${ctx.base}/api/v1/players/${S.sam.player_id}`)).json();
  for (const k of ["email", "birth_date", "leagueapps_user_id", "factions_player_id"]) assert.equal(pub[k], undefined, `${k} is private`);
});

test("CSV fallback (LeagueApps registrations report) and field-map preview", async () => {
  const csv = "First Name,Last Name,Email,Birth Date,Registration Status\nPat,Puck,pat@example.com,3/14/2001,Active\nSam,Sniper,sam@example.com,,Active\n";
  const dry = await api("POST", `/tournaments/${S.winter}/registrations/import`, { csv, dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.committed, false);
  const real = await api("POST", `/tournaments/${S.winter}/registrations/import`, { csv });
  assert.equal(real.body.created, 1);
  assert.equal(real.body.updated, 1, "Sam already registered for Winter");
  const pat = (await api("GET", `/tournaments/${S.winter}/registrations`)).body.find((x) => x.first_name === "Pat");
  assert.equal(String(pat.birth_date).slice(0, 10), "2001-03-14");

  const pv = await api("GET", "/integrations/leagueapps/preview");
  assert.equal(pv.status, 200);
  assert.ok(pv.body.record_fields.includes("registrationStatus"));
  assert.equal(pv.body.mapped[0].sources.first_name, "firstName");

  // A different field name in a real account can be mapped by an admin.
  state.records = [{ id: 900, lastUpdated: 5000, programId: 9002, programName: "BLPA Winter Cup 2027", userId: 5900, givenName: "Gina", lastName: "Goalie", email: "gina@example.com" }];
  assert.equal((await api("PUT", "/integrations/leagueapps/field-map", { map: { first_name: "bad name!" } })).status, 400);
  await api("PUT", "/integrations/leagueapps/field-map", { map: { first_name: "givenName" } });
  const s = await api("POST", "/integrations/leagueapps/sync", {});
  assert.equal(s.body.created, 1, JSON.stringify(s.body));
  assert.ok((await api("GET", `/tournaments/${S.winter}/registrations`)).body.some((x) => x.first_name === "Gina"));
});

test("an organization connects its own LeagueApps with the .p12 file; the key is stored encrypted", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "la-test-"));
  fs.writeFileSync(path.join(dir, "key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  execFileSync("openssl", ["pkcs12", "-export", "-nocerts", "-inkey", path.join(dir, "key.pem"), "-out", path.join(dir, "key.p12"), "-passout", "pass:"]);
  const p12 = fs.readFileSync(path.join(dir, "key.p12")).toString("base64");
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal((await api("GET", "/integrations/leagueapps")).body.source, "server", "server settings until the organization connects");
  // Validation and a key LeagueApps refuses: nothing saved.
  assert.equal((await api("PUT", "/integrations/leagueapps", { site_id: "abc", client_id: CLIENT_ID, p12_base64: p12 })).status, 400);
  assert.equal((await api("PUT", "/integrations/leagueapps", { site_id: SITE, client_id: CLIENT_ID, private_key: "not a key" })).status, 400);
  const refused = await api("PUT", "/integrations/leagueapps", { site_id: SITE, client_id: CLIENT_ID, private_key: other });
  assert.equal(refused.status, 502, JSON.stringify(refused.body));
  assert.equal((await api("GET", "/integrations/leagueapps")).body.source, "server");

  const ok = await api("PUT", "/integrations/leagueapps", { site_id: SITE, client_id: CLIENT_ID, p12_base64: p12 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.source, "organization");
  assert.equal(ok.body.site_id, SITE);
  const db = require("../src/db");
  const row = await db.one("SELECT * FROM leagueapps_connections");
  assert.ok(!row.private_key_enc.includes("PRIVATE KEY"), "key encrypted at rest");
  assert.ok(!JSON.stringify(ok.body).includes("PRIVATE"), "key never returned");
  // Syncs use the organization's own connection.
  delete process.env.LEAGUEAPPS_PRIVATE_KEY;
  const s = await api("POST", "/integrations/leagueapps/sync", {});
  assert.equal(s.status, 200, JSON.stringify(s.body));

  // An API key can't change credentials; disconnecting removes them.
  const key = (await api("POST", "/admin/api-keys", { name: "la desk", role: "admin" })).body.key;
  assert.equal((await api("PUT", "/integrations/leagueapps", { site_id: SITE, client_id: "x", private_key: "y" }, key)).status, 403);
  assert.equal((await api("DELETE", "/integrations/leagueapps")).status, 204);
  assert.equal((await api("GET", "/integrations/leagueapps")).body.configured, false);
  assert.equal((await api("POST", "/integrations/leagueapps/sync", {})).status, 503);
});

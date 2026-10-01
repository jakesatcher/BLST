const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, ADMIN } = require("./helpers");

let ctx;
let api;
const S = {};
// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test.before(async () => {
  ctx = await startApp();
  api = ctx.api;
  const t = await api("POST", "/tournaments", { name: "Draft Cup", num_teams: 2, team_names: ["North Stars", "South Paws"] });
  S.tid = t.body.id;
  const teams = (await api("GET", `/tournaments/${S.tid}`)).body.teams;
  [S.north, S.south] = teams.map((x) => x.id);
});

test.after(async () => {
  ctx.server.close();
  await require("../src/db").close();
});

async function put(path, body, type, token = ADMIN) {
  const headers = { "content-type": type };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${ctx.base}/api/v1${path}`, { method: "PUT", headers, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("team logos: upload, serve, show up in team and game data, remove", async () => {
  assert.equal((await put(`/teams/${S.north}/logo`, PNG, "image/png", null)).status, 401);
  assert.equal((await put(`/teams/${S.north}/logo`, Buffer.from("hello"), "image/png")).status, 415, "sniffs bytes, not the header");

  const up = await put(`/teams/${S.north}/logo`, PNG, "application/octet-stream");
  assert.equal(up.status, 200);
  assert.equal(up.body.content_type, "image/png");
  const res = await fetch(`${ctx.base}${up.body.logo_url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("cache-control"), /immutable/);
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);

  const teams = (await api("GET", `/tournaments/${S.tid}/teams`)).body;
  assert.equal(teams.find((x) => x.id === S.north).logo_version, up.body.logo_version);
  const g = await api("POST", `/tournaments/${S.tid}/games`, { home_team_id: S.north, away_team_id: S.south });
  const games = (await api("GET", `/tournaments/${S.tid}/games`)).body;
  assert.equal(games[0].home_logo, up.body.logo_version);
  const snap = (await api("GET", `/games/${g.body.id}`)).body;
  assert.equal(snap.home.logo_version, up.body.logo_version);
  const exp = (await api("GET", `/export/tournaments/${S.tid}`)).body;
  assert.equal(exp.teams.find((x) => x.id === S.north).logo_url, up.body.logo_url);

  const svg = await put(`/teams/${S.south}/logo`, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>', "image/svg+xml");
  assert.equal(svg.body.content_type, "image/svg+xml");
  const svgRes = await fetch(`${ctx.base}/api/v1/teams/${S.south}/logo`);
  assert.match(svgRes.headers.get("content-security-policy"), /sandbox/);

  const tl = await put(`/tournaments/${S.tid}/logo`, PNG, "image/png");
  assert.equal(tl.status, 200);
  assert.equal((await api("GET", `/tournaments/${S.tid}`)).body.logo_version, tl.body.logo_version);

  assert.equal((await api("DELETE", `/teams/${S.north}/logo`)).status, 204);
  assert.equal((await fetch(`${ctx.base}/api/v1/teams/${S.north}/logo`)).status, 404);
  assert.equal((await api("GET", `/tournaments/${S.tid}/teams`)).body.find((x) => x.id === S.north).logo_version, null);
  await api("DELETE", `/games/${g.body.id}`);
});

test("draft upload: template, preview, draft picks, blank lines", async () => {
  const tpl = await api("GET", `/tournaments/${S.tid}/roster.csv?template=1`);
  assert.equal(tpl.status, 200);
  const lines = tpl.body.trim().split(/\r?\n/);
  assert.equal(lines[0], "team,number,first_name,last_name,position,role,email,round,pick,external_id");
  assert.deepEqual(lines.slice(1).map((l) => l.split(",")[0]), ["North Stars", "South Paws"]);
  assert.equal((await api("GET", `/tournaments/${S.tid}/roster.csv`, undefined, null)).status, 401);

  // A real draft sheet: different header names, semicolons (European Excel), a captain column.
  const csv = [
    "Round;Pick;Drafted By;Player;Jersey #;Pos;Captain;Email",
    "1;1;North Stars;Ann Archer;9;C;yes;ann@example.com",
    "1;2;South Paws;Ben Brook;9;D;;ben@example.com",
    "2;3;North Stars;Cal Cole;12;LW;;",
    "2;4;South Paws;Dee Dunn;30;G;;",
    ";;North Stars;;;;;",
  ].join("\n");
  const dry = await api("POST", `/import/roster/${S.tid}`, { csv, dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.committed, false);
  assert.equal(dry.body.skipped_blank, 1);
  assert.equal(dry.body.preview.length, 4);
  assert.deepEqual(dry.body.preview.map((p) => p.change), ["added", "added", "added", "added"]);
  assert.equal(dry.body.preview[0].role, "C");
  assert.equal((await api("GET", `/tournaments/${S.tid}/teams`)).body[0].roster.length, 0, "dry run saves nothing");

  const real = await api("POST", `/import/roster/${S.tid}`, { csv });
  assert.equal(real.status, 200);
  assert.equal(real.body.imported, 4);
  const teams = (await api("GET", `/tournaments/${S.tid}/teams`)).body;
  const north = teams.find((x) => x.id === S.north).roster;
  const ann = north.find((r) => r.first_name === "Ann");
  assert.equal(ann.jersey_number, 9);
  assert.equal(ann.role, "C");
  assert.equal(ann.draft_round, 1);
  assert.equal(ann.draft_pick, 1);
  S.p = Object.fromEntries(teams.flatMap((x) => x.roster).map((r) => [r.first_name, r.id]));
  const export_ = await api("GET", `/tournaments/${S.tid}/roster.csv`);
  assert.match(export_.body, /North Stars,9,Ann,Archer,C,C,ann@example.com,1,1/);
});

test("draft upload: number swaps, moves and replace", async () => {
  // Ann and Cal swap numbers, Ben moves to North, Dee isn't in the file.
  const csv = [
    "team,number,name,round,pick",
    "North Stars,12,Ann Archer,1,1",
    "North Stars,9,Cal Cole,2,3",
    "North Stars,4,Ben Brook,1,2",
  ].join("\n");
  const dry = await api("POST", `/import/roster/${S.tid}`, { csv, replace: true, dry_run: true });
  assert.deepEqual(dry.body.errors, []);
  assert.deepEqual(dry.body.removed.map((r) => r.name), ["Dee Dunn"]);
  assert.equal(dry.body.preview.find((p) => p.name === "Ben Brook").change, "moved");

  const r = await api("POST", `/import/roster/${S.tid}`, { csv, replace: true });
  assert.equal(r.status, 200);
  const teams = (await api("GET", `/tournaments/${S.tid}/teams`)).body;
  const north = Object.fromEntries(teams.find((x) => x.id === S.north).roster.map((x) => [x.first_name, x.jersey_number]));
  assert.deepEqual(north, { Ann: 12, Cal: 9, Ben: 4 });
  assert.equal(teams.find((x) => x.id === S.south).roster.length, 0);
  const moves = (await api("GET", `/tournaments/${S.tid}/roster/moves`)).body;
  assert.equal(moves[0].first_name, "Ben");
});

test("draft upload: clear problems for duplicate and taken numbers", async () => {
  const dup = await api("POST", `/import/roster/${S.tid}`, { csv: "team,number,name\nSouth Paws,7,Eve Ever\nSouth Paws,7,Fay Fox\n" });
  assert.equal(dup.status, 422);
  assert.match(dup.body.errors[0].error, /#7 on South Paws is also given to Eve Ever \(row 2\)/);

  // #9 belongs to Cal, who isn't in this file and replace is off.
  const taken = await api("POST", `/import/roster/${S.tid}`, { csv: "team,number,name\nNorth Stars,9,Gus Gale\n" });
  assert.equal(taken.status, 422);
  assert.match(taken.body.errors[0].error, /already worn by Cal Cole/);

  // With replace on, a problem row means nobody gets removed.
  const typo = await api("POST", `/import/roster/${S.tid}`, { csv: "team,number,name\nNorth Stars,12,Ann Archer\nNorth Starz,5,Hal Hope\n", replace: true, skip_errors: true });
  assert.equal(typo.status, 200);
  assert.equal(typo.body.replace_skipped, true);
  assert.equal((await api("GET", `/tournaments/${S.tid}/teams`)).body.find((x) => x.id === S.north).roster.length, 3);
});

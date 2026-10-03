// Flexible history imports: Excel / CSV / JSON / pasted text and links,
// header detection, column guessing and mapping, and league history files
// with many seasons and divisions in one upload.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { makeXlsx } = require("./fixtures/make-xlsx");
const sources = require("../src/services/sources");

let ctx;
let api;
let db;
const S = {};
const b64 = (buf) => Buffer.from(buf).toString("base64");

test.before(async () => {
  ctx = await startApp();
  api = ctx.api;
  db = require("../src/db");
  S.league = (await api("POST", "/leagues", { name: "Metro Beer League", short_name: "Metro", divisions: ["B", "C"] })).body;
  // Al already exists (registered with his email): history should land on him.
  S.al = (await api("POST", "/players", { first_name: "Al", last_name: "Smith", email: "al@example.com" })).body.id;
});

test.after(async () => {
  ctx.server.close();
  await db.close();
});

// An export like a stats site's: a title row, a blank row, the header, a
// totals line, two seasons and three divisions ("C League" = division C,
// "D" doesn't exist yet), a goalie, and a date-formatted birth date.
const xlsx = makeXlsx({
  "Read me": [["This workbook holds Metro's history"]],
  Stats: [
    ["Metro Beer League: all seasons"],
    [],
    ["Season", "Div", "Player", "E-mail", "Team", "Pos", "GP", "G", "A", "PIM", "GA", "SV", "DOB"],
    [2023, "C", "Smith, Al", "AL@example.com", "Wolves", "C", 10, 6, 4, 2, "", "", new Date("1990-04-02")],
    [2023, "C League", "Bo Brown", "", "Bears", "D", 10, 1, 7, 12, "", "", ""],
    [2023, "B", "Cy Clark", "cy@example.com", "Hawks", "LW", 9, 9, 2, 0, "", "", ""],
    ["2024", "D", "Smith, Al", "al@example.com", "Owls", "C", 8, 2, 2, 0, "", "", ""],
    ["2024", "C", "Gail Goalie", "", "Wolves", "G", 10, "", "", "", 22, 280, ""],
    ["Totals", "", "", "", "", "", 47, 18, 15, 14, 22, 280, ""],
  ],
});

test("preview: finds the header under title rows, skips totals, guesses every column", async () => {
  const r = await api("POST", "/import/preview", { source: { type: "file", name: "metro-history.xlsx", data_base64: b64(xlsx) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.sheets, ["Stats"], "sheets without data are skipped");
  assert.equal(r.body.header_row, 3);
  assert.equal(r.body.row_count, 5, "totals line dropped");
  assert.deepEqual(r.body.mapping, {
    name: "Player", email: "E-mail", birth_date: "DOB", position: "Pos", season: "Season", division: "Div", team_name: "Team",
    gp: "GP", goals: "G", assists: "A", pim: "PIM", goals_against: "GA", saves: "SV",
  });
  assert.deepEqual(r.body.seasons.map((x) => x.value), ["2023", "2024"]);
  assert.deepEqual(r.body.divisions.map((x) => x.value), ["B", "C", "C League", "D"]);
  assert.equal(r.body.sample[0].DOB, "1990-04-02", "Excel dates come through as dates");
});

test("league history: a dry run changes nothing; then every season-division becomes a competition", async () => {
  const source = { type: "file", name: "metro-history.xlsx", data_base64: b64(xlsx) };
  const target = { kind: "league", league_id: S.league.id };
  const dry = await api("POST", "/import/history", { source, target, dry_run: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.groups.length, 4, "2023 B, 2023 C (C + C League), 2024 C, 2024 D");
  assert.ok(dry.body.groups.find((g) => g.label === "2024 · D").new_division);
  const after = (await api("GET", `/leagues/${S.league.id}`)).body;
  assert.equal(after.seasons.length, 0, "dry run created no seasons");
  assert.equal(after.divisions.length, 2, "…or divisions");

  const r = await api("POST", "/import/history", { source, target });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.totals.committed, 4, JSON.stringify(r.body.groups.map((g) => [g.label, g.errors])));
  assert.equal(r.body.totals.imported, 5);
  const L = (await api("GET", `/leagues/${S.league.id}`)).body;
  assert.deepEqual(L.divisions.map((d) => d.name), ["B", "C", "D"], "D added after B and C");
  assert.deepEqual(L.seasons.map((s) => s.name).sort(), ["2023", "2024"]);
  const c2023 = r.body.groups.find((g) => g.label.startsWith("2023") && g.division === "C");
  assert.equal(c2023.imported, 2, "C and C League are the same division");

  // Stats follow Al across seasons and divisions, on his existing record.
  const stats = (await api("GET", `/leagues/${S.league.id}/stats`)).body;
  const al = stats.skaters.find((x) => x.player_id === S.al);
  assert.ok(al, "matched Al by email (any case)");
  assert.equal(al.goals, 8);
  assert.equal(al.gp, 18);
  const gail = stats.goalies.find((x) => x.name === "Gail Goalie");
  assert.ok(gail, "goalie line from GA/SV");
  assert.equal(gail.goals_against, 22);
  // Season standings pages exist for imported seasons, teams from the file.
  const comp = (await api("GET", `/tournaments/${c2023.competition_id}`)).body;
  assert.deepEqual(comp.teams.map((t) => t.name).sort(), ["Bears", "Wolves"]);
  assert.equal(comp.status, "completed");
});

test("the same season-division can't be counted twice; replace swaps it", async () => {
  const source = { type: "file", name: "metro-history.xlsx", data_base64: b64(xlsx) };
  const again = await api("POST", "/import/history", { source, target: { kind: "league", league_id: S.league.id } });
  assert.equal(again.status, 422);
  assert.ok(again.body.groups.every((g) => !g.committed && g.duplicate), JSON.stringify(again.body.groups.map((g) => g.errors)));
  const rep = await api("POST", "/import/history", { source, target: { kind: "league", league_id: S.league.id }, replace: true });
  assert.equal(rep.body.totals.committed, 4);
  const al = (await api("GET", `/leagues/${S.league.id}/stats`)).body.skaters.find((x) => x.player_id === S.al);
  assert.equal(al.goals, 8, "replaced, not added");
});

test("JSON from another system with nested fields, a chosen mapping, and a default season and division", async () => {
  const json = JSON.stringify({ meta: { league: "x" }, data: { players: [
    { player: { firstName: "Dee", lastName: "Dangle" }, team: { name: "Foxes" }, stats: { gamesPlayed: 12, goals: 4, assists: 9, penaltyMinutes: 6 } },
    { player: { firstName: "Al", lastName: "Smith" }, contact: "al@example.com", team: { name: "Crows" }, stats: { gamesPlayed: 12, goals: 7, assists: 1, penaltyMinutes: 0 } },
  ] } });
  const source = { type: "file", name: "export.json", data_base64: b64(json) };
  const pv = (await api("POST", "/import/preview", { source })).body;
  assert.equal(pv.mapping.first_name, "player.firstName");
  assert.equal(pv.mapping.gp, "stats.gamesPlayed");
  assert.equal(pv.mapping.team_name, "team.name");
  assert.ok(pv.unmapped.includes("contact"));
  // The admin points Email at the "contact" column; no season/division columns, so they choose one.
  const mapping = { ...pv.mapping, email: "contact" };
  const noSeason = await api("POST", "/import/history", { source, mapping, target: { kind: "league", league_id: S.league.id } });
  assert.equal(noSeason.status, 400);
  assert.match(noSeason.body.error, /no season/);
  const r = await api("POST", "/import/history", { source, mapping, target: { kind: "league", league_id: S.league.id, season: "2022", division: "B" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.groups[0].created_players, 1, "Dee is new; Al matched by the mapped email");
  const al = (await api("GET", `/leagues/${S.league.id}/stats`)).body.skaters.find((x) => x.player_id === S.al);
  assert.equal(al.goals, 15);
});

test("pasted spreadsheet text into a standalone tournament (Tournament ID); bad mappings and links refused", async () => {
  await api("PUT", "/admin/tournament-types", { types: ["DEX", "Bash"] });
  const text = "Name\tTeam\tGP\tG\tA\nAl Smith\tRed\t4\t3\t3\nNew Guy\tBlue\t4\t0\t1\n";
  const pv = (await api("POST", "/import/preview", { source: { type: "text", text } })).body;
  assert.equal(pv.mapping.name, "Name");
  const r = await api("POST", "/import/history", { source: { type: "text", text }, target: { kind: "tournament", city: "Erie", series: "Bash", year: 2021 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.groups[0].label, "ERIE-BASH-2021");
  assert.equal((await api("GET", `/players/${S.al}/career`)).body.career.skater.goals, 18);

  const bad = await api("POST", "/import/history", { source: { type: "text", text }, mapping: { goals: "G" }, target: { kind: "tournament", city: "Erie", series: "DEX", year: 2020 } });
  assert.equal(bad.status, 400, "no player column");
  assert.equal((await api("POST", "/import/history", { source: { type: "text", text }, mapping: { name: "Nope" }, target: {} })).status, 400);
  assert.equal((await api("POST", "/import/preview", { source: { type: "url", url: "http://example.com/x.csv" } })).status, 400, "https only");
  const config = require("../src/config");
  const allow = config.allowPrivateUrls;
  config.allowPrivateUrls = false; // tests allow local webhooks; production doesn't
  try {
    assert.equal((await api("POST", "/import/preview", { source: { type: "url", url: "https://127.0.0.1/x.csv" } })).status, 400, "no internal addresses");
  } finally {
    config.allowPrivateUrls = allow;
  }
  assert.equal((await api("POST", "/import/preview", { source: { type: "file", name: "old.xls", data_base64: b64(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) } })).status, 400);
  assert.equal(sources.directUrl("https://docs.google.com/spreadsheets/d/AbC-12_x/edit?usp=sharing#gid=99"),
    "https://docs.google.com/spreadsheets/d/AbC-12_x/export?format=csv&gid=99");
  assert.equal((await api("POST", "/import/preview", { source: { type: "text", text } }, null)).status, 401, "admins only");
});

// Stats page: all-time stat leaders (BLST games + imported history) and the
// organization's awards (BLPA: Heel of the Year).
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");

let ctx;
let api;
let db;
const S = {};

test.before(async () => {
  ctx = await startApp();
  api = ctx.api;
  db = require("../src/db");
});

test.after(async () => {
  ctx.server.close();
  await db.close();
});

test("BLPA always shows Nick Fleehart as Heel of the Year, linked once he's a player", async () => {
  let awards = (await api("GET", "/awards", undefined, null)).body;
  assert.deepEqual(awards, [{ title: "Heel of the Year", name: "Nick Fleehart", note: null, player_id: null }]);
  S.nick = (await api("POST", "/players", { first_name: "Nick", last_name: "Fleehart" })).body.id;
  awards = (await api("GET", "/awards", undefined, null)).body;
  assert.equal(awards[0].player_id, S.nick);
});

test("awards are edited by signed-in admins only", async () => {
  const key = (await api("POST", "/admin/api-keys", { name: "desk", role: "admin" })).body.key;
  assert.equal((await api("PUT", "/admin/awards", { awards: [] }, key)).status, 403);
  assert.equal((await api("PUT", "/admin/awards", { awards: [{ title: "Heel of the Year" }] })).status, 400, "needs a name");
  const r = await api("PUT", "/admin/awards", { awards: [{ title: "Heel of the Year", name: "Nick Fleehart" }, { title: "Iron Man", name: "Pat Puck", note: "Never missed a game" }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.equal(r.body[1].note, "Never missed a game");
  await api("PUT", "/admin/awards", { awards: [{ title: "Heel of the Year", name: "Nick Fleehart" }] });
});

test("all-time leaders: goals, assists, PIM and goalie panels from games and imported history", async () => {
  const t = (await api("POST", "/tournaments", { name: "Leaders Cup", num_teams: 2, team_names: ["Reds", "Blues"] })).body;
  const teams = (await api("GET", `/tournaments/${t.id}`)).body.teams;
  const p = async (first, last, position) => (await api("POST", "/players", { first_name: first, last_name: last, position })).body.id;
  S.amy = await p("Amy", "Ace", "C");
  S.bob = await p("Bob", "Brute", "D");
  S.gil = await p("Gil", "Goalie", "G");
  S.hal = await p("Hal", "Hands", "G");
  const roster = [[S.amy, 0, 9], [S.nick, 0, 13], [S.gil, 0, 30], [S.bob, 1, 4], [S.hal, 1, 31]];
  for (const [id, team, n] of roster) assert.equal((await api("POST", `/tournaments/${t.id}/roster`, { player_id: id, team_id: teams[team].id, jersey_number: n })).status, 201);
  const g = (await api("POST", `/tournaments/${t.id}/games`, { home_team_id: teams[0].id, away_team_id: teams[1].id })).body;
  await api("POST", `/games/${g.id}/start`, {});
  await api("POST", `/games/${g.id}/events`, { type: "goal", player_id: S.amy, assist1_id: S.nick });
  await api("POST", `/games/${g.id}/events`, { type: "goal", player_id: S.amy });
  await api("POST", `/games/${g.id}/events`, { type: "shot", player_id: S.bob });
  await api("POST", `/games/${g.id}/events`, { type: "penalty", player_id: S.nick, infraction: "Roughing", penalty_minutes: 5 });
  await api("POST", `/games/${g.id}/events`, { type: "penalty", player_id: S.bob, infraction: "Hooking" });
  await api("POST", `/games/${g.id}/clock`, { action: "set", remaining_sec: 60 }); // 14 minutes played
  assert.equal((await api("POST", `/games/${g.id}/end`, {})).status, 200);
  // Imported history adds to the all-time totals.
  const imp = await api("POST", "/import/historical", { city: "Pittsburgh", series: "DEX", year: 2024, rows: [{ name: "Bob Brute", gp: 10, g: 4, a: 9, pim: 30 }] });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));

  const l = (await api("GET", "/leaders", undefined, null)).body;
  assert.deepEqual(l.goals.map((x) => [x.name, x.value]), [["Bob Brute", 4], ["Amy Ace", 2]]);
  assert.deepEqual(l.assists.map((x) => [x.name, x.value]), [["Bob Brute", 9], ["Nick Fleehart", 1]]);
  assert.deepEqual(l.pim.map((x) => [x.name, x.value]), [["Bob Brute", 32], ["Nick Fleehart", 5]]);
  assert.equal(l.pim[0].gp, 11);
  assert.deepEqual(l.wins.map((x) => x.name), ["Gil Goalie"]);
  assert.equal(l.save_pct[0].name, "Gil Goalie", "no goals against");
  assert.equal(l.gaa[0].name, "Gil Goalie");
  assert.equal(l.gaa[0].value, 0);
  assert.equal(l.gaa[1].name, "Hal Hands", "lower GAA first");
  assert.ok(l.save_pct.some((x) => x.name === "Hal Hands"));
  // One tournament's leaders (the stats page's scope picker) use the tournament endpoint.
  const tl = (await api("GET", `/tournaments/${t.id}/leaders`, undefined, null)).body;
  assert.equal(tl.goals[0].name, "Amy Ace");
  assert.equal(tl.pim[0].value, 5);
});

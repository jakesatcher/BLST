// Leagues: league -> season -> division competitions, stats by season and
// division that follow players across teams and divisions, and ratings.
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

const player = async (first, last, position) => (await api("POST", "/players", { first_name: first, last_name: last, position })).body.id;

/** Rosters players on a competition's teams and plays one game with the given goals (by player id). */
async function play(compId, rosters, goals, { home, away } = {}) {
  const teams = (await api("GET", `/tournaments/${compId}`)).body.teams;
  const id = (n) => teams.find((t) => t.name === n).id;
  for (const [team, ids] of Object.entries(rosters)) {
    for (const [i, pid] of ids.entries()) {
      const r = await api("POST", `/tournaments/${compId}/roster`, { player_id: pid, team_id: id(team), jersey_number: 20 + i });
      assert.ok([201, 409].includes(r.status), JSON.stringify(r.body));
    }
  }
  const [h, a] = [home || Object.keys(rosters)[0], away || Object.keys(rosters)[1]];
  const g = (await api("POST", `/tournaments/${compId}/games`, { home_team_id: id(h), away_team_id: id(a) })).body;
  assert.equal((await api("POST", `/games/${g.id}/start`, {})).status, 200);
  for (const pid of goals) assert.equal((await api("POST", `/games/${g.id}/events`, { type: "goal", player_id: pid })).status, 201);
  const end = await api("POST", `/games/${g.id}/end`, {});
  assert.equal(end.status, 200, JSON.stringify(end.body));
  return g.id;
}

test("a league has divisions and seasons; each division in a season is a competition", async () => {
  const l = await api("POST", "/leagues", { name: "Metro Beer League", short_name: "Metro", divisions: ["B", "C", "D"] });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  S.league = l.body.id;
  S.div = Object.fromEntries(l.body.divisions.map((d) => [d.name, d]));
  assert.deepEqual(l.body.divisions.map((d) => [d.name, d.rank, d.strength_used]), [["B", 1, 1], ["C", 2, 0.85], ["D", 3, 0.7]]);
  S.s2025 = (await api("POST", `/leagues/${S.league}/seasons`, { name: "2025", year: 2025 })).body.id;
  S.s2026 = (await api("POST", `/leagues/${S.league}/seasons`, { name: "2026", year: 2026 })).body.id;
  assert.equal((await api("POST", `/leagues/${S.league}/seasons`, { name: "2025" })).status, 409);

  const mk = async (season, div, names) => {
    const r = await api("POST", `/leagues/${S.league}/seasons/${season}/divisions/${S.div[div].id}`, { team_names: names });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  S.b25 = await mk(S.s2025, "B", ["Wolves", "Bears"]);
  S.d25 = await mk(S.s2025, "D", ["Owls", "Hawks"]);
  S.b26 = await mk(S.s2026, "B", ["Wolves", "Bears"]);
  assert.equal(S.b25.name, "Metro 2025 · B");
  assert.equal(S.b25.kind, "league");
  assert.equal((await api("POST", `/leagues/${S.league}/seasons/${S.s2025}/divisions/${S.div.B.id}`, { num_teams: 2 })).status, 409, "one B per season");

  const view = (await api("GET", `/leagues/${S.league}`, undefined, ctx.viewer)).body;
  assert.deepEqual(view.seasons.map((s) => [s.name, s.divisions.map((d) => d.division)]), [["2026", ["B"]], ["2025", ["B", "D"]]]);
  // Teams carry over between seasons (same name, same team).
  const club = (id) => db.one("SELECT club_id FROM teams WHERE tournament_id = $1 AND name = 'Wolves'", [id]);
  assert.equal((await club(S.b25.id)).club_id, (await club(S.b26.id)).club_id);
  // Admin only.
  assert.equal((await api("POST", "/leagues", { name: "X" }, null)).status, 401);
});

test("stats by season and division follow players across teams and divisions", async () => {
  S.ace = await player("Ace", "Sniper", "C");
  S.bea = await player("Bea", "Setter", "D");
  S.cal = await player("Cal", "Grinder", "LW");
  S.dot = await player("Dot", "Depth", "RW");
  S.gil = await player("Gil", "Goalie", "G");
  // 2025: Ace plays B for the Wolves and D for the Owls (two divisions, one season).
  await play(S.b25.id, { Wolves: [S.ace, S.bea], Bears: [S.cal] }, [S.ace, S.ace, S.cal]);
  await play(S.d25.id, { Owls: [S.ace, S.dot], Hawks: [S.gil] }, [S.ace, S.dot, S.ace, S.ace]);
  // 2026: Ace moves to the Bears.
  await play(S.b26.id, { Bears: [S.ace, S.cal], Wolves: [S.bea] }, [S.ace, S.bea, S.ace]);

  const all = (await api("GET", `/leagues/${S.league}/stats`, undefined, ctx.viewer)).body;
  const ace = all.skaters.find((p) => p.player_id === S.ace);
  assert.equal(ace.goals, 2 + 3 + 2);
  assert.equal(ace.gp, 3);
  assert.deepEqual(ace.teams.sort(), ["Bears", "Owls", "Wolves"]);
  assert.deepEqual(ace.divisions.sort(), ["B", "D"]);
  assert.equal(ace.lines.length, 3, "one line per season-division");
  assert.equal(all.skaters[0].player_id, S.ace);

  const s25 = (await api("GET", `/leagues/${S.league}/stats?season_id=${S.s2025}`)).body;
  assert.equal(s25.skaters.find((p) => p.player_id === S.ace).goals, 5);
  const d25 = (await api("GET", `/leagues/${S.league}/stats?season_id=${S.s2025}&division_id=${S.div.D.id}`)).body;
  assert.equal(d25.skaters.find((p) => p.player_id === S.ace).goals, 3);
  assert.ok(!d25.skaters.some((p) => p.player_id === S.bea), "Bea didn't play D");

  const st = (await api("GET", `/leagues/${S.league}/standings?season_id=${S.s2025}`)).body;
  assert.deepEqual(st.map((d) => d.division), ["B", "D"]);
  assert.equal(st[0].standings.find((r) => r.name === "Wolves").w, 1);

  const prof = (await api("GET", `/leagues/${S.league}/players/${S.ace}`)).body;
  assert.deepEqual(prof.skater.map((l) => [l.season, l.division, l.teams.join()]), [["2025", "B", "Wolves"], ["2025", "D", "Owls"], ["2026", "B", "Bears"]]);
  assert.ok(prof.rating.rating >= 0 && prof.rating.rating <= 100);
});

test("historical stats can be uploaded into a league division-season, once", async () => {
  // An older season, before BLST.
  S.s2024 = (await api("POST", `/leagues/${S.league}/seasons`, { name: "2024", year: 2024 })).body.id;
  const c24 = (await api("POST", `/leagues/${S.league}/seasons/${S.s2024}/divisions/${S.div.C.id}`, { team_names: ["Owls", "Hawks"] })).body;
  const csv = "name,team,gp,g,a\nBea Setter,Owls,10,6,9\nNew Face,Hawks,10,1,1\n";
  const up = await api("POST", "/import/historical", { csv, tournament_id: c24.id });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await api("POST", "/import/historical", { csv, tournament_id: c24.id })).status, 409, "not twice");
  const bea = (await api("GET", `/leagues/${S.league}/stats`)).body.skaters.find((p) => p.player_id === S.bea);
  assert.equal(bea.goals, 6 + 1);
  assert.ok(bea.divisions.includes("C"));
});

test("ratings: production per game, adjusted for division, games played and recency", async () => {
  // By default players need 3 games to be rated; this small test league has fewer.
  assert.equal((await api("GET", `/leagues/${S.league}/ratings`)).body.settings.min_games, 3);
  await api("PUT", `/leagues/${S.league}/rating-settings`, { min_games: 1 });
  const r = (await api("GET", `/leagues/${S.league}/ratings`, undefined, ctx.viewer)).body;
  assert.ok(r.skaters.length >= 4);
  for (const s of r.skaters) {
    assert.ok(s.rating >= 0 && s.rating <= 100);
    assert.ok(Array.isArray(s.breakdown) && s.breakdown.length);
  }
  const ace = r.skaters.find((s) => s.player_id === S.ace);
  assert.equal(r.skaters[0].player_id, S.ace, "most production");
  const d = ace.breakdown.find((b) => b.division === "D");
  assert.equal(d.strength, 0.7);
  assert.equal(d.adjusted_per_game, Math.round(d.production_per_game * 0.7 * 1000) / 1000, "D production counts less");
  const b26 = ace.breakdown.find((b) => b.season === "2026");
  assert.equal(b26.recency, 1);
  assert.equal(ace.breakdown.find((b) => b.season === "2025").recency, 0.6);
  // Sample size: 10 imported games of steady scoring vs. one game: Bea's 10-game
  // season carries more weight than a single game would.
  const bea = r.skaters.find((s) => s.player_id === S.bea);
  assert.ok(["low", "medium", "high"].includes(bea.confidence));
  assert.ok(r.goalies.some((g) => g.player_id === S.gil));

  // Division filter: listed by latest division, compared with the whole league.
  const onlyD = (await api("GET", `/leagues/${S.league}/ratings?division_id=${S.div.D.id}`)).body;
  assert.ok(onlyD.skaters.every((s) => s.latest_division === "D"));
  // As of a season: later seasons ignored.
  const asOf = (await api("GET", `/leagues/${S.league}/ratings?season_id=${S.s2025}`)).body;
  assert.ok(asOf.skaters.find((s) => s.player_id === S.ace).breakdown.every((b) => b.season !== "2026"));

  // Same production, stronger division = higher rating (strength is configurable).
  const svc = require("../src/services/ratings");
  assert.equal(svc.percentiles([1, 2, 3])(3), 100);
  assert.equal(svc.percentiles([1, 2, 3])(1), 0);
  const saved = (await api("PUT", `/leagues/${S.league}/rating-settings`, { assist: 1, min_games: 1, nonsense: 5 })).body;
  assert.equal(saved.assist, 1);
  assert.equal(saved.nonsense, undefined);
  assert.equal((await api("PUT", `/leagues/${S.league}/rating-settings`, { assist: 1 }, null)).status, 401);
  assert.equal((await api("PATCH", `/leagues/${S.league}/divisions/${S.div.D.id}`, { strength: 0.5 })).body.strength, 0.5);
  const after = (await api("GET", `/leagues/${S.league}/ratings`)).body.skaters.find((s) => s.player_id === S.ace);
  assert.equal(after.breakdown.find((b) => b.division === "D").strength, 0.5);
});

test("leagues can't be removed out from under played games", async () => {
  assert.equal((await api("DELETE", `/leagues/${S.league}/divisions/${S.div.B.id}`)).status, 409);
  assert.equal((await api("DELETE", `/leagues/${S.league}/seasons/${S.s2026}`)).status, 409);
  assert.equal((await api("DELETE", `/leagues/${S.league}`)).status, 409);
  const empty = (await api("POST", "/leagues", { name: "Empty League" })).body;
  assert.equal((await api("DELETE", `/leagues/${empty.id}`)).status, 204);
});

test("ratings: the same production rates higher in a stronger division, and small samples are pulled to average", () => {
  // Pure checks of the formula on made-up lines (no database).
  const strength = (rank) => require("../src/services/leagues").strengthOf({ rank, strength: null });
  assert.equal(strength(1), 1);
  assert.equal(strength(2), 0.85);
  assert.equal(strength(3), 0.7);
  const perGame = 1.2;
  assert.ok(perGame * strength(1) > perGame * strength(3));
  const prior = 10;
  const mean = 0.5;
  const oneGame = (2.0 * 1 + mean * prior) / (1 + prior);
  const tenGames = (1.0 * 10 + mean * prior) / (10 + prior);
  assert.ok(tenGames > oneGame, "1.0/game over 10 games beats 2.0 in one game");
});

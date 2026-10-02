// History across tournaments: stats follow players through draft
// tournaments, teams carry over between team tournaments, and imported
// players without emails are matched to registered players.
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

/** A tournament with named teams, a few players on them, and one finished game. */
async function tournament(name, { format, teams, rosters, goals }) {
  const t = (await api("POST", "/tournaments", { name, season: name.slice(-4), num_teams: teams.length, team_names: teams, format })).body;
  const ts = (await api("GET", `/tournaments/${t.id}`)).body.teams;
  const teamId = (n) => ts.find((x) => x.name === n).id;
  for (const [team, players] of Object.entries(rosters)) {
    for (const [i, pid] of players.entries()) {
      const r = await api("POST", `/tournaments/${t.id}/roster`, { player_id: pid, team_id: teamId(team), jersey_number: 10 + i });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
  }
  const g = (await api("POST", `/tournaments/${t.id}/games`, { home_team_id: teamId(teams[0]), away_team_id: teamId(teams[1]) })).body;
  assert.equal((await api("POST", `/games/${g.id}/start`, {})).status, 200);
  for (const pid of goals) assert.equal((await api("POST", `/games/${g.id}/events`, { type: "goal", player_id: pid })).status, 201);
  const end = await api("POST", `/games/${g.id}/end`, {});
  assert.equal(end.status, 200, JSON.stringify(end.body));
  return { ...t, teamId };
}

async function player(first, last, email) {
  return (await api("POST", "/players", { first_name: first, last_name: last, email })).body.id;
}

test("draft tournaments: a player's stats follow them from team to team, plus imported history", async () => {
  S.ann = await player("Ann", "Draft", "ann@example.com");
  S.bo = await player("Bo", "Pick", "bo@example.com");
  S.cy = await player("Cy", "Young", "cy@example.com");
  S.di = await player("Di", "Reed", "di@example.com");
  await tournament("Draft Cup 2025", { teams: ["Red", "Blue"], rosters: { Red: [S.ann, S.cy], Blue: [S.bo, S.di] }, goals: [S.ann, S.ann, S.bo] });
  await tournament("Draft Cup 2026", { teams: ["Green", "Gold"], rosters: { Green: [S.bo, S.di], Gold: [S.ann, S.cy] }, goals: [S.ann, S.di, S.ann] });
  // Older seasons from a spreadsheet.
  const imp = await api("POST", "/import/historical", { city: "Akron", series: "DEX", year: 2023, csv: "first_name,last_name,team_name,gp,goals,assists\nAnn,Draft,Orange,6,4,5\n" });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));

  const dir = (await api("GET", "/history/players?q=draft")).body;
  assert.equal(dir.length, 1);
  const ann = dir[0];
  assert.equal(ann.skater.goals, 2 + 2 + 4, "both tournaments (two different teams) plus imported history");
  assert.equal(ann.events, 3);
  assert.equal(ann.skater.gp, 2 + 6);
  assert.equal(ann.email, undefined, "public directory has no emails");
  // Leaders across everything.
  const top = (await api("GET", "/history/players?sort=goals&limit=2")).body;
  assert.equal(top[0].player_id, S.ann);
  // The player page keeps each tournament's team.
  const career = (await api("GET", `/players/${S.ann}/career`)).body;
  assert.deepEqual(career.tournaments.map((l) => l.roster.team_name), ["Orange", "Red", "Gold"], "the imported event is a tournament too");
});

test("team tournaments: teams carry over, with their record and their players' stats", async () => {
  S.eve = await player("Eve", "Wolf", "eve@example.com");
  S.fin = await player("Fin", "Wolf", "fin@example.com");
  S.gus = await player("Gus", "Bear", "gus@example.com");
  // A history file from before BLST, with team names.
  const imp = await api("POST", "/import/historical", {
    club_teams: true, city: "Erie", series: "Bash", year: 2024,
    csv: "first_name,last_name,season,event_name,team_name,gp,goals,assists\nEve,Wolf,2024,Summer League,Timber Wolves,10,7,3\nOld,Timer,2024,Summer League,Timber Wolves,10,1,1\n",
  });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const t1 = await tournament("Team Cup 2025", { format: "team", teams: ["Timber Wolves", "Bears"], rosters: { "Timber Wolves": [S.eve, S.fin], Bears: [S.gus] }, goals: [S.eve, S.fin, S.gus] });
  // Same team next year, with a slightly different spelling.
  const t2 = await tournament("Team Cup 2026", { format: "team", teams: ["Timber-Wolves", "Bears"], rosters: { "Timber-Wolves": [S.eve], Bears: [S.gus, S.fin] }, goals: [S.gus, S.fin] });

  const clubs = (await api("GET", "/clubs")).body;
  const wolves = clubs.find((c) => c.name === "Timber Wolves");
  const bears = clubs.find((c) => c.name === "Bears");
  assert.ok(wolves && bears);
  assert.equal(clubs.filter((c) => /timber/i.test(c.name)).length, 2, "\"Timber-Wolves\" is a different name");
  // An admin folds the second spelling into the first.
  const other = clubs.find((c) => c.name === "Timber-Wolves");
  const merged = (await api("POST", `/clubs/${wolves.id}/merge`, { from_club_id: other.id })).body;
  assert.equal(merged.seasons.filter((s) => s.kind === "tournament" && !s.imported).length, 2);
  assert.ok(merged.seasons.some((s) => s.imported && s.season === "2024" && s.tournament === "Erie Bash 2024"), "imported season shows too");

  const w = merged.players;
  const eve = w.find((p) => p.player_id === S.eve);
  assert.equal(eve.skater.goals, 7 + 1, "imported history + games for this team");
  const fin = w.find((p) => p.player_id === S.fin);
  assert.equal(fin.skater.goals, 1, "only goals scored for this team (his 2026 goal was for the Bears)");
  assert.ok(w.some((p) => p.name === "Old Timer"));
  const b = (await api("GET", `/clubs/${bears.id}`)).body;
  assert.equal(b.players.find((p) => p.player_id === S.fin).skater.goals, 1);

  const list = (await api("GET", "/clubs")).body.find((c) => c.id === wolves.id);
  assert.equal(list.record.gp, 2);
  assert.equal(list.record.w + list.record.l + list.record.otl + list.record.t, 2);

  // Draft tournaments don't make clubs; a placeholder name doesn't either.
  assert.equal((await db.many("SELECT * FROM clubs WHERE name IN ('Red', 'Blue', 'Green', 'Gold')")).length, 0);
  const t3 = (await api("POST", "/tournaments", { name: "New Team Cup", num_teams: 2, format: "team" })).body;
  const ph = (await api("GET", `/tournaments/${t3.id}`)).body.teams;
  assert.ok(ph.every((t) => t.club_id === null), "\"Team 1\" isn't a real team yet");
  // Renaming it to a known team links it.
  await api("PATCH", `/teams/${ph[0].id}`, { name: "Bears" });
  assert.equal((await api("GET", `/tournaments/${t3.id}`)).body.teams.find((t) => t.id === ph[0].id).club_id, bears.id);
  // Switching a tournament to draft unlinks its teams.
  await api("PATCH", `/tournaments/${t3.id}`, { format: "draft" });
  assert.ok((await api("GET", `/tournaments/${t3.id}`)).body.teams.every((t) => t.club_id === null));
  void t1;
  void t2;
});

test("imported players without email are matched to registered players", async () => {
  // History file: names only.
  const imp = await api("POST", "/import/historical", {
    city: "Troy", series: "Outlaw", year: 2022,
    csv: "first_name,last_name,season,team_name,gp,goals,assists\nMike,Hart,2022,Red,8,6,2\nSam,Lowe,2022,Blue,8,1,1\nJ,Quinn,2022,Blue,8,2,0\n",
  });
  assert.equal(imp.status, 200);
  const mike = (await db.one("SELECT id FROM players WHERE first_name = 'Mike' AND last_name = 'Hart'")).id;
  // Registration for a new tournament, with an email and the full first name.
  const t = (await api("POST", "/tournaments", { name: "Fall 2026", num_teams: 2 })).body;
  const reg = await api("POST", `/tournaments/${t.id}/registrations`, { first_name: "Michael", last_name: "Hart", email: "mhart@example.com" });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const regs = (await api("GET", `/tournaments/${t.id}/registrations`)).body;
  const r = regs.find((x) => x.last_name === "Hart");
  assert.equal(r.needs_review, true, "flagged: may be the imported Mike Hart");
  assert.match(r.review_note, /Mike Hart/);

  const sug = (await api("GET", "/admin/identity/suggestions")).body;
  const pair = sug.find((s) => s.without_email.id === mike);
  assert.ok(pair, JSON.stringify(sug));
  assert.equal(pair.match, "nickname");
  assert.equal(pair.with_email.email, "mhart@example.com");
  assert.equal(pair.without_email.history_lines, 1);
  // Public can't see this.
  assert.equal((await api("GET", "/admin/identity/suggestions", undefined, null)).status, 401);

  // Same person: merge into the registered player; the history follows.
  const keep = pair.with_email.id;
  assert.equal((await api("POST", `/players/${keep}/merge`, { from_player_id: mike })).status, 200);
  const dir = (await api("GET", "/history/players?q=hart")).body;
  assert.equal(dir.length, 1);
  assert.equal(dir[0].skater.goals, 6);
  assert.ok(!(await api("GET", "/admin/identity/suggestions")).body.some((s) => s.without_email.id === mike));

  // Different people: dismissed once, never suggested again.
  const sam = (await db.one("SELECT id FROM players WHERE first_name = 'Sam' AND last_name = 'Lowe'")).id;
  const samuel = await player("Samuel", "Lowe", "slowe@example.com");
  assert.ok((await api("GET", "/admin/identity/suggestions")).body.some((s) => s.without_email.id === sam && s.with_email.id === samuel));
  assert.equal((await api("POST", "/admin/identity/dismiss", { player_a: samuel, player_b: sam })).status, 204);
  assert.ok(!(await api("GET", "/admin/identity/suggestions")).body.some((s) => s.without_email.id === sam && s.with_email.id === samuel));
});

test("emails can be attached to imported players in bulk", async () => {
  const quinn = await db.one("SELECT id, player_code FROM players WHERE last_name = 'Quinn'");
  const lowe = await db.one("SELECT player_code FROM players WHERE first_name = 'Sam' AND last_name = 'Lowe'");
  const csv = `player_code,email\n${quinn.player_code},jq@example.com\n${lowe.player_code},slowe@example.com\nBLP-999999,x@example.com\n`;
  const dry = (await api("POST", "/admin/identity/emails", { csv, dry_run: true })).body;
  assert.equal(dry.linked, 1);
  assert.equal((await db.one("SELECT email FROM players WHERE id = $1", [quinn.id])).email, null, "dry run changes nothing");
  const r = (await api("POST", "/admin/identity/emails", { csv })).body;
  assert.equal(r.linked, 1);
  assert.equal(r.merge_suggested.length, 1, "slowe@ belongs to Samuel Lowe: offered as a merge, not overwritten");
  assert.match(r.merge_suggested[0].keep, /Samuel Lowe/);
  assert.equal(r.errors.length, 1);
  assert.equal((await db.one("SELECT email FROM players WHERE id = $1", [quinn.id])).email, "jq@example.com");
  // By name works when it's unambiguous.
  const byName = (await api("POST", "/admin/identity/emails", { rows: [{ name: "Old Timer", email: "old@example.com" }] })).body;
  assert.equal(byName.linked, 1);
  // Admin only.
  assert.equal((await api("POST", "/admin/identity/emails", { csv }, null)).status, 401);
});

test("an upload names its tournament (city, type, year): its own stats page, counted once, never twice", async () => {
  const csv = [
    "first_name,last_name,email,team,position,gp,g,a,pim",
    "Zed,Imported,zed@example.com,Hawks,C,4,5,2,2",
    "Yul,Imported,,Hawks,D,4,1,3,4",
    "Xia,Imported,,Owls,LW,4,2,2,0",
    "Wes,Goalie,,Owls,G,4,0,0,0",
  ].join("\n");
  const id = { city: "Buffalo", series: "dex", year: 2021 };
  // The Tournament ID is required, and the type must be one of the organization's.
  assert.equal((await api("POST", "/import/historical", { csv })).status, 400);
  assert.equal((await api("POST", "/import/historical", { csv, ...id, city: "" })).status, 400);
  assert.match((await api("POST", "/import/historical", { csv, ...id, series: "Classic" })).body.error, /DEX, Bash, Outlaw/);
  assert.equal((await api("POST", "/import/historical", { csv, ...id, year: 21 })).status, 400);

  const dry = (await api("POST", "/import/historical", { csv, ...id, dry_run: true })).body;
  assert.equal(dry.tournament.code, "BUFFALO-DEX-2021");
  assert.equal(dry.tournament.created, true);
  assert.equal((await db.many("SELECT 1 FROM tournaments WHERE code = 'BUFFALO-DEX-2021'")).length, 0, "dry run creates nothing");
  const r = (await api("POST", "/import/historical", { csv, ...id })).body;
  assert.equal(r.committed, true, JSON.stringify(r));
  const tid = r.tournament.id;
  const t = (await api("GET", `/tournaments/${tid}`)).body;
  assert.equal(t.code, "BUFFALO-DEX-2021");
  assert.equal(t.name, "Buffalo DEX 2021");
  assert.equal(t.imported, true);
  assert.equal(t.status, "completed");
  assert.deepEqual(t.teams.map((x) => x.name).sort(), ["Hawks", "Owls"]);
  const sk = (await api("GET", `/tournaments/${tid}/stats/skaters`)).body;
  const zed = sk.find((x) => x.first_name === "Zed");
  assert.equal(zed.goals, 5);
  assert.equal(zed.team, "Hawks");
  const teams = (await api("GET", `/tournaments/${tid}/teams`)).body;
  assert.deepEqual(teams.find((x) => x.name === "Owls").roster.map((p) => p.first_name).sort(), ["Wes", "Xia"]);

  // The same tournament again is refused, so nothing is counted twice…
  const again = await api("POST", "/import/historical", { csv, city: "buffalo", series: "DEX", year: 2021 });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /BUFFALO-DEX-2021 were already uploaded/);
  assert.equal(again.body.details.duplicate, true);
  const dir = (await api("GET", "/history/players?q=zed")).body;
  assert.equal(dir[0].skater.goals, 5);
  assert.equal(dir[0].events, 1);
  // …unless replacing the earlier upload on purpose (e.g. a corrected file).
  const fixed = csv.replace("Zed,Imported,zed@example.com,Hawks,C,4,5,2,2", "Zed,Imported,zed@example.com,Hawks,C,4,6,2,2");
  const rep = (await api("POST", "/import/historical", { csv: fixed, ...id, replace: true })).body;
  assert.equal(rep.tournament.replaced, true);
  assert.equal(rep.tournament.id, tid);
  assert.equal((await api("GET", "/history/players?q=zed")).body[0].skater.goals, 6, "replaced, not added");
  const career = (await api("GET", `/players/${zed.player_id}/career`)).body;
  assert.equal(career.history.length, 0, "not listed twice");
  assert.equal(career.tournaments.length, 1);
  assert.equal(career.career.skater.goals, 6);

  // Undoing the upload removes the tournament it created.
  assert.equal((await api("DELETE", `/import/batches/${encodeURIComponent(rep.batch)}`)).status, 200);
  assert.equal((await api("GET", `/tournaments/${tid}`)).status, 404);

  // A tournament set up in BLST with the same city, type and year gets the stats…
  const shell = (await api("POST", "/tournaments", { name: "Lake Effect Cup", location: "Buffalo", series: "DEX", year: 2022, num_teams: 2, team_names: ["Hawks", "Owls"] })).body;
  assert.equal(shell.code, "BUFFALO-DEX-2022");
  const r2 = (await api("POST", "/import/historical", { csv, city: "Buffalo", series: "DEX", year: 2022 })).body;
  assert.equal(r2.tournament.id, shell.id);
  assert.equal(r2.tournament.created, false);
  assert.equal((await api("GET", `/tournaments/${shell.id}`)).body.teams.length, 2, "existing teams reused by name");
  assert.equal((await api("POST", "/import/historical", { csv, tournament_id: shell.id })).status, 409, "by id too");
  // …and two tournaments can't share an ID.
  assert.equal((await api("POST", "/tournaments", { name: "Other", location: "Buffalo", series: "DEX", year: 2022, num_teams: 2 })).status, 409);
});

test("games have officials of record, any number of each", async () => {
  const t = (await api("POST", "/tournaments", { name: "Officials Cup", num_teams: 2, team_names: ["A Team", "B Team"] })).body;
  const ts = (await api("GET", `/tournaments/${t.id}`)).body.teams;
  const g = (await api("POST", `/tournaments/${t.id}/games`, { home_team_id: ts[0].id, away_team_id: ts[1].id })).body;
  const list = [{ role: "referee", name: "Ref One" }, { role: "referee", name: "Ref Two" }, { role: "linesperson", name: "Lin" },
    { role: "scorekeeper", name: "Sco One" }, { role: "scorekeeper", name: "Sco Two" }, { role: "referee", name: "  " }];
  const put = await api("PUT", `/games/${g.id}/officials`, { officials: list });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.length, 5, "blank names are dropped");
  assert.deepEqual((await api("GET", `/games/${g.id}/officials`, undefined, null)).body.map((o) => o.name), ["Ref One", "Ref Two", "Lin", "Sco One", "Sco Two"]);
  assert.equal((await api("GET", `/games/${g.id}`)).body.officials.length, 5, "in the live game snapshot");
  assert.equal((await api("PUT", `/games/${g.id}/officials`, { officials: [{ role: "coach", name: "X" }] })).status, 400);
  assert.equal((await api("PUT", `/games/${g.id}/officials`, { officials: [] }, null)).status, 401);
  assert.equal((await api("PUT", `/games/${g.id}/officials`, { officials: [] })).body.length, 0, "cleared");
});

test("new tournaments: team names in order, and the tournament type", async () => {
  const t = (await api("POST", "/tournaments", { name: "Typed Cup", num_teams: 4, format: "team", team_names: ["North Stars", "Team 2", "Seals", "Team 4"] })).body;
  assert.equal(t.format, "team");
  const teams = (await api("GET", `/tournaments/${t.id}`)).body.teams;
  assert.deepEqual(teams.map((x) => x.name), ["North Stars", "Team 2", "Seals", "Team 4"]);
  assert.ok(teams.find((x) => x.name === "North Stars").club_id, "a team tournament's named teams carry over");
  assert.equal(teams.find((x) => x.name === "Team 2").club_id, null);
});

test("the upload form can check a Tournament ID first; organizations set their own tournament types", async () => {
  const fresh = (await api("GET", "/import/tournament-id?city=Rochester&series=bash&year=2020")).body;
  assert.deepEqual(fresh, { code: "ROCHESTER-BASH-2020", tournament: null });
  const taken = (await api("GET", "/import/tournament-id?city=Buffalo&series=DEX&year=2022")).body;
  assert.equal(taken.tournament.name, "Lake Effect Cup");
  assert.ok(taken.tournament.uploaded_rows > 0);
  assert.equal((await api("GET", "/import/tournament-id?city=Buffalo&series=DEX&year=2022", undefined, null)).status, 401);
  assert.deepEqual((await api("GET", "/org")).body.org.tournament_types, ["DEX", "Bash", "Outlaw"]);
  assert.deepEqual((await api("PUT", "/admin/tournament-types", { types: ["DEX", "Bash", "Outlaw", " Classic ", "Bash"] })).body.types, ["DEX", "Bash", "Outlaw", "Classic"]);
  assert.equal((await api("GET", "/import/tournament-id?city=Rochester&series=classic&year=2020")).body.code, "ROCHESTER-CLASSIC-2020");
  assert.equal((await api("PUT", "/admin/tournament-types", { types: ["X"] }, null)).status, 401);
});

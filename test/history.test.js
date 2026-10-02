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
  const imp = await api("POST", "/import/historical", { csv: "first_name,last_name,season,event_name,team_name,gp,goals,assists\nAnn,Draft,2023,Spring Draft,Orange,6,4,5\n" });
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
  assert.deepEqual(career.tournaments.map((l) => l.roster.team_name), ["Red", "Gold"]);
});

test("team tournaments: teams carry over, with their record and their players' stats", async () => {
  S.eve = await player("Eve", "Wolf", "eve@example.com");
  S.fin = await player("Fin", "Wolf", "fin@example.com");
  S.gus = await player("Gus", "Bear", "gus@example.com");
  // A history file from before BLST, with team names.
  const imp = await api("POST", "/import/historical", {
    club_teams: true,
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
  assert.equal(merged.seasons.filter((s) => s.kind === "tournament").length, 2);
  assert.ok(merged.seasons.some((s) => s.kind === "imported" && s.season === "2024"), "imported season shows too");

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

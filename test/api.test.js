const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startApp, startMockFactions, startWebhookReceiver, waitFor } = require("./helpers");

let ctx;
let api;
let factionsMock;
let hookReceiver;

test.before(async () => {
  ctx = await startApp();
  api = ctx.api;
  factionsMock = await startMockFactions();
  hookReceiver = await startWebhookReceiver();
  const config = require("../src/config");
  config.factions.baseUrl = factionsMock.base;
  config.factions.adminToken = factionsMock.token;
});

test.after(async () => {
  require("../src/services/gameControl").disarmAll();
  ctx.server.close();
  factionsMock.server.close();
  hookReceiver.server.close();
  await require("../src/db").close();
});

const S = {}; // shared state across the ordered subtests below

test("auth: reads are public, writes need a key, roles are enforced", async () => {
  assert.equal((await api("GET", "/tournaments", undefined, null)).status, 200);
  assert.equal((await api("POST", "/tournaments", { name: "x" }, null)).status, 401);
  assert.equal((await api("POST", "/tournaments", { name: "x" }, "wrong")).status, 401);

  const sk = await api("POST", "/admin/api-keys", { name: "rink 1", role: "scorekeeper" });
  assert.equal(sk.status, 201);
  assert.match(sk.body.key, /^blst_/);
  S.scorekeeperKey = sk.body.key;
  assert.equal((await api("GET", "/me", undefined, S.scorekeeperKey)).body.role, "scorekeeper");
  assert.equal((await api("POST", "/tournaments", { name: "x" }, S.scorekeeperKey)).status, 403);

  const hook = await api("POST", "/admin/webhooks", { name: "test", url: hookReceiver.url, events: ["game.*", "roster.moved"] });
  assert.equal(hook.status, 201);
  S.hookSecret = hook.body.secret;
});

test("tournament setup with a team-count selector", async () => {
  const t = await api("POST", "/tournaments", {
    name: "BLPA Fall Classic", season: "2026", num_teams: 3, period_length_min: 15, ot_length_min: 5,
    start_date: "2026-10-10", end_date: "2026-10-11", team_names: ["Wolves", "Bears"],
  });
  assert.equal(t.status, 201);
  S.tid = t.body.id;
  let detail = await api("GET", `/tournaments/${S.tid}`);
  assert.deepEqual(detail.body.teams.map((x) => x.name), ["Wolves", "Bears", "Team 3"]);

  assert.equal((await api("PATCH", `/tournaments/${S.tid}`, { num_teams: 4 })).status, 200);
  detail = await api("GET", `/tournaments/${S.tid}`);
  assert.equal(detail.body.teams.length, 4);
  assert.equal((await api("PATCH", `/tournaments/${S.tid}`, { num_teams: 2 })).status, 200);
  detail = await api("GET", `/tournaments/${S.tid}`);
  assert.equal(detail.body.num_teams, 2);
  assert.deepEqual(detail.body.teams.map((x) => x.name), ["Wolves", "Bears"]);
  [S.home, S.away] = detail.body.teams.map((x) => x.id);
  assert.equal((await api("PATCH", `/teams/${S.away}`, { short_name: "BRS", color: "#8B4513" })).status, 200);
});

test("roster import creates players and assigns numbers", async () => {
  const csv = [
    "First Name,Last Name,#,Pos,Team,Email",
    "Gina,Goalie,30,G,Wolves,gina@example.com",
    "Sam,Sniper,9,C,Wolves,sam@example.com",
    "Dee,Dman,4,D,Wolves,dee@example.com",
    "Wes,Wing,17,LW,Wolves,",
    "Bob,Backstop,1,G,Bears,bob@example.com",
    "Carl,Center,19,C,Bears,carl@example.com",
    "Ray,Rover,22,RW,Bears,",
    "Oops,Nobody,5,C,Nonexistent Team,",
  ].join("\n");
  const dry = await api("POST", `/import/roster/${S.tid}`, { csv, dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.errors.length, 1);
  assert.equal(dry.body.committed, false);

  const strict = await api("POST", `/import/roster/${S.tid}`, { csv });
  assert.equal(strict.status, 422, "a bad row aborts the whole import by default");

  const ok = await api("POST", `/import/roster/${S.tid}`, { csv, skip_errors: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.imported, 7);
  assert.equal(ok.body.created_players, 7);

  const teams = (await api("GET", `/tournaments/${S.tid}/teams`)).body;
  const byName = {};
  for (const team of teams) for (const r of team.roster) byName[r.first_name] = r;
  S.p = Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, v.id]));
  assert.equal(byName.Sam.jersey_number, 9);
  assert.equal(byName.Gina.position, "G");
  assert.equal(byName.Sam.email, undefined, "public roster never includes email");

  const dup = await api("POST", `/tournaments/${S.tid}/roster`, { player_id: S.p.Wes, team_id: S.away });
  assert.equal(dup.status, 409, "one team per player per tournament");
  const taken = await api("PATCH", `/roster/${byName.Wes.roster_entry_id}`, { jersey_number: 9 });
  assert.equal(taken.status, 409, "numbers are unique within a team");
});

test("players: private fields only for admins", async () => {
  const pub = await api("GET", `/players/${S.p.Sam}`, undefined, null);
  assert.equal(pub.body.email, undefined);
  const priv = await api("GET", `/players/${S.p.Sam}`);
  assert.equal(priv.body.email, "sam@example.com");
  const search = await api("GET", "/players?q=snip", undefined, null);
  assert.equal(search.body.length, 1);
});

test("live game: clock, events, penalties, goalie pull, final", async () => {
  const g = await api("POST", `/tournaments/${S.tid}/games`, { home_team_id: S.home, away_team_id: S.away, scheduled_at: "2026-10-10T18:00:00Z" });
  assert.equal(g.status, 201);
  S.gid = g.body.id;
  const sk = (method, path, body) => api(method, `/games/${S.gid}${path}`, body, S.scorekeeperKey);

  assert.equal((await sk("POST", "/events", { type: "shot", team_id: S.home })).status, 409, "not started");
  let snap = (await sk("POST", "/start", {})).body;
  assert.equal(snap.game.status, "live");
  assert.equal(snap.home.goalie.id, S.p.Gina, "starting goalie picked from lineup");
  assert.equal(snap.away.goalie.id, S.p.Bob);
  assert.equal(snap.game.clock_remaining_ms, 15 * 60 * 1000);

  snap = (await sk("POST", "/clock", { action: "start" })).body;
  assert.equal(snap.game.clock_running, true);
  snap = (await sk("POST", "/clock", { action: "stop" })).body;
  assert.equal(snap.game.clock_running, false);
  snap = (await sk("POST", "/clock", { action: "set", remaining_sec: 600 })).body;
  assert.equal(snap.game.clock_remaining_ms, 600000);

  // Shot, penalty, then a PP goal, each stamped from the stopped clock.
  let r = await sk("POST", "/events", { type: "shot", player_id: S.p.Sam });
  assert.equal(r.status, 201);
  assert.equal(r.body.event.team_id, S.home, "team inferred from lineup");
  assert.equal(r.body.event.goalie_id, S.p.Bob, "goalie inferred from goalie in net");
  assert.equal(r.body.event.elapsed_sec, 300);

  r = await sk("POST", "/events", { type: "penalty", player_id: S.p.Carl, infraction: "Hooking" });
  assert.equal(r.body.event.penalty_minutes, 2);
  assert.equal(r.body.event.elapsed_sec, 300);
  assert.equal(r.body.snapshot.active_penalties.length, 1);
  assert.equal(r.body.snapshot.away.skaters_on_ice, 4);

  await sk("POST", "/clock", { action: "adjust", delta_sec: -30 });
  r = await sk("POST", "/events", { type: "goal", player_id: S.p.Sam, assist1_id: S.p.Dee });
  assert.equal(r.body.event.elapsed_sec, 330);
  assert.equal(r.status, 201);
  snap = r.body.snapshot;
  assert.equal(snap.home.score, 1);
  assert.equal(snap.events.find((e) => e.type === "goal").strength, "PP");
  assert.equal(snap.active_penalties.length, 0, "PP goal released the minor");

  // A mistaken goal gets voided, then another recorded and corrected.
  await sk("POST", "/clock", { action: "set", remaining_sec: 300 });
  r = await sk("POST", "/events", { type: "goal", player_id: S.p.Wes, clock: "8:00" });
  assert.equal(r.body.snapshot.home.score, 2);
  r = await sk("DELETE", `/events/${r.body.event.id}`);
  assert.equal(r.body.snapshot.home.score, 1);

  r = await sk("POST", "/events", { type: "goal", team_id: S.away, player_id: S.p.Ray, clock: "5:00",
    on_ice_home: [S.p.Sam, S.p.Dee], on_ice_away: [S.p.Ray, S.p.Carl] });
  const awayGoal = r.body.event.id;
  r = await sk("PATCH", `/events/${awayGoal}`, { assist1_id: S.p.Carl });
  assert.equal(r.status, 200);
  assert.equal(r.body.event.assist1_id, S.p.Carl);
  assert.equal(r.body.event.elapsed_sec, 600, "edit keeps the original time");

  snap = (await sk("POST", "/period/end")).body;
  assert.equal(snap.game.status, "intermission");
  snap = (await sk("POST", "/period/next")).body;
  assert.equal(snap.game.period, 2);
  await sk("POST", "/period/next");
  snap = (await sk("POST", "/clock", { action: "set", remaining_sec: 60 })).body;
  assert.equal(snap.game.period, 3);

  // Bears pull their goalie; Wolves score into the empty net.
  r = await sk("POST", "/goalie", { team_id: S.away, goalie_id: null });
  assert.equal(r.status, 201);
  r = await sk("POST", "/events", { type: "goal", player_id: S.p.Sam, clock: "0:30" });
  assert.equal(r.body.event.empty_net, true);
  assert.equal(r.body.event.goalie_id, null);

  r = await api("POST", `/games/${S.gid}/end`, {}, S.scorekeeperKey);
  assert.equal(r.status, 200);
  snap = r.body;
  assert.equal(snap.game.status, "final");
  assert.equal(snap.game.decision, "REG");
  assert.equal(snap.home.score, 2);
  assert.equal(snap.away.score, 1);

  const sam = snap.box.skaters.find((s) => s.player_id === S.p.Sam);
  assert.equal(sam.goals, 2);
  assert.equal(sam.ppg, 1);
  assert.equal(sam.gwg, 1);
  assert.equal(sam.plus_minus, -1);
  const bob = snap.box.goalies.find((x) => x.player_id === S.p.Bob);
  assert.equal(bob.shots_against, 2);
  assert.equal(bob.goals_against, 1);
  assert.equal(bob.losses, 1);
  const gina = snap.box.goalies.find((x) => x.player_id === S.p.Gina);
  assert.equal(gina.wins, 1);

  const list = (await api("GET", `/tournaments/${S.tid}/games`)).body;
  assert.equal(list[0].home_score, 2, "cached score updated");
});

test("tied games need OT unless ties are allowed", async () => {
  const g = await api("POST", `/tournaments/${S.tid}/games`, { home_team_id: S.away, away_team_id: S.home });
  S.gid2 = g.body.id;
  await api("POST", `/games/${S.gid2}/start`, {});
  assert.equal((await api("POST", `/games/${S.gid2}/end`, {})).status, 409);
  await api("POST", `/games/${S.gid2}/period/next`);
  await api("POST", `/games/${S.gid2}/period/next`);
  await api("POST", `/games/${S.gid2}/period/next`);
  await api("POST", `/games/${S.gid2}/clock`, { action: "set", remaining_sec: 200 });
  const r = await api("POST", `/games/${S.gid2}/events`, { type: "goal", player_id: S.p.Carl });
  assert.equal(r.status, 201);
  const end = await api("POST", `/games/${S.gid2}/end`, {});
  assert.equal(end.body.game.decision, "OT");
  assert.equal(end.body.game.period_label, "OT");
});

test("standings, stats and leaders", async () => {
  const standings = (await api("GET", `/tournaments/${S.tid}/standings`, undefined, null)).body;
  const wolves = standings.find((s) => s.team_id === S.home);
  const bears = standings.find((s) => s.team_id === S.away);
  assert.deepEqual([wolves.w, wolves.l, wolves.otl, wolves.pts], [1, 0, 1, 3]);
  assert.deepEqual([bears.w, bears.l, bears.otl, bears.pts], [1, 1, 0, 2]);
  assert.equal(standings[0].team_id, S.home);

  const skaters = (await api("GET", `/tournaments/${S.tid}/stats/skaters`)).body;
  const sam = skaters.find((s) => s.player_id === S.p.Sam);
  assert.equal(sam.gp, 2);
  assert.equal(sam.points, 2);
  assert.equal(skaters[0].player_id, S.p.Sam, "sorted by points");
  const goalies = (await api("GET", `/tournaments/${S.tid}/stats/goalies`)).body;
  assert.ok(goalies.find((g) => g.player_id === S.p.Gina).gaa > 0);

  const leaders = (await api("GET", `/tournaments/${S.tid}/leaders?limit=3`)).body;
  assert.equal(leaders.goals[0].player_id, S.p.Sam);
});

test("moving a player keeps earlier stats with the old team", async () => {
  const r = await api("POST", `/tournaments/${S.tid}/roster/move`, { player_id: S.p.Wes, to_team_id: S.away, jersey_number: 71, reason: "balance teams" });
  assert.equal(r.status, 200);
  assert.equal(r.body.entry.team_id, S.away);
  const moves = (await api("GET", `/tournaments/${S.tid}/roster/moves`)).body;
  assert.equal(moves[0].to_team, "Bears");

  const g = await api("POST", `/tournaments/${S.tid}/games`, { home_team_id: S.home, away_team_id: S.away });
  S.gid3 = g.body.id;
  const snap = (await api("GET", `/games/${S.gid3}`)).body;
  assert.ok(snap.lineups.away.some((p) => p.player_id === S.p.Wes && p.number === 71), "new team's lineup");
  const old = (await api("GET", `/games/${S.gid}`)).body;
  assert.ok(old.lineups.home.some((p) => p.player_id === S.p.Wes), "old game lineup unchanged");
});

test("historical import and career totals", async () => {
  const csv = "Player,Season,Team,GP,G,A,PIM,+/-\nSam Sniper,2025,Old Wolves,10,8,6,4,5\nSniper, Sam,2024,Old Wolves,x,1,1,0,0\n";
  const bad = await api("POST", "/import/historical", { csv });
  assert.equal(bad.status, 422);
  const good = await api("POST", "/import/historical", {
    rows: [
      { name: "Sam Sniper", season: "2025", team: "Old Wolves", GP: 10, G: 8, A: 6, PIM: 4, "+/-": 5 },
      { first_name: "Bob", last_name: "Backstop", position: "G", season: "2025", GP: 5, W: 3, L: 2, SA: 150, GA: 12, SO: 1, MIN: "250:00" },
      { name: "New Historical", season: "2023", GP: 3, G: 1 },
    ],
    source: "old-league-site",
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.imported, 3);
  assert.equal(good.body.created_players, 1);

  const career = (await api("GET", `/players/${S.p.Sam}/career`)).body;
  assert.equal(career.history.length, 1);
  assert.equal(career.career.skater.goals, 10, "8 historical + 2 live");
  assert.equal(career.career.skater.gp, 12);
  const bob = (await api("GET", `/players/${S.p.Bob}/career`)).body;
  assert.equal(bob.career.goalie.gp, 7, "5 imported goalie games + 2 live");
  assert.equal(bob.history[0].toi_sec, 15000);

  const batches = (await api("GET", "/import/batches")).body;
  assert.equal(batches.length, 1);
});

test("export API: JSON and CSV", async () => {
  const full = await api("GET", `/export/tournaments/${S.tid}`, undefined, null);
  assert.equal(full.status, 200);
  assert.equal(full.body.schema_version, 1);
  assert.equal(full.body.teams.length, 2);
  assert.ok(full.body.skaters.length > 0);
  assert.ok(!JSON.stringify(full.body).includes("@example.com"), "no emails in exports");

  const csv = await api("GET", `/export/tournaments/${S.tid}/skaters?format=csv`, undefined, null);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.body, /^player_id,name,/);
  assert.match(csv.body, /Sam Sniper/);

  const game = await api("GET", `/export/games/${S.gid}?format=csv`, undefined, null);
  assert.match(game.body, /goal/);
  const player = await api("GET", `/export/players/${S.p.Sam}`, undefined, null);
  assert.equal(player.body.career.skater.goals, 10);
});

test("webhooks are signed and delivered", async () => {
  const final = await waitFor(() => hookReceiver.received.find((d) => d.body.event === "game.final"));
  const { headers, raw } = final;
  const expected = `sha256=${crypto.createHmac("sha256", S.hookSecret).update(`${headers["x-blst-timestamp"]}.${raw}`).digest("hex")}`;
  assert.equal(headers["x-blst-signature"], expected);
  assert.equal(final.body.data.home_score, 2);
  assert.ok(hookReceiver.received.some((d) => d.body.event === "roster.moved"));
  assert.ok(!hookReceiver.received.some((d) => d.body.event === "player.created"), "filtered by subscription");
});

test("BLPA Factions: link, sync players, push participation and achievements", async () => {
  const link = await api("POST", `/tournaments/${S.tid}/factions/link`, {});
  assert.equal(link.status, 200);
  assert.equal(link.body.created, true);
  const eventId = link.body.factions_event_id;
  assert.equal(factionsMock.state.events.get(eventId).name, "BLPA Fall Classic");
  assert.equal(factionsMock.state.events.get(eventId).startDate, "2026-10-10T00:00:00.000Z");

  const sync = await api("POST", `/tournaments/${S.tid}/factions/sync-players`);
  assert.equal(sync.body.synced, 5);
  assert.equal(sync.body.skipped_no_email.length, 2, "Wes and Ray have no email");
  const sam = (await api("GET", `/players/${S.p.Sam}`)).body;
  assert.equal(sam.factions_player_id, Buffer.from("sam@example.com").toString("base64url"));
  assert.ok(sam.factions_order);
  const pubSam = (await api("GET", `/players/${S.p.Sam}`, undefined, null)).body;
  assert.equal(pubSam.factions_player_id, undefined, "Factions id is PII");
  assert.equal(pubSam.factions_order, sam.factions_order, "Order is public");

  await api("PATCH", `/teams/${S.home}`, { final_placement: 1 });
  const preview = (await api("GET", `/tournaments/${S.tid}/factions/preview`)).body;
  const samLine = preview.participation.find((p) => p.player_id === S.p.Sam);
  // 2 GP + 2 goals*2 + 1 win + champion 5 = 12
  assert.equal(samLine.points_earned, 12);
  assert.equal(samLine.placement, 1);

  const push = await api("POST", `/tournaments/${S.tid}/factions/push`);
  assert.equal(push.status, 200);
  assert.equal(push.body.errors.length, 0);
  assert.ok(push.body.pushed >= 5);
  const rec = factionsMock.state.participation.get(`${eventId}:${sam.factions_player_id}`);
  assert.equal(rec.pointsEarned, 12);
  assert.ok(factionsMock.state.achievements.has(`${sam.factions_player_id}:blst:t${S.tid}:champion`));

  // Pushing again is idempotent (upserts).
  await api("POST", `/tournaments/${S.tid}/factions/push`);
  assert.equal(factionsMock.state.participation.get(`${eventId}:${sam.factions_player_id}`).pointsEarned, 12);

  const totals = await api("GET", `/tournaments/${S.tid}/factions/order-totals`, undefined, null);
  assert.equal(totals.status, 200);
  assert.equal(totals.body.length, 6);
});

test("SSE stream pushes snapshots to viewers", async () => {
  const ac = new AbortController();
  const res = await fetch(`${ctx.base}/api/v1/stream?game_id=${S.gid3}`, { signal: ac.signal });
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readUntil = async (pred) => {
    while (!pred(buf)) {
      const { value } = await reader.read();
      buf += decoder.decode(value);
    }
  };
  await readUntil((b) => b.includes("event: snapshot"));
  buf = "";
  await api("POST", `/games/${S.gid3}/start`, {});
  await readUntil((b) => b.includes('"status":"live"'));
  ac.abort();
});

test("validation errors are 4xx, not 500", async () => {
  assert.equal((await api("POST", "/tournaments", { name: "Bad", num_teams: 1 })).status, 400);
  assert.equal((await api("POST", `/games/${S.gid3}/events`, { type: "bogus" })).status, 400);
  assert.equal((await api("POST", `/games/${S.gid3}/events`, { type: "goal", team_id: 999999 })).status, 400);
  assert.equal((await api("POST", `/games/${S.gid3}/events`, { type: "goal", player_id: S.p.Sam, assist1_id: S.p.Sam })).status, 400);
  assert.equal((await api("GET", "/games/abc")).status, 400);
  assert.equal((await api("GET", "/games/999999")).status, 404);
  assert.equal((await api("POST", "/players", { first_name: "No" })).status, 400);
});

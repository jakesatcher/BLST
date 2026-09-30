const test = require("node:test");
const assert = require("node:assert/strict");
const clock = require("../src/lib/clock");
const { simulatePenalties } = require("../src/lib/penalties");
const { computeGameStats, aggregatePlayerStats, computeStandings } = require("../src/lib/stats");
const { parseCsv, csvToObjects, toCsv } = require("../src/lib/csv");

const T = { id: 1, periods: 3, period_length_sec: 1200, ot_length_sec: 300, skaters_per_side: 5, allow_ties: false,
  points_win: 2, points_otl: 1, points_tie: 1 };
const HOME = 10;
const AWAY = 20;

// Home: 1 G, 2 D, 3-6 F. Away: 11 G, 12 G(backup), 13-16 skaters.
const roster = [
  { player_id: 1, team_id: HOME, position: "G", dressed: true },
  ...[2, 3, 4, 5, 6].map((id) => ({ player_id: id, team_id: HOME, position: "F", dressed: true })),
  { player_id: 11, team_id: AWAY, position: "G", dressed: true },
  { player_id: 12, team_id: AWAY, position: "G", dressed: true },
  ...[13, 14, 15, 16].map((id) => ({ player_id: id, team_id: AWAY, position: "F", dressed: true })),
];

let nextId = 1;
const ev = (fields) => ({ id: nextId++, voided: false, empty_net: false, coincidental: false, ...fields });
const starters = () => [
  ev({ type: "goalie_change", team_id: HOME, period: 1, elapsed_sec: 0, goalie_id: 1 }),
  ev({ type: "goalie_change", team_id: AWAY, period: 1, elapsed_sec: 0, goalie_id: 11 }),
];
const game = (over = {}) => ({ id: 99, home_team_id: HOME, away_team_id: AWAY, status: "final", period: 3,
  final_elapsed_sec: 3600, decision: null, ...over });

test("clock math", () => {
  assert.equal(clock.periodLengthSec(T, 3), 1200);
  assert.equal(clock.periodLengthSec(T, 4), 300);
  assert.equal(clock.periodLabel(T, 2), "2nd");
  assert.equal(clock.periodLabel(T, 4), "OT");
  assert.equal(clock.periodLabel(T, 5), "2OT");
  assert.equal(clock.absSec(T, 3, 30), 2430);
  assert.equal(clock.formatClock(65), "1:05");
  const now = Date.now();
  const running = { period: 1, clock_running: true, clock_remaining_ms: 60000, clock_started_at: new Date(now - 15000) };
  assert.equal(clock.remainingMs(running, now), 45000);
  assert.equal(clock.elapsedSec(T, running, now), 1155);
  assert.equal(clock.remainingMs({ ...running, clock_started_at: new Date(now - 90000) }, now), 0);
});

test("penalty simulation: expiry, PP-goal release, stacking, coincidental", () => {
  const events = [
    ev({ type: "penalty", team_id: AWAY, period: 1, elapsed_sec: 100, player_id: 13, penalty_severity: "minor", penalty_minutes: 2 }),
    ev({ type: "goal", team_id: HOME, period: 1, elapsed_sec: 130, player_id: 3 }),
  ];
  const sim = simulatePenalties(T, HOME, AWAY, events, 200);
  assert.equal(sim.goalStrength[events[1].id], "PP");
  assert.equal(sim.penalties[0].end, 130, "minor released by PP goal");
  assert.equal(sim.active.length, 0);
  assert.equal(sim.skaters[AWAY], 5);

  // Double minor: goal in the first half ends only that half.
  const dm = [
    ev({ type: "penalty", team_id: AWAY, period: 1, elapsed_sec: 0, player_id: 13, penalty_severity: "double_minor", penalty_minutes: 4 }),
    ev({ type: "goal", team_id: HOME, period: 1, elapsed_sec: 60, player_id: 3 }),
  ];
  const s2 = simulatePenalties(T, HOME, AWAY, dm, 100);
  assert.equal(s2.penalties[0].end, 180);
  assert.equal(s2.active[0].remaining_sec, 80);

  // Third penalty queues until the first ends.
  const stack = [
    ev({ type: "penalty", team_id: HOME, period: 1, elapsed_sec: 0, player_id: 2, penalty_severity: "minor", penalty_minutes: 2 }),
    ev({ type: "penalty", team_id: HOME, period: 1, elapsed_sec: 30, player_id: 3, penalty_severity: "minor", penalty_minutes: 2 }),
    ev({ type: "penalty", team_id: HOME, period: 1, elapsed_sec: 60, player_id: 4, penalty_severity: "minor", penalty_minutes: 2 }),
  ];
  const s3 = simulatePenalties(T, HOME, AWAY, stack, 90);
  assert.equal(s3.skaters[HOME], 3, "never more than two short");
  assert.equal(s3.active.find((p) => p.player_id === 4).queued, true);
  const s3b = simulatePenalties(T, HOME, AWAY, stack, 400);
  const third = s3b.penalties.find((p) => p.player_id === 4);
  assert.equal(third.start, 120);
  assert.equal(third.end, 240);

  // Coincidental minors don't change strength.
  const co = [
    ev({ type: "penalty", team_id: HOME, period: 1, elapsed_sec: 0, player_id: 2, penalty_severity: "minor", penalty_minutes: 2, coincidental: true }),
    ev({ type: "penalty", team_id: AWAY, period: 1, elapsed_sec: 0, player_id: 13, penalty_severity: "minor", penalty_minutes: 2, coincidental: true }),
    ev({ type: "goal", team_id: HOME, period: 1, elapsed_sec: 10, player_id: 3 }),
  ];
  const s4 = simulatePenalties(T, HOME, AWAY, co, 20);
  assert.equal(s4.goalStrength[co[2].id], "EV");
  assert.equal(s4.active.length, 2, "coincidentals still on the penalty clock");

  // Penalties carry over into the next period.
  const carry = [ev({ type: "penalty", team_id: HOME, period: 1, elapsed_sec: 1150, player_id: 2, penalty_severity: "minor", penalty_minutes: 2 })];
  const s5 = simulatePenalties(T, HOME, AWAY, carry, clock.absSec(T, 2, 30));
  assert.equal(s5.active[0].remaining_sec, 40);
});

test("game stats: scoring, assists, PP/SH, +/-, GWG, goalie decisions and shutout", () => {
  const events = [
    ...starters(),
    ev({ type: "shot", team_id: HOME, period: 1, elapsed_sec: 50, player_id: 3, goalie_id: 11 }),
    ev({ type: "penalty", team_id: AWAY, period: 1, elapsed_sec: 100, player_id: 13, secondary_player_id: 4, penalty_severity: "minor", penalty_minutes: 2, infraction: "Tripping" }),
    ev({ type: "goal", team_id: HOME, period: 1, elapsed_sec: 130, player_id: 3, assist1_id: 4, assist2_id: 5, goalie_id: 11 }),
    ev({ type: "goal", team_id: HOME, period: 2, elapsed_sec: 400, player_id: 3, assist1_id: 2, goalie_id: 11,
      on_ice_home: [1, 2, 3, 4, 5, 6], on_ice_away: [11, 13, 14, 15, 16] }),
    ev({ type: "goalie_change", team_id: AWAY, period: 3, elapsed_sec: 0, goalie_id: 12 }),
    ev({ type: "shot", team_id: AWAY, period: 3, elapsed_sec: 100, player_id: 14, goalie_id: 1 }),
    ev({ type: "faceoff", team_id: HOME, period: 3, elapsed_sec: 200, player_id: 3, secondary_player_id: 14 }),
    ev({ type: "hit", team_id: AWAY, period: 3, elapsed_sec: 210, player_id: 15, secondary_player_id: 2 }),
    ev({ type: "blocked_shot", team_id: HOME, period: 3, elapsed_sec: 220, player_id: 2, secondary_player_id: 16 }),
    ev({ type: "goalie_change", team_id: AWAY, period: 3, elapsed_sec: 1140, goalie_id: null }),
    ev({ type: "goal", team_id: HOME, period: 3, elapsed_sec: 1150, player_id: 3, goalie_id: null, empty_net: true }),
    ev({ type: "goal", team_id: HOME, period: 3, elapsed_sec: 1190, player_id: 6, goalie_id: null, empty_net: true, voided: true }),
  ];
  const s = computeGameStats({ tournament: T, game: game(), roster, events });
  const line = (id) => s.skaters.find((x) => x.player_id === id);
  const g = (id) => s.goalies.find((x) => x.player_id === id);

  assert.deepEqual(s.score, { [HOME]: 3, [AWAY]: 0 });
  assert.equal(s.decision, "REG");
  assert.equal(s.winner_team_id, HOME);
  assert.equal(line(3).goals, 3);
  assert.equal(line(3).shots, 4);
  assert.equal(line(3).ppg, 1);
  assert.equal(line(3).eng, 1);
  assert.equal(line(3).gwg, 1, "first goal is the GWG in a 3-0 game");
  assert.equal(line(4).assists, 1);
  assert.equal(line(4).ppa, 1);
  assert.equal(line(4).penalties_drawn, 1);
  assert.equal(line(3).plus_minus, 1, "PP goal excluded, ES goal counted");
  assert.equal(line(14).plus_minus, -1);
  assert.equal(line(6).goals, 0, "voided goal ignored");
  assert.equal(line(13).pim, 2);
  assert.equal(line(3).fow, 1);
  assert.equal(line(14).fol, 1);
  assert.equal(line(15).hits, 1);
  assert.equal(line(2).blocks, 1);
  assert.equal(s.teams[HOME].ppg, 1);
  assert.equal(s.teams[HOME].pp_opportunities, 1);

  assert.equal(g(11).toi_sec, 2400);
  assert.equal(g(11).shots_against, 3);
  assert.equal(g(11).goals_against, 2);
  assert.equal(g(11).losses, 1, "in net for the GWG");
  assert.equal(g(12).toi_sec, 1140);
  assert.equal(g(12).goals_against, 0, "empty-net goal not charged");
  assert.equal(g(12).losses, 0);
  assert.equal(g(1).wins, 1);
  assert.equal(g(1).shutouts, 1);
  assert.equal(g(1).toi_sec, 3600);
  assert.equal(g(1).saves, 1);
});

test("overtime and shootout decisions", () => {
  const ot = [
    ...starters(),
    ev({ type: "goal", team_id: HOME, period: 1, elapsed_sec: 10, player_id: 3, goalie_id: 11 }),
    ev({ type: "goal", team_id: AWAY, period: 2, elapsed_sec: 10, player_id: 13, goalie_id: 1 }),
    ev({ type: "goal", team_id: AWAY, period: 4, elapsed_sec: 45, player_id: 14, goalie_id: 1 }),
  ];
  const s = computeGameStats({ tournament: T, game: game({ period: 4, final_elapsed_sec: 3645 }), roster, events: ot });
  assert.equal(s.decision, "OT");
  assert.equal(s.winner_team_id, AWAY);
  assert.equal(s.goalies.find((x) => x.player_id === 1).ot_losses, 1);
  assert.equal(s.skaters.find((x) => x.player_id === 14).gwg, 1);

  const so = [
    ...starters(),
    ev({ type: "goal", team_id: HOME, period: 1, elapsed_sec: 10, player_id: 3, goalie_id: 11 }),
    ev({ type: "goal", team_id: AWAY, period: 2, elapsed_sec: 10, player_id: 13, goalie_id: 1 }),
    ev({ type: "shootout_attempt", team_id: HOME, period: 5, elapsed_sec: 0, player_id: 3, goalie_id: 11, result: "goal" }),
    ev({ type: "shootout_attempt", team_id: AWAY, period: 5, elapsed_sec: 0, player_id: 13, goalie_id: 1, result: "save" }),
  ];
  const s2 = computeGameStats({ tournament: T, game: game({ period: 5, final_elapsed_sec: 3900 }), roster, events: so });
  assert.equal(s2.decision, "SO");
  assert.deepEqual(s2.score, { [HOME]: 2, [AWAY]: 1 });
  assert.equal(s2.skaters.find((x) => x.player_id === 3).goals, 1, "shootout goals aren't goals");
  assert.equal(s2.skaters.find((x) => x.player_id === 3).gwg, 0, "no GWG in a shootout");
  assert.equal(s2.goalies.find((x) => x.player_id === 1).wins, 1);
  assert.equal(s2.goalies.find((x) => x.player_id === 11).ot_losses, 1);

  const standings = computeStandings(
    T,
    [{ id: HOME, name: "Home" }, { id: AWAY, name: "Away" }],
    [{ id: 99, status: "final", game_type: "pool", home_team_id: HOME, away_team_id: AWAY }],
    [s2],
  );
  assert.equal(standings[0].team_id, HOME);
  assert.equal(standings[0].pts, 2);
  assert.equal(standings[1].otl, 1);
  assert.equal(standings[1].pts, 1);
});

test("aggregates players across games and teams", () => {
  const a = { game_id: 1, skaters: [{ player_id: 3, team_id: HOME, gp: 1, goals: 2, assists: 0, shots: 4, fow: 3, fol: 1 }], goalies: [] };
  const b = { game_id: 2, skaters: [{ player_id: 3, team_id: AWAY, gp: 1, goals: 0, assists: 1, shots: 0, fow: 0, fol: 0 }], goalies: [] };
  for (const x of [a, b]) for (const s of x.skaters) s.points = s.goals + s.assists;
  const agg = aggregatePlayerStats([a, b]);
  const p = agg.skaters[0];
  assert.equal(p.gp, 2);
  assert.equal(p.points, 3);
  assert.equal(p.shooting_pct, 0.5);
  assert.equal(p.faceoff_pct, 0.75);
  assert.equal(p.by_team.length, 2);
});

test("csv round trip", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n'), [["a", "b"], ["x, y", 'he said "hi"']]);
  assert.deepEqual(csvToObjects("Name,+/-,GP\nJo Smith,3,4\n"), [{ name: "Jo Smith", plus_minus: "3", gp: "4" }]);
  assert.equal(toCsv([{ a: 1, b: "x,y" }]), 'a,b\r\n1,"x,y"\r\n');
});

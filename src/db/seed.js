// Loads a demo tournament: 4 teams, full rosters, a round robin, two
// finished games, and one game left live in the 2nd period.
//   npm run seed            (does nothing if a "BLST Demo Cup" already exists)
//   --if-enabled            only when SEED_DEMO=true (Heroku postdeploy, Railway start)
//   --once                  never again after the first successful seed, even if
//                           the demo was deleted (Railway runs this on every start)
const db = require("./index");
const control = require("../services/gameControl");

const TEAMS = [
  ["Varghona Wolves", "WOL", "#4a6fa5"],
  ["Ursonne Bears", "BRS", "#8b4513"],
  ["Thalkara Krakens", "KRK", "#1f8a70"],
  ["Aetherwing Eagles", "EAG", "#c9a227"],
];
const FIRST = ["Alex", "Blake", "Casey", "Drew", "Evan", "Finn", "Gabe", "Hunter", "Ian", "Jordan", "Kyle", "Liam", "Mason", "Noah", "Owen", "Parker", "Quinn", "Riley", "Sam", "Tyler", "Uri", "Vince", "Wes", "Xavier"];
const LAST = ["Anderson", "Brooks", "Carter", "Dawson", "Ellis", "Foster", "Grant", "Hayes", "Irwin", "Jensen", "Keller", "Larson", "Mercer", "Nolan", "Olsen", "Pryor", "Quade", "Reyes", "Sutter", "Tanner", "Upton", "Vance", "Walsh", "Young"];
const POS = ["G", "G", "C", "C", "C", "LW", "LW", "RW", "RW", "D", "D", "D", "D"];
const NUMBERS = [30, 35, 9, 19, 91, 11, 17, 22, 27, 4, 5, 44, 77];

async function main() {
  // Heroku's postdeploy runs this with --if-enabled; only seed when SEED_DEMO=true.
  if (process.argv.includes("--if-enabled") && !/^(1|true|yes)$/i.test(process.env.SEED_DEMO || "")) {
    console.log("SEED_DEMO is not true; skipping demo data.");
    return;
  }
  await db.migrate({ log: () => {} });
  const once = process.argv.includes("--once");
  if (once && (await db.one("SELECT 1 FROM integration_settings WHERE key = 'demo_seeded'"))) {
    console.log("Demo data was already loaded once; skipping.");
    return;
  }
  const exists = await db.one("SELECT id FROM tournaments WHERE name = 'BLST Demo Cup'");
  if (exists) {
    await db.query("INSERT INTO integration_settings (key, value) VALUES ('demo_seeded', to_jsonb(now())) ON CONFLICT (key) DO NOTHING");
    console.log(`Demo tournament already exists (id ${exists.id}); nothing to do.`);
    return;
  }
  const t = await db.one(
    `INSERT INTO tournaments (name, season, location, start_date, end_date, num_teams, period_length_sec, ot_length_sec, status)
     VALUES ('BLST Demo Cup', '2026', 'Community Ice Center', CURRENT_DATE, CURRENT_DATE + 1, 4, 900, 300, 'active') RETURNING *`,
  );
  const teams = [];
  let n = 0;
  for (const [i, [name, short, color]] of TEAMS.entries()) {
    const team = await db.one("INSERT INTO teams (tournament_id, name, short_name, color, seed) VALUES ($1, $2, $3, $4, $5) RETURNING *", [t.id, name, short, color, i + 1]);
    team.players = [];
    for (const [j, pos] of POS.entries()) {
      const first = FIRST[(n * 7) % FIRST.length];
      const last = LAST[(n * 5 + i) % LAST.length];
      n++;
      const p = await db.one(
        "INSERT INTO players (first_name, last_name, email, position, shoots) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [first, `${last}`, `${first}.${last}.${n}@example.com`.toLowerCase(), pos, n % 3 ? "L" : "R"],
      );
      const number = NUMBERS[j];
      await db.query("INSERT INTO roster_entries (tournament_id, team_id, player_id, jersey_number, position, role) VALUES ($1, $2, $3, $4, $5, $6)",
        [t.id, team.id, p.id, number, pos, j === 2 ? "C" : j === 9 ? "A" : null]);
      team.players.push({ ...p, number });
    }
    teams.push(team);
  }
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() - 3);
  const pairs = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2]];
  const games = [];
  for (const [i, [a, b]] of pairs.entries()) {
    games.push(await db.one(
      "INSERT INTO games (tournament_id, home_team_id, away_team_id, scheduled_at, venue) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [t.id, teams[a].id, teams[b].id, new Date(start.getTime() + i * 75 * 60000), i % 2 ? "Rink B" : "Rink A"],
    ));
  }

  const sk = (team, k) => team.players.filter((p) => p.position !== "G")[k];
  const ev = (gameId, body) => control.createEvent(gameId, body);
  async function play(game, home, away, script, { finish = true, periods = 3 } = {}) {
    await control.startGame(game.id, {});
    for (let period = 1; period <= periods; period++) {
      if (period > 1) await control.nextPeriod(game.id);
      for (const e of script.filter((x) => x.period === period)) {
        const team = e.home ? home : away;
        const opp = e.home ? away : home;
        const body = { period, clock: e.clock, type: e.type, team_id: team.id };
        if (e.p !== undefined) body.player_id = sk(team, e.p).id;
        if (e.a1 !== undefined) body.assist1_id = sk(team, e.a1).id;
        if (e.a2 !== undefined) body.assist2_id = sk(team, e.a2).id;
        if (e.vs !== undefined) body.secondary_player_id = sk(opp, e.vs).id;
        Object.assign(body, e.extra || {});
        await ev(game.id, body);
      }
      if (period < periods || finish) await control.clockAction(game.id, { action: "set", remaining_sec: 0 });
    }
    if (finish) await control.endGame(game.id, {});
  }
  const shots = (period, home, count) =>
    Array.from({ length: count }, (_, i) => ({ period, home, type: "shot", p: (i * 3 + period) % 11, clock: `${14 - i}:${String((i * 17) % 60).padStart(2, "0")}` }));

  await play(games[0], teams[0], teams[1], [
    { period: 1, home: true, type: "faceoff", p: 0, vs: 0, clock: "15:00" },
    ...shots(1, true, 7), ...shots(1, false, 5),
    { period: 1, home: false, type: "penalty", p: 8, vs: 1, clock: "11:10", extra: { infraction: "Tripping" } },
    { period: 1, home: true, type: "goal", p: 0, a1: 3, a2: 8, clock: "10:02" },
    { period: 1, home: true, type: "hit", p: 9, vs: 2, clock: "6:40" },
    ...shots(2, true, 6), ...shots(2, false, 8),
    { period: 2, home: false, type: "goal", p: 2, a1: 5, clock: "8:12" },
    { period: 2, home: true, type: "penalty", p: 7, vs: 4, clock: "5:00", extra: { infraction: "Hooking" } },
    { period: 2, home: false, type: "blocked_shot", p: 9, vs: 1, clock: "4:10" },
    ...shots(3, true, 5), ...shots(3, false, 6),
    { period: 3, home: true, type: "goal", p: 1, a1: 0, clock: "7:45" },
    { period: 3, home: true, type: "goal", p: 0, clock: "0:40", extra: { empty_net: true, goalie_id: null } },
  ]);
  await play(games[1], teams[2], teams[3], [
    ...shots(1, true, 6), ...shots(1, false, 6),
    { period: 1, home: false, type: "goal", p: 4, a1: 2, clock: "3:21" },
    ...shots(2, true, 9), ...shots(2, false, 4),
    { period: 2, home: true, type: "goal", p: 3, a1: 1, a2: 6, clock: "12:00" },
    { period: 2, home: true, type: "goal", p: 3, a1: 2, clock: "2:30" },
    ...shots(3, true, 4), ...shots(3, false, 7),
    { period: 3, home: false, type: "penalty", p: 7, vs: 3, clock: "9:00", extra: { infraction: "Slashing", penalty_severity: "double_minor" } },
    { period: 3, home: true, type: "goal", p: 3, a1: 5, clock: "8:00" },
  ]);
  await play(games[2], teams[0], teams[2], [
    ...shots(1, true, 5), ...shots(1, false, 4),
    { period: 1, home: false, type: "goal", p: 3, a1: 2, clock: "6:30" },
    ...shots(2, true, 3),
    { period: 2, home: true, type: "penalty", p: 5, vs: 0, clock: "13:10", extra: { infraction: "Roughing" } },
  ], { finish: false, periods: 2 });
  await control.clockAction(games[2].id, { action: "set", remaining_sec: 725 });
  // Count the demo for BLPA Factions: every demo player has an email, so
  // each already has an Order; award the points from the finished games.
  const factions = require("../services/factions");
  await factions.linkTournament(t.id);
  await factions.awardResults(t.id);
  await db.query("INSERT INTO integration_settings (key, value) VALUES ('demo_seeded', to_jsonb(now())) ON CONFLICT (key) DO NOTHING");
  console.log(`Seeded "${t.name}" (tournament ${t.id}): 4 teams, ${n} players, ${games.length} games (2 final, 1 live).`);
}

// Demo data goes to SEED_ORG (default: the first organization, BLPA).
const { withOrg } = require("../lib/context");
withOrg("*", async () => {
  await db.migrate({ log: () => {} });
  return db.one("SELECT id FROM organizations WHERE slug = $1", [process.env.SEED_ORG || "blpa"]);
})
  .then((org) => (org ? withOrg(org.id, main) : main()))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    control.disarmAll();
    return db.close();
  });

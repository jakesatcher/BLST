const db = require("../db");
const { notFound } = require("../lib/http");
const clock = require("../lib/clock");
const { computeGameStats, aggregatePlayerStats, computeStandings } = require("../lib/stats");

const PUBLIC_PLAYER_COLS = "p.id, p.first_name, p.last_name, p.position, p.shoots, p.preferred_number, p.external_id, p.factions_order";

async function getTournament(id, client = db) {
  const t = await client.query("SELECT * FROM tournaments WHERE id = $1", [id]).then((r) => r.rows[0]);
  if (!t) throw notFound("tournament");
  return t;
}

async function getGame(id, client = db) {
  const g = await client.query("SELECT * FROM games WHERE id = $1", [id]).then((r) => r.rows[0]);
  if (!g) throw notFound("game");
  return g;
}

/** Everything needed to compute one game's state. */
async function loadGameBundle(gameId) {
  const game = await getGame(gameId);
  const [tournament, teams, roster, events] = await Promise.all([
    getTournament(game.tournament_id),
    db.many("SELECT * FROM teams WHERE id = ANY($1)", [[game.home_team_id, game.away_team_id]]),
    loadGameRoster(game),
    db.many("SELECT * FROM game_events WHERE game_id = $1 ORDER BY period, elapsed_sec, id", [gameId]),
  ]);
  return { tournament, game, teams, roster, events };
}

/**
 * The game's lineup. Once a game starts it has its own snapshot in
 * game_rosters; before that, fall back to the teams' current rosters so
 * the scorekeeper screen and previews still have players to show.
 */
async function loadGameRoster(game) {
  const snap = await db.many(
    `SELECT gr.player_id, gr.team_id, gr.jersey_number, COALESCE(gr.position, p.position) AS position, gr.dressed,
            p.first_name, p.last_name
       FROM game_rosters gr JOIN players p ON p.id = gr.player_id
      WHERE gr.game_id = $1
      ORDER BY gr.team_id, gr.jersey_number NULLS LAST, p.last_name`,
    [game.id],
  );
  if (snap.length || game.status !== "scheduled") return snap;
  return db.many(
    `SELECT re.player_id, re.team_id, re.jersey_number, COALESCE(re.position, p.position) AS position, TRUE AS dressed,
            p.first_name, p.last_name
       FROM roster_entries re JOIN players p ON p.id = re.player_id
      WHERE re.team_id = ANY($1)
      ORDER BY re.team_id, re.jersey_number NULLS LAST, p.last_name`,
    [[game.home_team_id, game.away_team_id]],
  );
}

function playerLabel(r) {
  if (!r) return null;
  return `${r.jersey_number != null ? `#${r.jersey_number} ` : ""}${r.first_name} ${r.last_name}`;
}

function teamPublic(team) {
  return team && { id: team.id, name: team.name, short_name: team.short_name, color: team.color };
}

/** Public live state of a game, pushed to viewers over SSE. */
function buildSnapshot(bundle, now = Date.now()) {
  const { tournament: t, game, teams, roster, events } = bundle;
  const stats = computeGameStats({ tournament: t, game, roster, events, now });
  const byId = new Map(roster.map((r) => [r.player_id, r]));
  const who = (id) => (id == null ? null : { id, name: playerLabel(byId.get(id)) || `Player ${id}`, number: byId.get(id)?.jersey_number ?? null });
  const team = (id) => teamPublic(teams.find((x) => x.id === id));
  const periodLen = clock.periodLengthSec(t, game.period);

  const side = (teamId) => ({
    ...team(teamId),
    score: stats.score[teamId],
    shootout_goals: stats.shootout[teamId],
    ...stats.teams[teamId],
    skaters_on_ice: stats.penalties.skaters[teamId],
    goalie: who(teamId === game.home_team_id ? game.home_goalie_id : game.away_goalie_id),
  });

  const decorated = events
    .filter((e) => !e.voided)
    .sort((a, b) => clock.absSec(t, a.period, a.elapsed_sec) - clock.absSec(t, b.period, b.elapsed_sec) || a.id - b.id)
    .map((e) => decorateEvent(t, e, who, stats));

  const penaltyInfo = new Map(stats.penalties.penalties.map((p) => [p.event_id, p]));
  for (const e of decorated) {
    const p = penaltyInfo.get(e.id);
    if (p) e.penalty_window = { start_abs: p.start, end_abs: p.end, queued: p.queued };
  }

  return {
    server_now: now,
    tournament: { id: t.id, name: t.name, periods: t.periods, period_length_sec: t.period_length_sec, ot_length_sec: t.ot_length_sec },
    game: {
      id: game.id,
      tournament_id: game.tournament_id,
      status: game.status,
      game_type: game.game_type,
      scheduled_at: game.scheduled_at,
      venue: game.venue,
      decision: stats.decision,
      period: game.period,
      period_label: clock.periodLabel(t, game.period),
      period_length_sec: periodLen,
      period_start_abs: clock.absSec(t, game.period, 0),
      clock_running: game.clock_running,
      clock_remaining_ms: clock.remainingMs(game, now),
      winner_team_id: stats.winner_team_id,
    },
    home: side(game.home_team_id),
    away: side(game.away_team_id),
    active_penalties: stats.penalties.active.map((p) => ({
      event_id: p.event_id,
      team_id: p.team_id,
      player: who(p.player_id),
      infraction: p.infraction,
      severity: p.severity,
      minutes: p.minutes,
      queued: p.queued,
      affects_strength: p.affects_strength,
      start_abs: p.start,
      end_abs: p.end,
      remaining_sec: p.remaining_sec,
    })),
    events: decorated,
    lineups: {
      home: roster.filter((r) => r.team_id === game.home_team_id).map(lineupRow),
      away: roster.filter((r) => r.team_id === game.away_team_id).map(lineupRow),
    },
    box: {
      skaters: stats.skaters.map((s) => ({ ...s, player: who(s.player_id) })),
      goalies: stats.goalies.map((g) => ({
        ...g,
        player: who(g.player_id),
        save_pct: g.shots_against ? Math.round(((g.shots_against - g.goals_against) / g.shots_against) * 1000) / 1000 : null,
      })),
    },
  };
}

function lineupRow(r) {
  return { player_id: r.player_id, number: r.jersey_number, name: `${r.first_name} ${r.last_name}`, position: r.position, dressed: r.dressed };
}

function decorateEvent(t, e, who, stats) {
  const len = clock.periodLengthSec(t, e.period);
  const out = {
    id: e.id,
    type: e.type,
    team_id: e.team_id,
    period: e.period,
    period_label: clock.periodLabel(t, e.period),
    elapsed_sec: e.elapsed_sec,
    time: clock.formatClock(e.elapsed_sec),
    clock_remaining: clock.formatClock(Math.max(0, len - e.elapsed_sec)),
    player: who(e.player_id),
    secondary_player: who(e.secondary_player_id),
    goalie: who(e.goalie_id),
    notes: e.notes,
  };
  if (e.type === "goal" || e.type === "penalty_shot") {
    out.assists = [e.assist1_id, e.assist2_id].filter((x) => x != null).map(who);
    out.strength = stats.goal_strength[e.id] || e.strength || (e.type === "penalty_shot" ? "PS" : null);
    out.strength_override = e.strength;
    out.empty_net = e.empty_net;
    out.on_ice_home = e.on_ice_home;
    out.on_ice_away = e.on_ice_away;
  }
  if (e.type === "penalty") {
    Object.assign(out, {
      penalty_minutes: e.penalty_minutes,
      penalty_severity: e.penalty_severity,
      infraction: e.infraction,
      coincidental: e.coincidental,
    });
  }
  if (e.type === "penalty_shot" || e.type === "shootout_attempt") out.result = e.result;
  return out;
}

async function gameSnapshot(gameId) {
  return buildSnapshot(await loadGameBundle(gameId));
}

/**
 * Loads every started game in a tournament in three queries and computes
 * standings plus per-player totals.
 */
async function tournamentStats(tournamentId) {
  const tournament = await getTournament(tournamentId);
  const [teams, games] = await Promise.all([
    db.many("SELECT * FROM teams WHERE tournament_id = $1 ORDER BY seed NULLS LAST, name", [tournamentId]),
    db.many("SELECT * FROM games WHERE tournament_id = $1 ORDER BY scheduled_at NULLS LAST, id", [tournamentId]),
  ]);
  const started = games.filter((g) => g.status !== "scheduled");
  const ids = started.map((g) => g.id);
  const [rosters, events] = ids.length
    ? await Promise.all([
        db.many(
          `SELECT gr.*, COALESCE(gr.position, p.position) AS position FROM game_rosters gr
             JOIN players p ON p.id = gr.player_id WHERE gr.game_id = ANY($1)`,
          [ids],
        ),
        db.many("SELECT * FROM game_events WHERE game_id = ANY($1) AND NOT voided", [ids]),
      ])
    : [[], []];
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) (m.get(r.game_id) || m.set(r.game_id, []).get(r.game_id)).push(r);
    return m;
  };
  const rosterBy = group(rosters);
  const eventsBy = group(events);
  const now = Date.now();
  const gameStats = started.map((game) =>
    computeGameStats({ tournament, game, roster: rosterBy.get(game.id) || [], events: eventsBy.get(game.id) || [], now }),
  );
  const totals = aggregatePlayerStats(gameStats);
  const standings = computeStandings(tournament, teams, games, gameStats);

  const playerIds = [...new Set([...totals.skaters, ...totals.goalies].map((l) => l.player_id))];
  const players = playerIds.length
    ? await db.many(
        `SELECT ${PUBLIC_PLAYER_COLS}, re.team_id AS current_team_id, re.jersey_number
           FROM players p LEFT JOIN roster_entries re ON re.player_id = p.id AND re.tournament_id = $2
          WHERE p.id = ANY($1)`,
        [playerIds, tournamentId],
      )
    : [];
  const playerById = new Map(players.map((p) => [p.id, p]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const describe = (line) => {
    const p = playerById.get(line.player_id) || {};
    const teamIds = line.by_team.map((b) => b.team_id);
    const currentTeam = p.current_team_id ?? teamIds[teamIds.length - 1];
    return {
      ...line,
      first_name: p.first_name,
      last_name: p.last_name,
      name: p.first_name ? `${p.first_name} ${p.last_name}` : `Player ${line.player_id}`,
      position: p.position,
      jersey_number: p.jersey_number ?? null,
      factions_order: p.factions_order ?? null,
      team_id: currentTeam,
      team: teamById.get(currentTeam)?.short_name || teamById.get(currentTeam)?.name || null,
      teams: teamIds.map((id) => teamById.get(id)?.name).filter(Boolean),
    };
  };

  return {
    tournament,
    teams,
    games,
    gameStats,
    standings,
    skaters: totals.skaters.map(describe).sort((a, b) => b.points - a.points || b.goals - a.goals || a.gp - b.gp),
    goalies: totals.goalies.map(describe).sort((a, b) => (b.save_pct ?? -1) - (a.save_pct ?? -1) || b.wins - a.wins),
  };
}

/** Career line for one player: imported history + every tournament played. */
async function playerCareer(playerId) {
  const player = await db.one(`SELECT ${PUBLIC_PLAYER_COLS} FROM players p WHERE p.id = $1`, [playerId]);
  if (!player) throw notFound("player");
  const [history, tournaments, rosters] = await Promise.all([
    db.many("SELECT * FROM historical_stats WHERE player_id = $1 ORDER BY season NULLS FIRST, id", [playerId]),
    db.many(
      `SELECT DISTINCT t.id, t.name, t.season, t.start_date FROM tournaments t
         JOIN games g ON g.tournament_id = t.id
         JOIN game_rosters gr ON gr.game_id = g.id AND gr.player_id = $1
        UNION
       SELECT t.id, t.name, t.season, t.start_date FROM tournaments t
         JOIN roster_entries re ON re.tournament_id = t.id AND re.player_id = $1
        ORDER BY start_date NULLS LAST, id`,
      [playerId],
    ),
    db.many(
      `SELECT re.tournament_id, re.team_id, re.jersey_number, re.position, re.role, tm.name AS team_name
         FROM roster_entries re JOIN teams tm ON tm.id = re.team_id WHERE re.player_id = $1`,
      [playerId],
    ),
  ]);
  const lines = [];
  for (const t of tournaments) {
    const s = await tournamentStats(t.id);
    const skater = s.skaters.find((x) => x.player_id === playerId) || null;
    const goalie = s.goalies.find((x) => x.player_id === playerId) || null;
    lines.push({
      tournament_id: t.id,
      tournament: t.name,
      season: t.season,
      roster: rosters.find((r) => r.tournament_id === t.id) || null,
      skater,
      goalie,
    });
  }
  return { player, history, tournaments: lines, career: careerTotals(history, lines) };
}

function careerTotals(history, lines) {
  const sk = { gp: 0, goals: 0, assists: 0, points: 0, pim: 0, plus_minus: 0, ppg: 0, shg: 0, gwg: 0, shots: 0 };
  const gl = { gp: 0, wins: 0, losses: 0, ot_losses: 0, ties: 0, shots_against: 0, goals_against: 0, shutouts: 0, toi_sec: 0 };
  for (const h of history) {
    for (const k of Object.keys(sk)) if (k !== "points") sk[k] += h[k] || 0;
    gl.gp += h.goalie_gp || 0;
    for (const k of Object.keys(gl)) if (k !== "gp") gl[k] += h[k] || 0;
  }
  for (const l of lines) {
    if (l.skater) for (const k of Object.keys(sk)) if (k !== "points") sk[k] += l.skater[k] || 0;
    if (l.goalie) for (const k of Object.keys(gl)) gl[k] += l.goalie[k] || 0;
  }
  sk.points = sk.goals + sk.assists;
  const saves = gl.shots_against - gl.goals_against;
  return {
    skater: sk,
    goalie: {
      ...gl,
      saves,
      save_pct: gl.shots_against ? Math.round((saves / gl.shots_against) * 1000) / 1000 : null,
      gaa: gl.toi_sec ? Math.round(((gl.goals_against * 3600) / gl.toi_sec) * 100) / 100 : null,
    },
  };
}

module.exports = {
  PUBLIC_PLAYER_COLS,
  getTournament,
  getGame,
  loadGameBundle,
  loadGameRoster,
  buildSnapshot,
  gameSnapshot,
  tournamentStats,
  playerCareer,
  teamPublic,
};

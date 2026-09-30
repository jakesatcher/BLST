const db = require("../db");
const clock = require("../lib/clock");
const { bus, emitDomain } = require("../lib/bus");
const { badRequest, conflict, notFound, optInt, optEnum, optString, optBool } = require("../lib/http");
const { computeGameStats } = require("../lib/stats");
const data = require("./data");

const EVENT_TYPES = [
  "goal", "shot", "missed_shot", "blocked_shot", "penalty", "faceoff", "hit", "giveaway", "takeaway",
  "goalie_change", "penalty_shot", "shootout_attempt", "timeout", "note",
];
const SEVERITIES = ["minor", "bench_minor", "double_minor", "major", "misconduct", "game_misconduct", "match"];
const DEFAULT_MINUTES = { minor: 2, bench_minor: 2, double_minor: 4, major: 5, misconduct: 10, game_misconduct: 10, match: 5 };
const SHOT_TYPES = new Set(["goal", "shot", "penalty_shot", "shootout_attempt"]);

// ---------------------------------------------------------------------------
// Publishing

/**
 * Rebuilds the game's public snapshot once and pushes it to every SSE
 * subscriber, then refreshes the cached score columns.
 */
async function publish(gameId, reason) {
  const bundle = await data.loadGameBundle(gameId);
  const snapshot = data.buildSnapshot(bundle);
  const { game } = bundle;
  if (snapshot.home.score !== game.home_score || snapshot.away.score !== game.away_score) {
    await db.query("UPDATE games SET home_score = $2, away_score = $3 WHERE id = $1", [
      gameId, snapshot.home.score, snapshot.away.score,
    ]);
  }
  bus.emit("game", { gameId, tournamentId: game.tournament_id, reason, snapshot });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Clock expiry timers
//
// Viewers tick the clock locally, but the server also stops it at 0:00 so
// the stored state never shows a running clock past the horn.

const timers = new Map();

function arm(game) {
  disarm(game.id);
  if (!game.clock_running) return;
  const ms = clock.remainingMs(game);
  const startedAt = new Date(game.clock_started_at).toISOString();
  const timer = setTimeout(() => expire(game.id, startedAt).catch((err) => console.error("clock expiry failed", err)), ms + 50);
  timer.unref();
  timers.set(game.id, timer);
}

function disarm(gameId) {
  const timer = timers.get(gameId);
  if (timer) clearTimeout(timer);
  timers.delete(gameId);
}

async function expire(gameId, startedAt) {
  timers.delete(gameId);
  // Guard on clock_started_at so a stop/start that raced this timer wins.
  const g = await db.one(
    `UPDATE games SET clock_running = FALSE, clock_remaining_ms = 0, clock_started_at = NULL, updated_at = now()
      WHERE id = $1 AND clock_running AND clock_started_at = $2 RETURNING *`,
    [gameId, startedAt],
  );
  if (!g) return;
  await publish(gameId, "clock.expired");
  emitDomain("game.clock", { game_id: gameId, tournament_id: g.tournament_id, action: "expired", period: g.period });
}

async function rearmAll() {
  const running = await db.many("SELECT * FROM games WHERE clock_running");
  running.forEach(arm);
  return running.length;
}

function disarmAll() {
  for (const id of [...timers.keys()]) disarm(id);
}

// ---------------------------------------------------------------------------
// Game lifecycle

async function lockGame(client, gameId) {
  const g = await client.query("SELECT * FROM games WHERE id = $1 FOR UPDATE", [gameId]).then((r) => r.rows[0]);
  if (!g) throw notFound("game");
  return g;
}

/**
 * Faces off a game: snapshots each team's roster into the game lineup,
 * records the starting goalies, and puts period 1 on the clock (stopped).
 */
async function startGame(gameId, body = {}) {
  const game = await db.tx(async (c) => {
    const g = await lockGame(c, gameId);
    if (g.status !== "scheduled") throw conflict(`game is already ${g.status}`);
    const t = await data.getTournament(g.tournament_id, c);
    const existing = await c.query("SELECT 1 FROM game_rosters WHERE game_id = $1 LIMIT 1", [gameId]);
    if (!existing.rowCount) {
      await c.query(
        `INSERT INTO game_rosters (game_id, player_id, team_id, jersey_number, position, dressed)
         SELECT $1, re.player_id, re.team_id, re.jersey_number, COALESCE(re.position, p.position), TRUE
           FROM roster_entries re JOIN players p ON p.id = re.player_id
          WHERE re.team_id IN ($2, $3)`,
        [gameId, g.home_team_id, g.away_team_id],
      );
    }
    const goalies = {};
    for (const [side, teamId] of [["home", g.home_team_id], ["away", g.away_team_id]]) {
      let goalieId = optInt(body[`${side}_goalie_id`], `${side}_goalie_id`, { min: 1 });
      if (goalieId === undefined) {
        const guess = await c.query(
          "SELECT player_id FROM game_rosters WHERE game_id = $1 AND team_id = $2 AND position = 'G' AND dressed ORDER BY jersey_number NULLS LAST LIMIT 1",
          [gameId, teamId],
        );
        goalieId = guess.rows[0]?.player_id ?? null;
      }
      goalies[side] = goalieId;
      await c.query(
        "INSERT INTO game_events (game_id, type, team_id, period, elapsed_sec, goalie_id) VALUES ($1, 'goalie_change', $2, 1, 0, $3)",
        [gameId, teamId, goalieId],
      );
    }
    return c
      .query(
        `UPDATE games SET status = 'live', period = 1, clock_running = FALSE, clock_remaining_ms = $2,
                clock_started_at = NULL, home_goalie_id = $3, away_goalie_id = $4, started_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [gameId, clock.periodLengthSec(t, 1) * 1000, goalies.home, goalies.away],
      )
      .then((r) => r.rows[0]);
  });
  await db.query("UPDATE tournaments SET status = 'active' WHERE id = $1 AND status = 'upcoming'", [game.tournament_id]);
  const snapshot = await publish(gameId, "game.started");
  emitDomain("game.started", { game_id: gameId, tournament_id: game.tournament_id, snapshot });
  return snapshot;
}

async function clockAction(gameId, body = {}) {
  const action = optEnum(body.action, "action", ["start", "stop", "set", "adjust"]);
  if (!action) throw badRequest("action is required (start | stop | set | adjust)");
  const game = await db.tx(async (c) => {
    const g = await lockGame(c, gameId);
    if (g.status === "scheduled") throw conflict("start the game first");
    if (g.status === "final") throw conflict("game is final");
    const t = await data.getTournament(g.tournament_id, c);
    const lenMs = clock.periodLengthSec(t, g.period) * 1000;
    const now = Date.now();
    let remaining = clock.remainingMs(g, now);
    let running = g.clock_running;
    let status = g.status;
    if (action === "start") {
      if (remaining <= 0) throw conflict("period has ended; advance to the next period");
      running = true;
      status = "live";
    } else if (action === "stop") {
      running = false;
    } else if (action === "set") {
      const sec = Number(body.remaining_sec);
      if (!Number.isFinite(sec) || sec < 0) throw badRequest("remaining_sec must be a non-negative number");
      remaining = Math.min(lenMs, Math.round(sec * 1000));
    } else {
      const delta = Number(body.delta_sec);
      if (!Number.isFinite(delta)) throw badRequest("delta_sec must be a number");
      remaining = Math.max(0, Math.min(lenMs, remaining + Math.round(delta * 1000)));
    }
    if (remaining <= 0) running = false;
    return c
      .query(
        `UPDATE games SET clock_running = $2, clock_remaining_ms = $3, clock_started_at = $4, status = $5, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [gameId, running, remaining, running ? new Date(now) : null, status],
      )
      .then((r) => r.rows[0]);
  });
  arm(game);
  const snapshot = await publish(gameId, `clock.${action}`);
  emitDomain("game.clock", {
    game_id: gameId, tournament_id: game.tournament_id, action, period: game.period,
    running: game.clock_running, remaining_ms: game.clock_remaining_ms,
  });
  return snapshot;
}

async function endPeriod(gameId) {
  const game = await db.tx(async (c) => {
    const g = await lockGame(c, gameId);
    if (g.status !== "live") throw conflict("game is not live");
    return c
      .query(
        `UPDATE games SET status = 'intermission', clock_running = FALSE, clock_remaining_ms = 0, clock_started_at = NULL,
                updated_at = now() WHERE id = $1 RETURNING *`,
        [gameId],
      )
      .then((r) => r.rows[0]);
  });
  disarm(gameId);
  const snapshot = await publish(gameId, "period.ended");
  emitDomain("game.period", { game_id: gameId, tournament_id: game.tournament_id, action: "ended", period: game.period });
  return snapshot;
}

async function nextPeriod(gameId) {
  const game = await db.tx(async (c) => {
    const g = await lockGame(c, gameId);
    if (!["live", "intermission"].includes(g.status)) throw conflict("game is not in progress");
    const t = await data.getTournament(g.tournament_id, c);
    const period = g.period + 1;
    if (period > t.periods && !t.ot_length_sec) throw conflict("this tournament has no overtime; end the game or go to a shootout");
    return c
      .query(
        `UPDATE games SET status = 'live', period = $2, clock_running = FALSE, clock_remaining_ms = $3,
                clock_started_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
        [gameId, period, clock.periodLengthSec(t, period) * 1000],
      )
      .then((r) => r.rows[0]);
  });
  disarm(gameId);
  const snapshot = await publish(gameId, "period.started");
  emitDomain("game.period", { game_id: gameId, tournament_id: game.tournament_id, action: "started", period: game.period });
  return snapshot;
}

/** Final horn. The decision (REG/OT/SO) is inferred unless given. */
async function endGame(gameId, body = {}) {
  const decision = optEnum(body.decision, "decision", ["REG", "OT", "SO"]);
  const bundle = await data.loadGameBundle(gameId);
  const { game: current, tournament: t } = bundle;
  if (current.status === "scheduled") throw conflict("game has not started");
  if (current.status === "final") throw conflict("game is already final");
  const finalAbs = clock.absSec(t, current.period, clock.elapsedSec(t, current));
  const projected = computeGameStats({
    ...bundle,
    game: { ...current, status: "final", final_elapsed_sec: finalAbs, decision: decision ?? null },
  });
  if (!projected.winner_team_id && !t.allow_ties && !optBool(body.allow_tie, "allow_tie")) {
    throw conflict("game is tied and this tournament does not allow ties: play overtime or a shootout (or pass allow_tie: true)");
  }
  const game = await db.one(
    `UPDATE games SET status = 'final', clock_running = FALSE, clock_remaining_ms = $2, clock_started_at = NULL,
            final_elapsed_sec = $3, decision = $4, ended_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('live', 'intermission') RETURNING *`,
    [gameId, clock.remainingMs(current), finalAbs, projected.decision],
  );
  if (!game) throw conflict("game state changed; try again");
  disarm(gameId);
  const snapshot = await publish(gameId, "game.final");
  emitDomain("game.final", {
    game_id: gameId,
    tournament_id: game.tournament_id,
    decision: projected.decision,
    home_team_id: game.home_team_id,
    away_team_id: game.away_team_id,
    home_score: snapshot.home.score,
    away_score: snapshot.away.score,
    winner_team_id: projected.winner_team_id,
    snapshot,
  });
  return snapshot;
}

/** Undo "final" (score correction after the horn). */
async function reopenGame(gameId) {
  const game = await db.one(
    `UPDATE games SET status = 'intermission', decision = NULL, ended_at = NULL, final_elapsed_sec = NULL, updated_at = now()
      WHERE id = $1 AND status = 'final' RETURNING *`,
    [gameId],
  );
  if (!game) throw conflict("only a final game can be reopened");
  const snapshot = await publish(gameId, "game.reopened");
  emitDomain("game.reopened", { game_id: gameId, tournament_id: game.tournament_id });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Events

function parseIdList(value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) throw badRequest(`${name} must be an array of player ids`);
  return value.map((v) => optInt(v, name, { min: 1 }));
}

function parseEventBody(body, { partial }) {
  const e = {
    type: optEnum(body.type, "type", EVENT_TYPES),
    team_id: optInt(body.team_id, "team_id", { min: 1 }),
    period: optInt(body.period, "period", { min: 1, max: 20 }),
    elapsed_sec: optInt(body.elapsed_sec, "elapsed_sec", { min: 0, max: 7200 }),
    player_id: optInt(body.player_id, "player_id", { min: 1 }),
    assist1_id: optInt(body.assist1_id, "assist1_id", { min: 1 }),
    assist2_id: optInt(body.assist2_id, "assist2_id", { min: 1 }),
    secondary_player_id: optInt(body.secondary_player_id, "secondary_player_id", { min: 1 }),
    goalie_id: optInt(body.goalie_id, "goalie_id", { min: 1 }),
    strength: optEnum(body.strength, "strength", ["EV", "PP", "SH", "PS"]),
    empty_net: optBool(body.empty_net, "empty_net"),
    penalty_minutes: optInt(body.penalty_minutes, "penalty_minutes", { min: 0, max: 60 }),
    penalty_severity: optEnum(body.penalty_severity, "penalty_severity", SEVERITIES),
    infraction: optString(body.infraction, "infraction", { max: 80 }),
    coincidental: optBool(body.coincidental, "coincidental"),
    result: optEnum(body.result, "result", ["goal", "save", "miss"]),
    on_ice_home: parseIdList(body.on_ice_home, "on_ice_home"),
    on_ice_away: parseIdList(body.on_ice_away, "on_ice_away"),
    notes: optString(body.notes, "notes", { max: 500 }),
  };
  // "elapsed" may also be given as a clock reading ("12:34" remaining).
  if (body.clock !== undefined && e.elapsed_sec === undefined) e.clock_remaining = parseClock(body.clock);
  if (!partial && !e.type) throw badRequest("type is required");
  return e;
}

function parseClock(value) {
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(String(value).trim());
  if (!m) throw badRequest("clock must look like mm:ss");
  return Number(m[1]) * 60 + Number(m[2]);
}

function goalieInNet(events, t, teamId, atAbs) {
  let goalie = null;
  const changes = events
    .filter((e) => !e.voided && e.type === "goalie_change" && e.team_id === teamId)
    .map((e) => ({ at: clock.absSec(t, e.period, e.elapsed_sec), id: e.id, goalie: e.goalie_id }))
    .sort((a, b) => a.at - b.at || a.id - b.id);
  for (const c of changes) if (c.at <= atAbs) goalie = c.goalie;
  return goalie;
}

/**
 * Fills in what the scorekeeper didn't have to type: period/time from
 * the running clock, the team from the player's lineup, the goalie in
 * net from goalie changes, empty net, and default penalty minutes.
 */
function completeEvent(e, bundle, existing = {}) {
  const { tournament: t, game, roster, events } = bundle;
  const merged = { ...existing };
  for (const [k, v] of Object.entries(e)) if (v !== undefined && k !== "clock_remaining") merged[k] = v;
  const type = merged.type;

  if (merged.period == null) merged.period = game.period;
  if (e.clock_remaining !== undefined && e.elapsed_sec === undefined) {
    merged.elapsed_sec = Math.max(0, clock.periodLengthSec(t, merged.period) - e.clock_remaining);
  } else if (merged.elapsed_sec == null) {
    merged.elapsed_sec = merged.period === game.period ? clock.elapsedSec(t, game) : 0;
  }

  const teamIds = [game.home_team_id, game.away_team_id];
  const lineupTeam = (pid) => roster.find((r) => r.player_id === pid)?.team_id;
  if (merged.team_id == null && merged.player_id != null) merged.team_id = lineupTeam(merged.player_id) ?? null;
  if (merged.team_id != null && !teamIds.includes(merged.team_id)) throw badRequest("team_id is not playing in this game");
  const needsTeam = !["note", "timeout"].includes(type);
  if (needsTeam && merged.team_id == null) throw badRequest(`team_id is required for ${type} events`);

  const opponent = merged.team_id === game.home_team_id ? game.away_team_id : game.home_team_id;
  const atAbs = clock.absSec(t, merged.period, merged.elapsed_sec);

  const creating = existing.id === undefined;
  if (SHOT_TYPES.has(type) && e.goalie_id === undefined && creating) {
    merged.goalie_id = goalieInNet(events, t, opponent, atAbs);
  }
  if (type === "goal" && e.empty_net === undefined && creating) merged.empty_net = merged.goalie_id == null;

  if (type === "penalty") {
    if (!merged.penalty_severity) merged.penalty_severity = "minor";
    if (merged.penalty_minutes == null) merged.penalty_minutes = DEFAULT_MINUTES[merged.penalty_severity];
  }
  if ((type === "penalty_shot" || type === "shootout_attempt") && !merged.result) throw badRequest(`result is required for ${type}`);
  if (type === "goal" && merged.assist1_id == null && merged.assist2_id != null) {
    merged.assist1_id = merged.assist2_id;
    merged.assist2_id = null;
  }
  if (type === "goal") {
    const ids = [merged.player_id, merged.assist1_id, merged.assist2_id].filter((x) => x != null);
    if (new Set(ids).size !== ids.length) throw badRequest("scorer and assists must be different players");
  }
  return merged;
}

const EVENT_COLUMNS = [
  "type", "team_id", "period", "elapsed_sec", "player_id", "assist1_id", "assist2_id", "secondary_player_id", "goalie_id",
  "strength", "empty_net", "penalty_minutes", "penalty_severity", "infraction", "coincidental", "result",
  "on_ice_home", "on_ice_away", "notes",
];

async function createEvent(gameId, body) {
  const bundle = await data.loadGameBundle(gameId);
  if (bundle.game.status === "scheduled") throw conflict("start the game before recording events");
  const e = completeEvent(parseEventBody(body, { partial: false }), bundle);
  const cols = EVENT_COLUMNS.filter((c) => e[c] !== undefined);
  const row = await db.one(
    `INSERT INTO game_events (game_id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING *`,
    [gameId, ...cols.map((c) => e[c])],
  );
  await afterEventWrite(bundle.game, row);
  const snapshot = await publish(gameId, "event.created");
  emitDomain("game.event.created", { game_id: gameId, tournament_id: bundle.game.tournament_id, event: row });
  return { event: row, snapshot };
}

async function updateEvent(gameId, eventId, body) {
  const bundle = await data.loadGameBundle(gameId);
  const existing = bundle.events.find((x) => x.id === eventId);
  if (!existing) throw notFound("event");
  const parsed = parseEventBody(body, { partial: true });
  const e = completeEvent(parsed, bundle, existing);
  const changed = EVENT_COLUMNS.filter((c) => parsed[c] !== undefined || (c === "elapsed_sec" && parsed.clock_remaining !== undefined));
  if (!changed.length) return { event: existing, snapshot: data.buildSnapshot(bundle) };
  const row = await db.one(
    `UPDATE game_events SET ${changed.map((c, i) => `${c} = $${i + 3}`).join(", ")}, updated_at = now()
      WHERE id = $1 AND game_id = $2 RETURNING *`,
    [eventId, gameId, ...changed.map((c) => e[c])],
  );
  await afterEventWrite(bundle.game, row);
  const snapshot = await publish(gameId, "event.updated");
  emitDomain("game.event.updated", { game_id: gameId, tournament_id: bundle.game.tournament_id, event: row });
  return { event: row, snapshot };
}

/** Events are voided rather than deleted so the log keeps its history. */
async function voidEvent(gameId, eventId, voided = true) {
  const row = await db.one(
    "UPDATE game_events SET voided = $3, updated_at = now() WHERE id = $1 AND game_id = $2 RETURNING *",
    [eventId, gameId, voided],
  );
  if (!row) throw notFound("event");
  const game = await data.getGame(gameId);
  await afterEventWrite(game, row);
  const snapshot = await publish(gameId, voided ? "event.voided" : "event.restored");
  emitDomain(voided ? "game.event.voided" : "game.event.restored", { game_id: gameId, tournament_id: game.tournament_id, event: row });
  return { event: row, snapshot };
}

/** Keeps games.home/away_goalie_id pointing at whoever is in net now. */
async function afterEventWrite(game, row) {
  if (row.type !== "goalie_change") return;
  const t = await data.getTournament(game.tournament_id);
  const events = await db.many("SELECT * FROM game_events WHERE game_id = $1", [game.id]);
  for (const [col, teamId] of [["home_goalie_id", game.home_team_id], ["away_goalie_id", game.away_team_id]]) {
    await db.query(`UPDATE games SET ${col} = $2 WHERE id = $1`, [game.id, goalieInNet(events, t, teamId, Infinity)]);
  }
}

/** Convenience wrapper: swap goalies / pull the goalie at the current time. */
async function changeGoalie(gameId, body) {
  const teamId = optInt(body.team_id, "team_id", { min: 1 });
  if (!teamId) throw badRequest("team_id is required");
  const goalieId = body.goalie_id == null ? null : optInt(body.goalie_id, "goalie_id", { min: 1 });
  return createEvent(gameId, { type: "goalie_change", team_id: teamId, goalie_id: goalieId, period: body.period, elapsed_sec: body.elapsed_sec });
}

/** Scratch/dress players or add a late addition to the game lineup. */
async function updateLineup(gameId, body) {
  const game = await data.getGame(gameId);
  const entries = Array.isArray(body.players) ? body.players : [body];
  await db.tx(async (c) => {
    for (const p of entries) {
      const playerId = optInt(p.player_id, "player_id", { min: 1 });
      if (!playerId) throw badRequest("player_id is required");
      const teamId = optInt(p.team_id, "team_id", { min: 1 });
      const current = await c.query("SELECT * FROM game_rosters WHERE game_id = $1 AND player_id = $2", [gameId, playerId]);
      if (current.rowCount) {
        await c.query(
          `UPDATE game_rosters SET dressed = COALESCE($3, dressed), jersey_number = COALESCE($4, jersey_number),
                  position = COALESCE($5, position), team_id = COALESCE($6, team_id)
            WHERE game_id = $1 AND player_id = $2`,
          [gameId, playerId, optBool(p.dressed, "dressed") ?? null, optInt(p.jersey_number, "jersey_number", { min: 0, max: 99 }) ?? null,
            optEnum(p.position, "position", ["C", "LW", "RW", "F", "D", "G"]) ?? null, teamId ?? null],
        );
      } else {
        if (![game.home_team_id, game.away_team_id].includes(teamId)) throw badRequest("team_id must be one of the teams in this game");
        const re = await c.query("SELECT * FROM roster_entries WHERE player_id = $1 AND tournament_id = $2", [playerId, game.tournament_id]);
        const player = await c.query("SELECT position FROM players WHERE id = $1", [playerId]);
        if (!player.rowCount) throw notFound("player");
        await c.query(
          `INSERT INTO game_rosters (game_id, player_id, team_id, jersey_number, position, dressed) VALUES ($1, $2, $3, $4, $5, $6)`,
          [gameId, playerId, teamId, optInt(p.jersey_number, "jersey_number", { min: 0, max: 99 }) ?? re.rows[0]?.jersey_number ?? null,
            p.position ?? re.rows[0]?.position ?? player.rows[0].position, optBool(p.dressed, "dressed") ?? true],
        );
      }
    }
  });
  return publish(gameId, "lineup.updated");
}

module.exports = {
  EVENT_TYPES,
  SEVERITIES,
  publish,
  startGame,
  clockAction,
  endPeriod,
  nextPeriod,
  endGame,
  reopenGame,
  createEvent,
  updateEvent,
  voidEvent,
  changeGoalie,
  updateLineup,
  rearmAll,
  disarmAll,
  goalieInNet,
};

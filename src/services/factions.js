const config = require("../config");
const db = require("../db");
const { bus } = require("../lib/bus");
const { HttpError, badRequest, conflict } = require("../lib/http");
const data = require("./data");

// Client for the BLPA Factions (Original Draft Society) API.
//
// Mapping between the two apps:
//   BLST tournament  ->  Factions Event          (POST /events)
//   BLST player      ->  Factions Player         (POST /players, keyed by email)
//   stat line        ->  EventParticipation      (POST /events/:id/participation — idempotent upsert)
//   milestone        ->  Achievement             (POST /players/:id/achievements — idempotent per code)
//
// Every push is an upsert on the Factions side, so re-running a sync after
// a stat correction overwrites the old numbers instead of double counting.
// OrderProgress points (POST /players/:id/points) are deliberately never
// touched: that endpoint increments, so it can't be retried safely.

const DEFAULT_POINTS = {
  game_played: 1,
  goal: 2,
  assist: 1,
  win: 1,
  shutout: 3,
  hat_trick: 2,
  champion: 5,
  runner_up: 3,
};

function isConfigured() {
  return Boolean(config.factions.baseUrl);
}

async function request(method, path, body) {
  if (!isConfigured()) throw new HttpError(503, "Factions integration is not configured (set FACTIONS_BASE_URL)");
  const headers = { accept: "application/json" };
  if (config.factions.adminToken) headers["x-admin-token"] = config.factions.adminToken;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(`${config.factions.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new HttpError(502, `could not reach Factions: ${err.message}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json && json.error ? (typeof json.error === "string" ? json.error : JSON.stringify(json.error)) : text;
    throw new HttpError(502, `Factions ${method} ${path} failed with HTTP ${res.status}: ${detail}`.slice(0, 500));
  }
  return json;
}

async function log(tournamentId, action, ok, detail) {
  await db.query("INSERT INTO factions_sync_log (tournament_id, action, ok, detail) VALUES ($1, $2, $3, $4)", [
    tournamentId, action, ok, JSON.stringify(detail ?? null),
  ]);
}

function pointsConfig(t) {
  return { ...DEFAULT_POINTS, ...(t.factions_points || {}) };
}

/** Links a tournament to a Factions Event, creating the event if no id is given. */
async function linkTournament(tournamentId, { event_id: eventId } = {}) {
  const t = await data.getTournament(tournamentId);
  let id = eventId;
  if (!id) {
    const toIso = (d) => (d ? new Date(`${d}T00:00:00Z`).toISOString() : undefined);
    const event = await request("POST", "/events", {
      name: t.name,
      startDate: toIso(t.start_date),
      endDate: toIso(t.end_date),
    });
    id = event.id;
  }
  await db.query("UPDATE tournaments SET factions_event_id = $2, updated_at = now() WHERE id = $1", [tournamentId, id]);
  await log(tournamentId, "link", true, { event_id: id, created: !eventId });
  return { tournament_id: tournamentId, factions_event_id: id, created: !eventId };
}

/**
 * Registers every rostered player that has an email with Factions and
 * stores the returned player id and Order. Players without an email are
 * skipped: Factions identifies players by email only.
 */
async function syncPlayers(tournamentId) {
  const players = await db.many(
    `SELECT p.id, p.first_name, p.last_name, p.email FROM players p
       JOIN roster_entries re ON re.player_id = p.id WHERE re.tournament_id = $1 ORDER BY p.id`,
    [tournamentId],
  );
  const result = { synced: 0, skipped_no_email: [], errors: [] };
  for (const p of players) {
    if (!p.email) {
      result.skipped_no_email.push({ player_id: p.id, name: `${p.first_name} ${p.last_name}` });
      continue;
    }
    try {
      const remote = await request("POST", "/players", { email: p.email, displayName: `${p.first_name} ${p.last_name}` });
      await db.query("UPDATE players SET factions_player_id = $2, factions_order = $3, updated_at = now() WHERE id = $1", [
        p.id, remote.id, remote.orderSlug || remote.order?.slug || null,
      ]);
      result.synced += 1;
    } catch (err) {
      result.errors.push({ player_id: p.id, error: err.message });
    }
  }
  await log(tournamentId, "sync-players", result.errors.length === 0, {
    synced: result.synced, skipped: result.skipped_no_email.length, errors: result.errors.length,
  });
  return result;
}

/**
 * Works out each player's Factions points for the tournament and the
 * achievements they earned. Pure apart from the data it's given, so the
 * formula can be previewed without pushing anything.
 */
function computeParticipation(stats, players) {
  const { tournament: t, standings, teams, gameStats } = stats;
  const pts = pointsConfig(t);
  const placementByTeam = new Map();
  for (const team of teams) placementByTeam.set(team.id, team.final_placement ?? null);
  for (const row of standings) if (placementByTeam.get(row.team_id) == null) placementByTeam.set(row.team_id, row.rank);

  const lines = new Map();
  const line = (pid) => {
    if (!lines.has(pid)) {
      lines.set(pid, { player_id: pid, gp: 0, goals: 0, assists: 0, wins: 0, shutouts: 0, hat_tricks: 0, achievements: [] });
    }
    return lines.get(pid);
  };
  for (const gs of gameStats) {
    if (gs.status !== "final") continue;
    for (const s of gs.skaters) {
      if (!s.gp) continue;
      const l = line(s.player_id);
      l.team_id = s.team_id;
      l.gp += 1;
      l.goals += s.goals;
      l.assists += s.assists;
      if (gs.winner_team_id === s.team_id) l.wins += 1;
      if (s.goals >= 3) {
        l.hat_tricks += 1;
        l.achievements.push({ code: `blst:t${t.id}:g${gs.game_id}:hat-trick`, title: `Hat trick — ${t.name} (game ${gs.game_id})` });
      }
    }
    for (const g of gs.goalies) {
      if (!g.gp) continue;
      const l = line(g.player_id);
      l.team_id = g.team_id;
      l.gp += 1;
      if (g.wins) l.wins += 1;
      if (g.shutouts) {
        l.shutouts += 1;
        l.achievements.push({ code: `blst:t${t.id}:g${gs.game_id}:shutout`, title: `Shutout — ${t.name} (game ${gs.game_id})` });
      }
    }
  }

  const out = [];
  for (const l of lines.values()) {
    const p = players.get(l.player_id);
    const placement = placementByTeam.get(p?.current_team_id ?? l.team_id) ?? null;
    let points =
      l.gp * pts.game_played + l.goals * pts.goal + l.assists * pts.assist + l.wins * pts.win +
      l.shutouts * pts.shutout + l.hat_tricks * pts.hat_trick;
    if (placement === 1) {
      points += pts.champion;
      l.achievements.push({ code: `blst:t${t.id}:champion`, title: `Champion — ${t.name}` });
    } else if (placement === 2) points += pts.runner_up;
    out.push({
      ...l,
      name: p ? `${p.first_name} ${p.last_name}` : `Player ${l.player_id}`,
      factions_player_id: p?.factions_player_id ?? null,
      placement,
      points_earned: points,
    });
  }
  return out.sort((a, b) => b.points_earned - a.points_earned);
}

async function participationPreview(tournamentId) {
  const stats = await data.tournamentStats(tournamentId);
  const players = await db.many(
    `SELECT p.id, p.first_name, p.last_name, p.factions_player_id, re.team_id AS current_team_id
       FROM players p LEFT JOIN roster_entries re ON re.player_id = p.id AND re.tournament_id = $1
      WHERE p.id IN (SELECT player_id FROM roster_entries WHERE tournament_id = $1
                     UNION SELECT gr.player_id FROM game_rosters gr JOIN games g ON g.id = gr.game_id WHERE g.tournament_id = $1)`,
    [tournamentId],
  );
  return {
    tournament: stats.tournament,
    points: pointsConfig(stats.tournament),
    participation: computeParticipation(stats, new Map(players.map((p) => [p.id, p]))),
  };
}

/** Pushes participation points, placements and achievements for a linked tournament. */
async function pushResults(tournamentId) {
  const { tournament: t, participation } = await participationPreview(tournamentId);
  if (!t.factions_event_id) throw conflict("tournament is not linked to a Factions event yet");
  const result = { pushed: 0, achievements: 0, skipped_unsynced: 0, errors: [] };
  for (const p of participation) {
    if (!p.factions_player_id) {
      result.skipped_unsynced += 1;
      continue;
    }
    const pid = encodeURIComponent(p.factions_player_id);
    try {
      await request("POST", `/events/${encodeURIComponent(t.factions_event_id)}/participation`, {
        playerId: p.factions_player_id,
        pointsEarned: p.points_earned,
        ...(p.placement != null ? { placement: p.placement } : {}),
      });
      result.pushed += 1;
      for (const a of p.achievements) {
        await request("POST", `/players/${pid}/achievements`, { code: a.code, title: a.title, eventId: t.factions_event_id });
        result.achievements += 1;
      }
    } catch (err) {
      result.errors.push({ player_id: p.player_id, error: err.message });
    }
  }
  await log(tournamentId, "push-results", result.errors.length === 0, result);
  return result;
}

async function orderTotals(tournamentId) {
  const t = await data.getTournament(tournamentId);
  if (!t.factions_event_id) throw conflict("tournament is not linked to a Factions event");
  return request("GET", `/events/${encodeURIComponent(t.factions_event_id)}/order-totals`);
}

async function status() {
  const recent = await db.many("SELECT * FROM factions_sync_log ORDER BY id DESC LIMIT 20");
  let reachable = null;
  if (isConfigured()) {
    try {
      await request("GET", "/health");
      reachable = true;
    } catch {
      reachable = false;
    }
  }
  return {
    configured: isConfigured(),
    base_url: config.factions.baseUrl || null,
    has_token: Boolean(config.factions.adminToken),
    auto_sync: config.factions.autoSync,
    reachable,
    default_points: DEFAULT_POINTS,
    recent,
  };
}

// Auto-sync on every final whistle, serialised per tournament so two
// games ending together can't interleave their pushes.
const queues = new Map();
function start() {
  bus.on("domain", ({ event, data: payload }) => {
    if (!config.factions.autoSync || !isConfigured()) return;
    if (event !== "game.final" && event !== "game.reopened") return;
    const tid = payload.tournament_id;
    const prev = queues.get(tid) || Promise.resolve();
    const next = prev
      .then(async () => {
        const t = await data.getTournament(tid);
        if (t.factions_event_id) await pushResults(tid);
      })
      .catch((err) => log(tid, "auto-push", false, { error: err.message }).catch(() => {}));
    queues.set(tid, next);
  });
}

function validatePoints(body) {
  if (body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) throw badRequest("factions_points must be an object");
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!(k in DEFAULT_POINTS)) throw badRequest(`unknown factions_points key: ${k}`);
    if (!Number.isInteger(v)) throw badRequest(`factions_points.${k} must be an integer`);
    out[k] = v;
  }
  return out;
}

module.exports = {
  DEFAULT_POINTS,
  isConfigured,
  linkTournament,
  syncPlayers,
  computeParticipation,
  participationPreview,
  pushResults,
  orderTotals,
  status,
  start,
  validatePoints,
};

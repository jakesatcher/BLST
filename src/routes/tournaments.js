const { Router } = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const {
  badRequest, conflict, notFound, intParam, optInt, optEnum, optString, optBool, requireFields, buildUpdate,
} = require("../lib/http");
const { emitDomain } = require("../lib/bus");
const data = require("../services/data");
const factions = require("../services/factions");

const router = Router();
const admin = requireRole("admin");

const POSITIONS = ["C", "LW", "RW", "F", "D", "G"];

function tournamentFields(body) {
  return {
    name: optString(body.name, "name", { max: 120 }),
    season: optString(body.season, "season", { max: 40 }),
    location: optString(body.location, "location", { max: 120 }),
    start_date: optString(body.start_date, "start_date", { max: 10 }),
    end_date: optString(body.end_date, "end_date", { max: 10 }),
    periods: optInt(body.periods, "periods", { min: 1, max: 4 }),
    period_length_sec: body.period_length_min !== undefined
      ? optInt(Math.round(Number(body.period_length_min) * 60), "period_length_min", { min: 60, max: 3600 })
      : optInt(body.period_length_sec, "period_length_sec", { min: 60, max: 3600 }),
    ot_length_sec: body.ot_length_min !== undefined
      ? optInt(Math.round(Number(body.ot_length_min) * 60), "ot_length_min", { min: 0, max: 3600 })
      : optInt(body.ot_length_sec, "ot_length_sec", { min: 0, max: 3600 }),
    skaters_per_side: optInt(body.skaters_per_side, "skaters_per_side", { min: 3, max: 6 }),
    allow_ties: optBool(body.allow_ties, "allow_ties"),
    points_win: optInt(body.points_win, "points_win", { min: 0, max: 10 }),
    points_otl: optInt(body.points_otl, "points_otl", { min: 0, max: 10 }),
    points_tie: optInt(body.points_tie, "points_tie", { min: 0, max: 10 }),
    status: optEnum(body.status, "status", ["upcoming", "active", "completed"]),
    factions_event_id: optString(body.factions_event_id, "factions_event_id", { max: 100 }),
    factions_points: body.factions_points === undefined ? undefined : JSON.stringify(factions.validatePoints(body.factions_points)),
  };
}

function defaultTeamName(i) {
  return `Team ${i}`;
}

// ---------------------------------------------------------------------------
// Tournaments

router.get("/tournaments", async (_req, res) => {
  res.json(
    await db.many(
      `SELECT t.*, (SELECT count(*) FROM teams WHERE tournament_id = t.id) AS team_count,
              (SELECT count(*) FROM games WHERE tournament_id = t.id AND status IN ('live', 'intermission')) AS live_games
         FROM tournaments t ORDER BY t.start_date DESC NULLS LAST, t.id DESC`,
    ),
  );
});

router.post("/tournaments", admin, async (req, res) => {
  const fields = tournamentFields(req.body);
  requireFields(fields, ["name"]);
  const numTeams = optInt(req.body.num_teams, "num_teams", { min: 2, max: 64 }) ?? 4;
  const teamNames = Array.isArray(req.body.team_names) ? req.body.team_names : [];
  const tournament = await db.tx(async (c) => {
    const cols = Object.keys(fields).filter((k) => fields[k] !== undefined);
    const t = await c
      .query(
        `INSERT INTO tournaments (${[...cols, "num_teams"].join(", ")}) VALUES (${[...cols, "num_teams"].map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        [...cols.map((k) => fields[k]), numTeams],
      )
      .then((r) => r.rows[0]);
    if (req.body.create_teams !== false) {
      for (let i = 1; i <= numTeams; i++) {
        const name = optString(teamNames[i - 1], "team_names[]", { max: 80 }) || defaultTeamName(i);
        await c.query("INSERT INTO teams (tournament_id, name, seed) VALUES ($1, $2, $3)", [t.id, name, i]);
      }
    }
    return t;
  });
  emitDomain("tournament.created", { tournament_id: tournament.id, tournament });
  res.status(201).json(tournament);
});

router.get("/tournaments/:id", async (req, res) => {
  const t = await data.getTournament(intParam(req.params.id));
  const teams = await db.many(
    `SELECT tm.*, (SELECT count(*) FROM roster_entries WHERE team_id = tm.id) AS player_count
       FROM teams tm WHERE tournament_id = $1 ORDER BY seed NULLS LAST, name`,
    [t.id],
  );
  res.json({ ...t, teams });
});

router.patch("/tournaments/:id", admin, async (req, res) => {
  const id = intParam(req.params.id);
  const fields = tournamentFields(req.body);
  const numTeams = optInt(req.body.num_teams, "num_teams", { min: 2, max: 64 });
  const t = await db.tx(async (c) => {
    const current = await data.getTournament(id, c);
    if (numTeams !== undefined && numTeams !== null) {
      await resizeTeams(c, current, numTeams);
      fields.num_teams = numTeams;
    }
    const upd = buildUpdate(fields, 2);
    if (!upd) return current;
    return c.query(`UPDATE tournaments SET ${upd.set}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...upd.values]).then((r) => r.rows[0]);
  });
  emitDomain("tournament.updated", { tournament_id: id, tournament: t });
  res.json(t);
});

/**
 * The "number of teams" selector: growing adds placeholder teams,
 * shrinking removes the highest-seeded teams — but only ones that have no
 * players and no games, so nothing real is ever deleted implicitly.
 */
async function resizeTeams(c, t, target) {
  const teams = (await c.query("SELECT * FROM teams WHERE tournament_id = $1 ORDER BY seed NULLS LAST, id", [t.id])).rows;
  if (target > teams.length) {
    const names = new Set(teams.map((x) => x.name));
    let n = 1;
    for (let seed = teams.length + 1; seed <= target; seed++) {
      while (names.has(defaultTeamName(n))) n++;
      names.add(defaultTeamName(n));
      await c.query("INSERT INTO teams (tournament_id, name, seed) VALUES ($1, $2, $3)", [t.id, defaultTeamName(n), seed]);
    }
  } else if (target < teams.length) {
    const extra = teams.slice(target);
    for (const team of extra) {
      const used = await c.query(
        `SELECT (SELECT count(*) FROM roster_entries WHERE team_id = $1) + (SELECT count(*) FROM games WHERE home_team_id = $1 OR away_team_id = $1) AS n`,
        [team.id],
      );
      if (used.rows[0].n > 0) throw conflict(`can't remove ${team.name}: it has players or games. Move them first or delete the team explicitly.`);
      await c.query("DELETE FROM teams WHERE id = $1", [team.id]);
    }
  }
}

router.delete("/tournaments/:id", admin, async (req, res) => {
  const id = intParam(req.params.id);
  if (req.query.confirm !== "true") throw badRequest("pass ?confirm=true to delete a tournament and all of its games and stats");
  const r = await db.query("DELETE FROM tournaments WHERE id = $1", [id]);
  if (!r.rowCount) throw notFound("tournament");
  emitDomain("tournament.deleted", { tournament_id: id });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Teams

router.get("/tournaments/:id/teams", async (req, res) => {
  const id = intParam(req.params.id);
  await data.getTournament(id);
  const teams = await db.many("SELECT * FROM teams WHERE tournament_id = $1 ORDER BY seed NULLS LAST, name", [id]);
  const roster = await db.many(
    `SELECT re.id AS roster_entry_id, re.team_id, re.jersey_number, COALESCE(re.position, p.position) AS position, re.role,
            re.draft_round, re.draft_pick, ${data.PUBLIC_PLAYER_COLS}
       FROM roster_entries re JOIN players p ON p.id = re.player_id
      WHERE re.tournament_id = $1 ORDER BY re.jersey_number NULLS LAST, p.last_name`,
    [id],
  );
  res.json(teams.map((t) => ({ ...t, roster: roster.filter((r) => r.team_id === t.id) })));
});

router.post("/tournaments/:id/teams", admin, async (req, res) => {
  const id = intParam(req.params.id);
  requireFields(req.body, ["name"]);
  const team = await db.tx(async (c) => {
    await data.getTournament(id, c);
    const row = await c
      .query(
        `INSERT INTO teams (tournament_id, name, short_name, color, seed, external_id)
         VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT count(*) + 1 FROM teams WHERE tournament_id = $1)), $6) RETURNING *`,
        [id, optString(req.body.name, "name", { max: 80 }), optString(req.body.short_name, "short_name", { max: 12 }) ?? null,
          optString(req.body.color, "color", { max: 20 }) ?? null, optInt(req.body.seed, "seed", { min: 1 }) ?? null,
          optString(req.body.external_id, "external_id") ?? null],
      )
      .then((r) => r.rows[0]);
    await c.query("UPDATE tournaments SET num_teams = (SELECT count(*) FROM teams WHERE tournament_id = $1) WHERE id = $1", [id]);
    return row;
  });
  res.status(201).json(team);
});

router.get("/teams/:id", async (req, res) => {
  const team = await db.one("SELECT * FROM teams WHERE id = $1", [intParam(req.params.id)]);
  if (!team) throw notFound("team");
  const roster = await db.many(
    `SELECT re.id AS roster_entry_id, re.jersey_number, COALESCE(re.position, p.position) AS position, re.role,
            re.draft_round, re.draft_pick, ${data.PUBLIC_PLAYER_COLS}
       FROM roster_entries re JOIN players p ON p.id = re.player_id WHERE re.team_id = $1
      ORDER BY re.jersey_number NULLS LAST, p.last_name`,
    [team.id],
  );
  res.json({ ...team, roster });
});

router.patch("/teams/:id", admin, async (req, res) => {
  const id = intParam(req.params.id);
  const upd = buildUpdate(
    {
      name: optString(req.body.name, "name", { max: 80 }),
      short_name: optString(req.body.short_name, "short_name", { max: 12 }),
      color: optString(req.body.color, "color", { max: 20 }),
      seed: optInt(req.body.seed, "seed", { min: 1 }),
      final_placement: optInt(req.body.final_placement, "final_placement", { min: 1 }),
      external_id: optString(req.body.external_id, "external_id"),
    },
    2,
  );
  if (!upd) throw badRequest("nothing to update");
  const team = await db.one(`UPDATE teams SET ${upd.set} WHERE id = $1 RETURNING *`, [id, ...upd.values]);
  if (!team) throw notFound("team");
  emitDomain("team.updated", { tournament_id: team.tournament_id, team });
  res.json(team);
});

router.delete("/teams/:id", admin, async (req, res) => {
  const id = intParam(req.params.id);
  const team = await db.one("SELECT * FROM teams WHERE id = $1", [id]);
  if (!team) throw notFound("team");
  const games = await db.one("SELECT count(*) AS n FROM games WHERE home_team_id = $1 OR away_team_id = $1", [id]);
  if (games.n > 0) throw conflict("team has games scheduled; delete those first");
  await db.tx(async (c) => {
    await c.query("DELETE FROM teams WHERE id = $1", [id]);
    await c.query("UPDATE tournaments SET num_teams = GREATEST(2, (SELECT count(*) FROM teams WHERE tournament_id = $1)) WHERE id = $1", [team.tournament_id]);
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Rosters: assignment, number changes, moves between teams

router.post("/tournaments/:id/roster", admin, async (req, res) => {
  const tid = intParam(req.params.id);
  const playerId = optInt(req.body.player_id, "player_id", { min: 1 });
  const teamId = optInt(req.body.team_id, "team_id", { min: 1 });
  if (!playerId || !teamId) throw badRequest("player_id and team_id are required");
  const team = await db.one("SELECT * FROM teams WHERE id = $1 AND tournament_id = $2", [teamId, tid]);
  if (!team) throw badRequest("team is not in this tournament");
  const entry = await db.one(
    `INSERT INTO roster_entries (tournament_id, team_id, player_id, jersey_number, position, role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [tid, teamId, playerId, optInt(req.body.jersey_number, "jersey_number", { min: 0, max: 99 }) ?? null,
      optEnum(req.body.position, "position", POSITIONS) ?? null, optEnum(req.body.role, "role", ["C", "A"]) ?? null],
  );
  emitDomain("roster.added", { tournament_id: tid, entry });
  res.status(201).json(entry);
});

router.patch("/roster/:entryId", admin, async (req, res) => {
  const id = intParam(req.params.entryId);
  const upd = buildUpdate(
    {
      jersey_number: optInt(req.body.jersey_number, "jersey_number", { min: 0, max: 99 }),
      position: optEnum(req.body.position, "position", POSITIONS),
      role: optEnum(req.body.role, "role", ["C", "A"]),
    },
    2,
  );
  if (!upd) throw badRequest("nothing to update (use /roster/move to change teams)");
  const entry = await db.one(`UPDATE roster_entries SET ${upd.set} WHERE id = $1 RETURNING *`, [id, ...upd.values]);
  if (!entry) throw notFound("roster entry");
  emitDomain("roster.updated", { tournament_id: entry.tournament_id, entry });
  res.json(entry);
});

router.delete("/roster/:entryId", admin, async (req, res) => {
  const entry = await db.one("DELETE FROM roster_entries WHERE id = $1 RETURNING *", [intParam(req.params.entryId)]);
  if (!entry) throw notFound("roster entry");
  emitDomain("roster.removed", { tournament_id: entry.tournament_id, entry });
  res.status(204).end();
});

/**
 * Moves a player to another team in the same tournament. Games already
 * played keep their lineup snapshot, so the player's earlier stats stay
 * with the old team; scheduled games pick up the new roster.
 */
router.post("/tournaments/:id/roster/move", admin, async (req, res) => {
  const tid = intParam(req.params.id);
  const playerId = optInt(req.body.player_id, "player_id", { min: 1 });
  const toTeamId = optInt(req.body.to_team_id, "to_team_id", { min: 1 });
  if (!playerId || !toTeamId) throw badRequest("player_id and to_team_id are required");
  const result = await db.tx(async (c) => {
    const entry = (await c.query("SELECT * FROM roster_entries WHERE tournament_id = $1 AND player_id = $2 FOR UPDATE", [tid, playerId])).rows[0];
    if (!entry) throw notFound("player on this tournament's roster");
    const to = (await c.query("SELECT * FROM teams WHERE id = $1 AND tournament_id = $2", [toTeamId, tid])).rows[0];
    if (!to) throw badRequest("to_team_id is not in this tournament");
    if (entry.team_id === toTeamId) throw conflict("player is already on that team");
    const number = req.body.jersey_number !== undefined
      ? optInt(req.body.jersey_number, "jersey_number", { min: 0, max: 99 })
      : entry.jersey_number;
    const updated = (await c.query(
      "UPDATE roster_entries SET team_id = $2, jersey_number = $3 WHERE id = $1 RETURNING *",
      [entry.id, toTeamId, number],
    )).rows[0];
    const move = (await c.query(
      `INSERT INTO roster_moves (tournament_id, player_id, from_team_id, to_team_id, jersey_number, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tid, playerId, entry.team_id, toTeamId, number, optString(req.body.reason, "reason", { max: 200 }) ?? null],
    )).rows[0];
    return { entry: updated, move };
  });
  emitDomain("roster.moved", { tournament_id: tid, ...result });
  res.json(result);
});

router.get("/tournaments/:id/roster/moves", async (req, res) => {
  const tid = intParam(req.params.id);
  res.json(
    await db.many(
      `SELECT m.*, p.first_name, p.last_name, f.name AS from_team, t.name AS to_team
         FROM roster_moves m JOIN players p ON p.id = m.player_id
         LEFT JOIN teams f ON f.id = m.from_team_id LEFT JOIN teams t ON t.id = m.to_team_id
        WHERE m.tournament_id = $1 ORDER BY m.created_at DESC`,
      [tid],
    ),
  );
});

// ---------------------------------------------------------------------------
// Standings, stats, leaders

router.get("/tournaments/:id/standings", async (req, res) => {
  const s = await data.tournamentStats(intParam(req.params.id));
  res.json(s.standings);
});

router.get("/tournaments/:id/stats/skaters", async (req, res) => {
  const s = await data.tournamentStats(intParam(req.params.id));
  res.json(filterTeam(s.skaters, req.query.team_id));
});

router.get("/tournaments/:id/stats/goalies", async (req, res) => {
  const s = await data.tournamentStats(intParam(req.params.id));
  res.json(filterTeam(s.goalies, req.query.team_id));
});

function filterTeam(lines, teamId) {
  if (!teamId) return lines;
  const id = intParam(teamId, "team_id");
  return lines.filter((l) => l.by_team.some((b) => b.team_id === id));
}

router.get("/tournaments/:id/leaders", async (req, res) => {
  const limit = optInt(req.query.limit, "limit", { min: 1, max: 50 }) || 5;
  const s = await data.tournamentStats(intParam(req.params.id));
  const top = (lines, key, dir = -1, filter = () => true) =>
    lines
      .filter((l) => l[key] != null && filter(l))
      .sort((a, b) => dir * (a[key] - b[key]) || b.gp - a.gp)
      .slice(0, limit)
      .map((l) => ({ player_id: l.player_id, name: l.name, team: l.team, jersey_number: l.jersey_number, gp: l.gp, value: l[key] }));
  const minGoalieGp = Math.max(1, Math.floor(Math.max(0, ...s.goalies.map((g) => g.gp)) / 2));
  res.json({
    points: top(s.skaters, "points"),
    goals: top(s.skaters, "goals"),
    assists: top(s.skaters, "assists"),
    plus_minus: top(s.skaters, "plus_minus"),
    pim: top(s.skaters, "pim"),
    save_pct: top(s.goalies, "save_pct", -1, (g) => g.gp >= minGoalieGp),
    gaa: top(s.goalies, "gaa", 1, (g) => g.gp >= minGoalieGp),
    wins: top(s.goalies, "wins"),
    shutouts: top(s.goalies, "shutouts"),
  });
});

// ---------------------------------------------------------------------------
// Schedule

router.get("/tournaments/:id/games", async (req, res) => {
  const tid = intParam(req.params.id);
  await data.getTournament(tid);
  res.json(await listGames("g.tournament_id = $1", [tid]));
});

async function listGames(where, params) {
  return db.many(
    `SELECT g.id, g.tournament_id, g.home_team_id, g.away_team_id, g.scheduled_at, g.venue, g.game_type, g.status,
            g.stream_embed_url, g.livebarn_url, g.stream_delay_sec,
            g.period, g.clock_running, g.clock_remaining_ms, g.clock_started_at, g.home_score, g.away_score, g.decision,
            h.name AS home_team, h.short_name AS home_short, h.color AS home_color, h.logo_version AS home_logo,
            a.name AS away_team, a.short_name AS away_short, a.color AS away_color, a.logo_version AS away_logo,
            t.name AS tournament_name, t.periods,
            (g.stream_embed_url IS NOT NULL OR g.livebarn_url IS NOT NULL OR EXISTS (
               SELECT 1 FROM venue_streams vs WHERE vs.tournament_id = g.tournament_id AND lower(vs.venue) = lower(g.venue))) AS has_stream
       FROM games g JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
       JOIN tournaments t ON t.id = g.tournament_id
      WHERE ${where} ORDER BY g.scheduled_at NULLS LAST, g.id`,
    params,
  );
}

/** Round-robin generator (circle method): every team plays every other team `rounds` times. */
router.post("/tournaments/:id/schedule/round-robin", admin, async (req, res) => {
  const tid = intParam(req.params.id);
  const rounds = optInt(req.body.rounds, "rounds", { min: 1, max: 4 }) || 1;
  const interval = optInt(req.body.interval_minutes, "interval_minutes", { min: 0, max: 1440 }) ?? 60;
  const startAt = req.body.start_at ? new Date(req.body.start_at) : null;
  if (startAt && Number.isNaN(startAt.getTime())) throw badRequest("start_at is not a valid date/time");
  const venue = optString(req.body.venue, "venue") ?? null;
  const teams = await db.many("SELECT id FROM teams WHERE tournament_id = $1 ORDER BY seed NULLS LAST, id", [tid]);
  if (teams.length < 2) throw badRequest("need at least two teams");
  const ids = teams.map((t) => t.id);
  if (ids.length % 2) ids.push(null);
  const pairings = [];
  for (let r = 0; r < rounds; r++) {
    const rot = [...ids];
    for (let day = 0; day < rot.length - 1; day++) {
      for (let i = 0; i < rot.length / 2; i++) {
        const a = rot[i];
        const b = rot[rot.length - 1 - i];
        if (a == null || b == null) continue;
        // Alternate home/away by round and slot so no team is always home.
        pairings.push((day + i + r) % 2 ? [a, b] : [b, a]);
      }
      rot.splice(1, 0, rot.pop());
    }
  }
  const created = await db.tx(async (c) => {
    const out = [];
    for (let i = 0; i < pairings.length; i++) {
      const at = startAt ? new Date(startAt.getTime() + i * interval * 60000) : null;
      out.push(
        (await c.query(
          "INSERT INTO games (tournament_id, home_team_id, away_team_id, scheduled_at, venue, game_type) VALUES ($1, $2, $3, $4, $5, 'pool') RETURNING *",
          [tid, pairings[i][0], pairings[i][1], at, venue],
        )).rows[0],
      );
    }
    return out;
  });
  emitDomain("schedule.generated", { tournament_id: tid, games: created.length });
  res.status(201).json(created);
});

module.exports = router;
module.exports.listGames = listGames;

const db = require("../db");
const data = require("./data");
const { badRequest, notFound, conflict } = require("../lib/http");
const { emitDomain } = require("../lib/bus");

// Leagues: league -> seasons -> divisions (B, C, D…). Each division in a
// season is a competition (a tournaments row, kind = 'league') with its own
// teams, schedule, standings and playoffs, scored live like any tournament.
// Stats are shown by season and division, and a player's stats follow them
// across teams and divisions within the league.

const SKATER_KEYS = ["gp", "goals", "assists", "points", "pim", "plus_minus", "ppg", "ppa", "shg", "sha", "gwg", "shots"];
const GOALIE_KEYS = ["gp", "wins", "losses", "ot_losses", "ties", "shots_against", "goals_against", "saves", "shutouts", "toi_sec"];
const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const add = (t, s, keys) => { for (const k of keys) t[k] += s[k] || 0; };
function goalieRates(g) {
  return {
    ...g,
    save_pct: g.shots_against ? Math.round(((g.shots_against - g.goals_against) / g.shots_against) * 1000) / 1000 : null,
    gaa: g.toi_sec ? Math.round(((g.goals_against * 3600) / g.toi_sec) * 100) / 100 : g.gp ? Math.round((g.goals_against / g.gp) * 100) / 100 : null,
  };
}

/** Division strength: set explicitly, or from the rank (1.00, 0.85, 0.70, …). */
function strengthOf(d) {
  return d.strength != null ? Number(d.strength) : Math.max(0.3, 1 - 0.15 * (d.rank - 1));
}

const unique = (err, what) => {
  if (err.code === "23505") throw conflict(`there's already a ${what} with that name`);
  throw err;
};

// ---------------------------------------------------------------------------
// Structure

async function list() {
  return db.many(
    `SELECT l.id, l.name, l.short_name, l.created_at,
            (SELECT count(*) FROM league_divisions d WHERE d.league_id = l.id)::int AS divisions,
            (SELECT count(*) FROM league_seasons s WHERE s.league_id = l.id)::int AS seasons,
            (SELECT max(s.name) FROM league_seasons s WHERE s.league_id = l.id
              AND s.id = (SELECT s2.id FROM league_seasons s2 WHERE s2.league_id = l.id ORDER BY s2.year DESC NULLS LAST, s2.start_date DESC NULLS LAST, s2.id DESC LIMIT 1)) AS current_season
       FROM leagues l ORDER BY lower(l.name)`);
}

/** The league with its divisions, seasons (newest first) and each season's competitions. */
async function get(id) {
  const league = await db.one("SELECT * FROM leagues WHERE id = $1", [id]);
  if (!league) throw notFound("league");
  const [divisions, seasons, comps] = await Promise.all([
    db.many("SELECT * FROM league_divisions WHERE league_id = $1 ORDER BY rank, name", [id]),
    db.many("SELECT * FROM league_seasons WHERE league_id = $1 ORDER BY year DESC NULLS LAST, start_date DESC NULLS LAST, id DESC", [id]),
    db.many(
      `SELECT t.id, t.name, t.status, t.imported, t.league_season_id, t.league_division_id, t.start_date, t.end_date,
              (SELECT count(*) FROM teams WHERE tournament_id = t.id)::int AS teams,
              (SELECT count(*) FROM games WHERE tournament_id = t.id)::int AS games,
              (SELECT count(*) FROM games WHERE tournament_id = t.id AND status IN ('live', 'intermission'))::int AS live_games
         FROM tournaments t WHERE t.league_id = $1`, [id]),
  ]);
  return {
    ...league,
    divisions: divisions.map((d) => ({ ...d, strength_used: strengthOf(d) })),
    seasons: seasons.map((s) => ({
      ...s,
      divisions: divisions.map((d) => {
        const c = comps.find((x) => x.league_season_id === s.id && x.league_division_id === d.id);
        return { division_id: d.id, division: d.name, competition: c || null };
      }).filter((x) => x.competition),
    })),
  };
}

async function create({ name, short_name: shortName, divisions = [] }) {
  if (!name) throw badRequest("name is required");
  return db.tx(async (c) => {
    let league;
    try {
      league = (await c.query("INSERT INTO leagues (name, short_name) VALUES ($1, $2) RETURNING *", [name, shortName ?? null])).rows[0];
    } catch (err) {
      unique(err, "league");
    }
    for (const [i, d] of divisions.entries()) {
      await c.query("INSERT INTO league_divisions (league_id, name, rank) VALUES ($1, $2, $3)", [league.id, String(d).slice(0, 40), i + 1]);
    }
    return league;
  });
}

async function update(id, { name, short_name: shortName }) {
  try {
    const l = await db.one("UPDATE leagues SET name = COALESCE($2, name), short_name = COALESCE($3, short_name) WHERE id = $1 RETURNING *", [id, name ?? null, shortName ?? null]);
    if (!l) throw notFound("league");
    return l;
  } catch (err) {
    return unique(err, "league");
  }
}

async function remove(id) {
  const played = await db.one("SELECT count(*)::int AS n FROM games g JOIN tournaments t ON t.id = g.tournament_id WHERE t.league_id = $1 AND g.status <> 'scheduled'", [id]);
  if (played.n) throw conflict(`this league has ${played.n} played game${played.n === 1 ? "" : "s"}; delete its seasons' games first`);
  const r = await db.query("DELETE FROM leagues WHERE id = $1", [id]);
  if (!r.rowCount) throw notFound("league");
}

async function addDivision(leagueId, { name, rank, strength }) {
  if (!name) throw badRequest("name is required");
  try {
    return await db.one(
      `INSERT INTO league_divisions (league_id, name, rank, strength)
       VALUES ($1, $2, COALESCE($3, (SELECT count(*) + 1 FROM league_divisions WHERE league_id = $1)), $4) RETURNING *`,
      [leagueId, name, rank ?? null, strength ?? null]);
  } catch (err) {
    if (err.code === "23503") throw notFound("league");
    return unique(err, "division");
  }
}

async function updateDivision(leagueId, id, { name, rank, strength }) {
  try {
    const d = await db.one(
      `UPDATE league_divisions SET name = COALESCE($3, name), rank = COALESCE($4, rank),
              strength = CASE WHEN $6 THEN $5::numeric ELSE strength END
        WHERE id = $2 AND league_id = $1 RETURNING *`,
      [leagueId, id, name ?? null, rank ?? null, strength ?? null, strength !== undefined]);
    if (!d) throw notFound("division");
    emitDomain("league.updated", { league_id: leagueId });
    return d;
  } catch (err) {
    return unique(err, "division");
  }
}

async function removeDivision(leagueId, id) {
  const used = await db.one("SELECT count(*)::int AS n FROM tournaments WHERE league_division_id = $1", [id]);
  if (used.n) throw conflict("this division has seasons; remove those first");
  const r = await db.query("DELETE FROM league_divisions WHERE id = $2 AND league_id = $1", [leagueId, id]);
  if (!r.rowCount) throw notFound("division");
}

async function addSeason(leagueId, { name, year, start_date: start, end_date: end }) {
  const n = name || (year ? String(year) : null);
  if (!n) throw badRequest("name or year is required");
  try {
    return await db.one(
      "INSERT INTO league_seasons (league_id, name, year, start_date, end_date) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [leagueId, n, year ?? null, start ?? null, end ?? null]);
  } catch (err) {
    if (err.code === "23503") throw notFound("league");
    return unique(err, "season");
  }
}

async function updateSeason(leagueId, id, fields) {
  const s = await db.one(
    `UPDATE league_seasons SET name = COALESCE($3, name), year = COALESCE($4, year),
            start_date = COALESCE($5, start_date), end_date = COALESCE($6, end_date)
      WHERE id = $2 AND league_id = $1 RETURNING *`,
    [leagueId, id, fields.name ?? null, fields.year ?? null, fields.start_date ?? null, fields.end_date ?? null]).catch((err) => unique(err, "season"));
  if (!s) throw notFound("season");
  return s;
}

async function removeSeason(leagueId, id) {
  const played = await db.one("SELECT count(*)::int AS n FROM games g JOIN tournaments t ON t.id = g.tournament_id WHERE t.league_season_id = $1 AND g.status <> 'scheduled'", [id]);
  if (played.n) throw conflict(`this season has ${played.n} played game${played.n === 1 ? "" : "s"}`);
  const r = await db.query("DELETE FROM league_seasons WHERE id = $2 AND league_id = $1", [leagueId, id]);
  if (!r.rowCount) throw notFound("season");
}

/**
 * Starts a division in a season: a competition with its teams (named, or
 * Team 1…N). Teams carry over between seasons by name (team format).
 */
async function addCompetition(leagueId, seasonId, divisionId, { num_teams: numTeams = 4, team_names: names = [], start_date: start, end_date: end, rules = {} }) {
  const [league, season, division] = await Promise.all([
    db.one("SELECT * FROM leagues WHERE id = $1", [leagueId]),
    db.one("SELECT * FROM league_seasons WHERE id = $1 AND league_id = $2", [seasonId, leagueId]),
    db.one("SELECT * FROM league_divisions WHERE id = $1 AND league_id = $2", [divisionId, leagueId]),
  ]);
  if (!league) throw notFound("league");
  if (!season) throw notFound("season");
  if (!division) throw notFound("division");
  const n = Math.max(2, Math.min(64, Number(numTeams) || 4));
  try {
    const t = await db.tx(async (c) => {
      const comp = (await c.query(
        `INSERT INTO tournaments (name, season, year, start_date, end_date, num_teams, format, kind, league_id, league_season_id, league_division_id,
                                 periods, period_length_sec, ot_length_sec, allow_ties)
         VALUES ($1, $2, $3, $4, $5, $6, 'team', 'league', $7, $8, $9,
                 COALESCE($10, 3), COALESCE($11, 1200), COALESCE($12, 300), COALESCE($13, FALSE)) RETURNING *`,
        [`${league.short_name || league.name} ${season.name} · ${division.name}`, season.name, season.year, start ?? season.start_date, end ?? season.end_date, n,
          league.id, season.id, division.id, rules.periods ?? null, rules.period_length_sec ?? null, rules.ot_length_sec ?? null, rules.allow_ties ?? null])).rows[0];
      for (let i = 1; i <= n; i++) {
        const name = String(names[i - 1] || "").trim().slice(0, 80) || `Team ${i}`;
        await c.query("INSERT INTO teams (tournament_id, name, seed) VALUES ($1, $2, $3)", [comp.id, name, i]);
      }
      return comp;
    });
    emitDomain("tournament.created", { tournament_id: t.id, tournament: t });
    return t;
  } catch (err) {
    if (err.code === "23505") throw conflict(`${division.name} already exists in ${season.name}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stats

/** The league's competitions (optionally one season / division) with their context. */
async function competitions(leagueId, { seasonId, divisionId } = {}) {
  return db.many(
    `SELECT t.id, t.name, s.id AS season_id, s.name AS season, s.year, s.start_date AS season_start, d.id AS division_id, d.name AS division, d.rank, d.strength
       FROM tournaments t JOIN league_seasons s ON s.id = t.league_season_id JOIN league_divisions d ON d.id = t.league_division_id
      WHERE t.league_id = $1 AND ($2::int IS NULL OR s.id = $2) AND ($3::int IS NULL OR d.id = $3)
      ORDER BY s.year NULLS FIRST, s.start_date NULLS FIRST, s.id, d.rank`,
    [leagueId, seasonId ?? null, divisionId ?? null]);
}

/**
 * Each player's lines in the league, one per competition (season + division)
 * with the team(s) they played for, plus totals. Shared by stats and ratings.
 */
async function playerLines(leagueId, filter = {}) {
  const comps = await competitions(leagueId, filter);
  const players = new Map();
  const get = (id) => {
    if (!players.has(id)) players.set(id, { player_id: id, skater: [], goalie: [] });
    return players.get(id);
  };
  for (const comp of comps) {
    const s = await data.tournamentStats(comp.id);
    const teamName = (id) => (s.teams.find((t) => t.id === id) || {}).name || null;
    const ctx = { competition_id: comp.id, season_id: comp.season_id, season: comp.season, year: comp.year, division_id: comp.division_id,
      division: comp.division, strength: strengthOf(comp) };
    for (const l of s.skaters) {
      get(l.player_id).skater.push({ ...ctx, teams: l.by_team.map((b) => teamName(b.team_id)).filter(Boolean),
        ...Object.fromEntries(SKATER_KEYS.map((k) => [k, l[k] || 0])) });
    }
    for (const l of s.goalies) {
      get(l.player_id).goalie.push({ ...ctx, teams: l.by_team.map((b) => teamName(b.team_id)).filter(Boolean),
        ...Object.fromEntries(GOALIE_KEYS.map((k) => [k, l[k] || 0])) });
    }
  }
  const ids = [...players.keys()];
  const names = new Map((ids.length ? await db.many(`SELECT ${data.PUBLIC_PLAYER_COLS}, p.player_code FROM players p WHERE p.id = ANY($1)`, [ids]) : []).map((p) => [p.id, p]));
  return { comps, players: [...players.values()].map((p) => {
    const n = names.get(p.player_id) || {};
    return { ...p, name: n.first_name ? `${n.first_name} ${n.last_name}` : `Player ${p.player_id}`, first_name: n.first_name, last_name: n.last_name,
      position: n.position ?? null, player_code: n.player_code ?? null };
  }) };
}

/** League stats for a season and/or division (or all-time in the league). */
async function stats(leagueId, filter = {}) {
  const { players } = await playerLines(leagueId, filter);
  const skaters = [];
  const goalies = [];
  for (const p of players) {
    if (p.skater.length) {
      const tot = zero(SKATER_KEYS);
      for (const l of p.skater) add(tot, l, SKATER_KEYS);
      skaters.push({ player_id: p.player_id, name: p.name, position: p.position, ...tot,
        teams: [...new Set(p.skater.flatMap((l) => l.teams))], divisions: [...new Set(p.skater.map((l) => l.division))], seasons: new Set(p.skater.map((l) => l.season_id)).size,
        lines: p.skater });
    }
    if (p.goalie.length) {
      const tot = zero(GOALIE_KEYS);
      for (const l of p.goalie) add(tot, l, GOALIE_KEYS);
      goalies.push({ player_id: p.player_id, name: p.name, ...goalieRates(tot),
        teams: [...new Set(p.goalie.flatMap((l) => l.teams))], divisions: [...new Set(p.goalie.map((l) => l.division))], lines: p.goalie.map(goalieRates) });
    }
  }
  skaters.sort((a, b) => b.points - a.points || b.goals - a.goals || a.gp - b.gp || a.name.localeCompare(b.name));
  goalies.sort((a, b) => b.gp - a.gp || (b.save_pct ?? 0) - (a.save_pct ?? 0));
  return { skaters, goalies };
}

/** One player in the league: every season / division / team, and their rating. */
async function player(leagueId, playerId) {
  const { players } = await playerLines(leagueId);
  const p = players.find((x) => x.player_id === playerId);
  if (!p) throw notFound("player in this league");
  const ratings = await require("./ratings").ratings(leagueId);
  return {
    player_id: p.player_id, name: p.name, position: p.position,
    skater: p.skater, goalie: p.goalie.map(goalieRates),
    rating: ratings.skaters.find((r) => r.player_id === playerId) || null,
    goalie_rating: ratings.goalies.find((r) => r.player_id === playerId) || null,
  };
}

/** Standings for every division in a season. */
async function standings(leagueId, seasonId) {
  const comps = await competitions(leagueId, { seasonId });
  return Promise.all(comps.map(async (c) => ({ competition_id: c.id, division_id: c.division_id, division: c.division, standings: (await data.tournamentStats(c.id)).standings })));
}

module.exports = {
  list, get, create, update, remove, addDivision, updateDivision, removeDivision, addSeason, updateSeason, removeSeason,
  addCompetition, competitions, playerLines, stats, player, standings, strengthOf,
};

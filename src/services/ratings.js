const db = require("../db");
const { notFound } = require("../lib/http");

// Player ratings (0-100) from production within a league.
//
// Skaters, per season-division line:
//   production = (goals x 1.00 + assists x 0.70 + short-handed goals x 0.30
//                 + game-winning goals x 0.20 + power-play goals x 0.10) / games
//   adjusted   = production x division strength (B 1.00, C 0.85, D 0.70 …)
// Lines are combined with weights = games x recency (the latest season counts
// 1.0, the one before 0.6, then 0.36 …). The result is pulled toward the
// league average by a few games' worth (so 2 great games don't top the
// list), then turned into a 0-100 percentile among the league's skaters:
// 80 = more production than 80% of them.
//
// Goalies are rated separately: save % above the league's, and goals against
// per game below it, adjusted the same way (division, recency, games).
//
// Every number used is returned, so a rating can always be explained.

const DEFAULTS = {
  goal: 1.0, assist: 0.7, shg: 0.3, gwg: 0.2, ppg: 0.1, pim: 0,
  recency_decay: 0.6, // weight of each older season relative to the next one
  skater_prior_games: 10, // games' worth of league-average production every skater starts with
  goalie_prior_games: 5,
  goalie_sv_weight: 0.7, // save % vs goals-against per game
  min_games: 3, // fewer games: not rated yet
};

function settingsOf(league) {
  const s = { ...DEFAULTS };
  for (const [k, v] of Object.entries(league.rating_settings || {})) if (k in DEFAULTS && Number.isFinite(Number(v))) s[k] = Number(v);
  return s;
}

const round = (n, p = 3) => (n == null ? null : Math.round(n * 10 ** p) / 10 ** p);

/** Percentile (0-100) of each value among all values; ties share the rating. */
function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (v) => {
    if (n === 1) return 50;
    let below = 0;
    let equal = 0;
    for (const x of sorted) {
      if (x < v - 1e-12) below += 1;
      else if (Math.abs(x - v) <= 1e-12) equal += 1;
    }
    return Math.round((100 * (below + (equal - 1) / 2)) / (n - 1));
  };
}

/** Season order (oldest first) for recency weights. */
function seasonAges(comps) {
  const order = [];
  for (const c of comps) if (!order.includes(c.season_id)) order.push(c.season_id);
  const latest = order.length - 1;
  return new Map(order.map((id, i) => [id, latest - i]));
}

/**
 * Ratings for a league. `seasonId` rates as of that season (later seasons
 * ignored); `divisionId` lists only players whose latest line is in that
 * division (they're still compared with the whole league).
 */
async function ratings(leagueId, { seasonId, divisionId } = {}) {
  const league = await db.one("SELECT * FROM leagues WHERE id = $1", [leagueId]);
  if (!league) throw notFound("league");
  const cfg = settingsOf(league);
  const { playerLines, competitions } = require("./leagues");
  let { comps, players } = await playerLines(leagueId);
  if (seasonId) {
    const all = await competitions(leagueId);
    const cutoff = all.findIndex((c) => c.season_id === seasonId);
    const keep = new Set(all.slice(0, all.map((c) => c.season_id).lastIndexOf(seasonId) + 1).map((c) => c.id));
    if (cutoff >= 0) {
      comps = comps.filter((c) => keep.has(c.id));
      players = players.map((p) => ({ ...p, skater: p.skater.filter((l) => keep.has(l.competition_id)), goalie: p.goalie.filter((l) => keep.has(l.competition_id)) }));
    }
  }
  const age = seasonAges(comps);
  const recency = (l) => cfg.recency_decay ** (age.get(l.season_id) || 0);

  // --- Skaters
  const skaterRows = [];
  for (const p of players) {
    const lines = p.skater.filter((l) => l.gp > 0);
    if (!lines.length) continue;
    const parts = lines.map((l) => {
      const raw = cfg.goal * l.goals + cfg.assist * l.assists + cfg.shg * l.shg + cfg.gwg * l.gwg + cfg.ppg * l.ppg - cfg.pim * l.pim;
      const perGame = raw / l.gp;
      const weight = l.gp * recency(l);
      return { season: l.season, season_id: l.season_id, division: l.division, division_id: l.division_id, teams: l.teams, gp: l.gp, goals: l.goals, assists: l.assists,
        points: l.points, production_per_game: round(perGame), strength: l.strength, adjusted_per_game: round(perGame * l.strength), recency: round(recency(l), 2), weight: round(weight, 2) };
    });
    const w = parts.reduce((a, x) => a + x.weight, 0);
    const value = w ? parts.reduce((a, x) => a + x.adjusted_per_game * x.weight, 0) / w : 0;
    const gp = parts.reduce((a, x) => a + x.gp, 0);
    skaterRows.push({ p, parts, weight: w, value, gp });
  }
  const leagueMean = skaterRows.length ? skaterRows.reduce((a, r) => a + r.value * r.weight, 0) / (skaterRows.reduce((a, r) => a + r.weight, 0) || 1) : 0;
  for (const r of skaterRows) r.score = (r.value * r.weight + leagueMean * cfg.skater_prior_games) / (r.weight + cfg.skater_prior_games);
  const eligible = skaterRows.filter((r) => r.gp >= cfg.min_games);
  const pct = percentiles(eligible.map((r) => r.score));
  const skaters = eligible.map((r) => ({
    player_id: r.p.player_id, name: r.p.name, position: r.p.position, rating: pct(r.score),
    score: round(r.score), production: round(r.value), league_average: round(leagueMean), gp: r.gp,
    confidence: r.weight >= 15 ? "high" : r.weight >= 6 ? "medium" : "low",
    latest_division: r.parts[r.parts.length - 1].division, latest_division_id: r.parts[r.parts.length - 1].division_id,
    breakdown: r.parts,
  }));

  // --- Goalies
  const goalieRows = [];
  for (const p of players) {
    const lines = p.goalie.filter((l) => l.gp > 0);
    if (!lines.length) continue;
    goalieRows.push({ p, lines });
  }
  const tot = goalieRows.flatMap((g) => g.lines).reduce((a, l) => ({ sa: a.sa + l.shots_against, ga: a.ga + l.goals_against, gp: a.gp + l.gp }), { sa: 0, ga: 0, gp: 0 });
  const lgSv = tot.sa ? (tot.sa - tot.ga) / tot.sa : 0.88;
  const lgGa = tot.gp ? tot.ga / tot.gp : 3;
  for (const g of goalieRows) {
    g.parts = g.lines.map((l) => {
      const sv = l.shots_against ? (l.shots_against - l.goals_against) / l.shots_against : lgSv;
      const gaPerGame = l.goals_against / l.gp;
      // Above-average save % (in points of %) and fewer goals per game; a
      // stronger division counts for more, a weaker one for less.
      const value = (cfg.goalie_sv_weight * (sv - lgSv) * 100 + (1 - cfg.goalie_sv_weight) * (lgGa - gaPerGame)) * l.strength + (l.strength - 1);
      return { season: l.season, season_id: l.season_id, division: l.division, division_id: l.division_id, teams: l.teams, gp: l.gp, save_pct: round(sv), goals_against_per_game: round(gaPerGame, 2),
        strength: l.strength, value: round(value), recency: round(recency(l), 2), weight: round(l.gp * recency(l), 2) };
    });
    g.weight = g.parts.reduce((a, x) => a + x.weight, 0);
    g.value = g.weight ? g.parts.reduce((a, x) => a + x.value * x.weight, 0) / g.weight : 0;
    g.score = (g.value * g.weight) / (g.weight + cfg.goalie_prior_games); // league average = 0
    g.gp = g.parts.reduce((a, x) => a + x.gp, 0);
  }
  const gEligible = goalieRows.filter((g) => g.gp >= cfg.min_games);
  const gpct = percentiles(gEligible.map((g) => g.score));
  const goalies = gEligible.map((g) => ({
    player_id: g.p.player_id, name: g.p.name, rating: gpct(g.score), score: round(g.score), gp: g.gp,
    league_save_pct: round(lgSv), league_goals_against_per_game: round(lgGa, 2),
    confidence: g.weight >= 12 ? "high" : g.weight >= 4 ? "medium" : "low",
    latest_division: g.parts[g.parts.length - 1].division, latest_division_id: g.parts[g.parts.length - 1].division_id,
    breakdown: g.parts,
  }));

  const byRating = (a, b) => b.rating - a.rating || b.score - a.score || a.name.localeCompare(b.name);
  const only = (r) => !divisionId || r.latest_division_id === divisionId;
  return {
    league: { id: league.id, name: league.name }, settings: cfg,
    skaters: skaters.filter(only).sort(byRating),
    goalies: goalies.filter(only).sort(byRating),
  };
}

/** Saves rating weights (only known keys, numbers). */
async function saveSettings(leagueId, input) {
  const clean = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in DEFAULTS)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < -5 || n > 50) continue;
    clean[k] = n;
  }
  const r = await db.one("UPDATE leagues SET rating_settings = $2 WHERE id = $1 RETURNING rating_settings", [leagueId, clean]);
  if (!r) throw notFound("league");
  return { ...DEFAULTS, ...r.rating_settings };
}

module.exports = { ratings, saveSettings, DEFAULTS, percentiles };

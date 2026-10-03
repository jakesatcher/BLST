const { Router } = require("express");
const config = require("../config");
const db = require("../db");
const { requireRole, assertTournamentScope } = require("../middleware/auth");
const { intParam, optEnum, notFound } = require("../lib/http");
const { toCsv } = require("../lib/csv");
const data = require("../services/data");
const importer = require("../services/importer");
const sources = require("../services/sources");
const historyImport = require("../services/historyImport");

const router = Router();
const admin = requireRole("admin");
const exportAccess = (req, res, next) => {
  if (req.params.id && req.path.startsWith("/export/tournaments/")) assertTournamentScope(req, req.params.id);
  return config.publicExports ? next() : requireRole("readonly")(req, res, next);
};

// ---------------------------------------------------------------------------
// Import

router.post("/import/historical", admin, async (req, res) => {
  const report = await importer.importHistorical(req.body);
  res.status(report.committed || report.dry_run ? 200 : 422).json(report);
});

/**
 * What a history source holds (file, pasted text, link): its columns, a
 * guess at what each one means, sample rows, and the seasons, divisions and
 * teams in it. Nothing is imported.
 */
router.post("/import/preview", admin, async (req, res) => {
  res.json(await sources.preview(req.body.source, { sheet: req.body.sheet, mapping: req.body.mapping }));
});

/** Imports history from any source with a column mapping, into a tournament or a league (see historyImport.js). */
router.post("/import/history", admin, async (req, res) => {
  const out = await historyImport.run(req.body);
  const ok = out.groups.some((g) => g.committed) || req.body.dry_run;
  res.status(ok ? 200 : 422).json(out);
});

/** What an upload's Tournament ID (city + type + year) points at, before uploading. */
router.get("/import/tournament-id", admin, async (req, res) => {
  const target = await importer.uploadTarget({ city: req.query.city, series: req.query.series, year: req.query.year });
  const t = target.existing;
  const stats = t ? await db.one(
    `SELECT (SELECT count(*) FROM historical_stats WHERE tournament_id = $1)::int AS rows,
            (SELECT count(*) FROM games WHERE tournament_id = $1 AND status <> 'scheduled')::int AS games`, [t.id]) : null;
  res.json({ code: target.code, tournament: t ? { id: t.id, name: t.name, imported: t.imported, uploaded_rows: stats.rows, scored_games: stats.games } : null });
});

router.post("/import/roster/:tournamentId", admin, async (req, res) => {
  const report = await importer.importRoster(intParam(req.params.tournamentId, "tournamentId"), req.body);
  res.status(report.committed || report.dry_run ? 200 : 422).json(report);
});

router.get("/import/batches", admin, async (_req, res) => {
  res.json(
    await db.many(
      `SELECT h.import_batch, h.source, count(*) AS rows, min(h.created_at) AS imported_at,
              string_agg(DISTINCT coalesce(t.code, t.name), ', ') AS tournament
         FROM historical_stats h LEFT JOIN tournaments t ON t.id = h.tournament_id
        GROUP BY h.import_batch, h.source ORDER BY min(h.created_at) DESC`,
    ),
  );
});

router.delete("/import/batches/:batch", admin, async (req, res) => {
  const touched = (await db.many("SELECT DISTINCT tournament_id FROM historical_stats WHERE import_batch = $1 AND tournament_id IS NOT NULL", [req.params.batch])).map((x) => x.tournament_id);
  const r = await db.query("DELETE FROM historical_stats WHERE import_batch = $1", [req.params.batch]);
  // Imported tournaments left with no stats (and never played in BLST) go too.
  await db.query(
    `DELETE FROM tournaments t WHERE t.imported AND (t.import_batch = $1 OR t.id = ANY($2))
        AND NOT EXISTS (SELECT 1 FROM games g WHERE g.tournament_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM historical_stats h WHERE h.tournament_id = t.id)`, [req.params.batch, touched]);
  require("../lib/bus").emitDomain("history.deleted", { batch: req.params.batch });
  if (!r.rowCount) throw notFound("import batch");
  res.json({ deleted: r.rowCount });
});

// ---------------------------------------------------------------------------
// Export — stable, documented shapes for other applications. Everything
// here also exists as ?format=csv for spreadsheets.

const SKATER_COLUMNS = [
  "player_id", "name", "first_name", "last_name", "jersey_number", "position", "team", "gp", "goals", "assists", "points",
  "plus_minus", "pim", "ppg", "ppa", "shg", "sha", "gwg", "eng", "shots", "shooting_pct", "missed_shots", "hits", "blocks",
  "fow", "fol", "faceoff_pct", "giveaways", "takeaways", "penalties_drawn", "points_per_game",
];
const GOALIE_COLUMNS = [
  "player_id", "name", "first_name", "last_name", "jersey_number", "team", "gp", "toi_sec", "wins", "losses", "ot_losses",
  "ties", "shots_against", "goals_against", "saves", "save_pct", "gaa", "shutouts", "pim",
];
const STANDINGS_COLUMNS = ["rank", "team_id", "name", "gp", "w", "l", "otl", "t", "pts", "gf", "ga", "diff", "pim", "streak"];
const GAME_COLUMNS = [
  "id", "scheduled_at", "venue", "game_type", "status", "home_team_id", "home_team", "away_team_id", "away_team",
  "home_score", "away_score", "decision",
];

function send(req, res, filename, payload, rows, columns) {
  const format = optEnum(req.query.format, "format", ["json", "csv"]) || "json";
  if (format === "csv") {
    res.set("content-type", "text/csv; charset=utf-8");
    res.set("content-disposition", `attachment; filename="${filename}.csv"`);
    return res.send(toCsv(rows, columns));
  }
  res.json(payload);
}

function exportMeta(t) {
  return { exported_at: new Date().toISOString(), schema_version: 1, tournament: { id: t.id, name: t.name, season: t.season } };
}

function gameRows(s) {
  const teamName = new Map(s.teams.map((t) => [t.id, t.name]));
  return s.games.map((g) => ({
    ...Object.fromEntries(GAME_COLUMNS.map((c) => [c, g[c]])),
    home_team: teamName.get(g.home_team_id),
    away_team: teamName.get(g.away_team_id),
  }));
}

router.get("/export/tournaments/:id", exportAccess, async (req, res) => {
  const s = await data.tournamentStats(intParam(req.params.id));
  const t = s.tournament;
  const roster = await db.many(
    `SELECT re.team_id, re.jersey_number, COALESCE(re.position, p.position) AS position, re.role, re.draft_round, re.draft_pick,
            ${data.PUBLIC_PLAYER_COLS}
       FROM roster_entries re JOIN players p ON p.id = re.player_id WHERE re.tournament_id = $1`,
    [t.id],
  );
  send(req, res, `tournament-${t.id}-skaters`, {
    ...exportMeta(t),
    tournament: {
      id: t.id, name: t.name, season: t.season, location: t.location, start_date: t.start_date, end_date: t.end_date,
      status: t.status, periods: t.periods, period_length_sec: t.period_length_sec, ot_length_sec: t.ot_length_sec,
    },
    teams: s.teams.map((team) => ({
      id: team.id, name: team.name, short_name: team.short_name, color: team.color, seed: team.seed,
      final_placement: team.final_placement, external_id: team.external_id,
      logo_url: team.logo_version ? `/api/v1/teams/${team.id}/logo?v=${team.logo_version}` : null,
      roster: roster.filter((r) => r.team_id === team.id),
    })),
    standings: s.standings,
    games: gameRows(s),
    skaters: s.skaters,
    goalies: s.goalies,
  }, s.skaters, SKATER_COLUMNS);
});

router.get("/export/tournaments/:id/skaters", exportAccess, async (req, res) => {
  const s = await data.tournamentStats(intParam(req.params.id));
  send(req, res, `tournament-${s.tournament.id}-skaters`, { ...exportMeta(s.tournament), skaters: s.skaters }, s.skaters, SKATER_COLUMNS);
});

router.get("/export/tournaments/:id/goalies", exportAccess, async (req, res) => {
  const s = await data.tournamentStats(intParam(req.params.id));
  send(req, res, `tournament-${s.tournament.id}-goalies`, { ...exportMeta(s.tournament), goalies: s.goalies }, s.goalies, GOALIE_COLUMNS);
});

router.get("/export/tournaments/:id/standings", exportAccess, async (req, res) => {
  const s = await data.tournamentStats(intParam(req.params.id));
  send(req, res, `tournament-${s.tournament.id}-standings`, { ...exportMeta(s.tournament), standings: s.standings }, s.standings, STANDINGS_COLUMNS);
});

router.get("/export/tournaments/:id/games", exportAccess, async (req, res) => {
  const s = await data.tournamentStats(intParam(req.params.id));
  const rows = gameRows(s);
  send(req, res, `tournament-${s.tournament.id}-games`, { ...exportMeta(s.tournament), games: rows }, rows, GAME_COLUMNS);
});

router.get("/export/games/:id", exportAccess, async (req, res) => {
  const snap = await data.gameSnapshot(intParam(req.params.id));
  const rows = snap.events.map((e) => ({
    id: e.id, period: e.period_label, time: e.time, type: e.type, team_id: e.team_id,
    player: e.player?.name, assists: (e.assists || []).map((a) => a.name).join("; "), strength: e.strength,
    empty_net: e.empty_net, infraction: e.infraction, penalty_minutes: e.penalty_minutes, result: e.result,
  }));
  send(req, res, `game-${snap.game.id}-events`, { exported_at: new Date().toISOString(), schema_version: 1, ...snap }, rows,
    ["id", "period", "time", "type", "team_id", "player", "assists", "strength", "empty_net", "infraction", "penalty_minutes", "result"]);
});

router.get("/export/players/:id", exportAccess, async (req, res) => {
  const career = await data.playerCareer(intParam(req.params.id));
  const rows = [
    ...career.history.map((h) => ({ source: "historical", season: h.season, event: h.event_name, team: h.team_name, gp: h.gp,
      goals: h.goals, assists: h.assists, points: h.goals + h.assists, pim: h.pim, plus_minus: h.plus_minus })),
    ...career.tournaments.filter((l) => l.skater).map((l) => ({ source: "blst", season: l.season, event: l.tournament,
      team: l.roster?.team_name, gp: l.skater.gp, goals: l.skater.goals, assists: l.skater.assists, points: l.skater.points,
      pim: l.skater.pim, plus_minus: l.skater.plus_minus })),
  ];
  send(req, res, `player-${career.player.id}-career`, { exported_at: new Date().toISOString(), schema_version: 1, ...career }, rows,
    ["source", "season", "event", "team", "gp", "goals", "assists", "points", "pim", "plus_minus"]);
});

router.get("/export/players", exportAccess, async (req, res) => {
  const rows = await db.many(`SELECT ${data.PUBLIC_PLAYER_COLS} FROM players p ORDER BY lower(p.last_name), lower(p.first_name)`);
  send(req, res, "players", { exported_at: new Date().toISOString(), schema_version: 1, players: rows }, rows,
    ["id", "first_name", "last_name", "position", "shoots", "preferred_number", "external_id"]);
});

module.exports = router;

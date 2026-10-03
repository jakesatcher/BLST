const db = require("../db");
const sources = require("./sources");
const importer = require("./importer");
const leagues = require("./leagues");
const { badRequest, notFound } = require("../lib/http");
const { emitDomain } = require("../lib/bus");

// Historical stats from any source (see sources.js) into:
//   { kind: "tournament", city, series, year }  a tournament by its Tournament ID
//   { kind: "tournament", tournament_id }       an existing tournament or league division-season
//   { kind: "league", league_id, season?, division? }
//       one file can hold many seasons and divisions (season and division
//       columns); each season-division becomes that league's competition
//       (seasons, divisions and competitions are added when missing).
//       `season` / `division` fill in for rows that don't say.
// Each competition's upload is checked like any other: stats for the same
// season-division can't be added twice unless `replace` is set.

const tidy = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
/** "C", "C League", "Division C", "div. c" → "c" */
const divisionKey = (v) => tidy(v).toLowerCase().replace(/\b(division|div\.?|league|level|tier|flight)\b/g, "").replace(/[^a-z0-9+]+/g, " ").trim();
const seasonKey = (v) => tidy(v).toLowerCase();
const yearOf = (v) => {
  const m = /(19|20)\d{2}/.exec(String(v));
  return m ? Number(m[0]) : null;
};

async function run(body) {
  const target = body.target || {};
  const loaded = await sources.load(body.source, { sheet: body.sheet });
  const mapping = sources.cleanMapping(body.mapping && Object.keys(body.mapping).length ? body.mapping : sources.guessMapping(loaded.columns), loaded.columns);
  const rows = sources.applyMapping(loaded.records, mapping);
  if (!rows.length) throw badRequest("no rows to import");
  const common = {
    replace: Boolean(body.replace), dry_run: Boolean(body.dry_run), skip_errors: Boolean(body.skip_errors),
    create_missing_players: body.create_missing_players !== false, source: `import:${String(loaded.label).slice(0, 80)}`,
  };
  if (target.kind === "league") return leagueImport(Number(target.league_id), rows, { ...common, season: target.season, division: target.division });
  const report = await importer.importHistorical({
    ...common, rows, tournament_id: target.tournament_id || undefined, city: target.city, series: target.series, year: target.year,
    format: target.format,
  });
  return { kind: "tournament", groups: [{ ...report, label: report.tournament ? report.tournament.code || report.tournament.name : "" }] };
}

/** Finds or (unless dry-run) adds a league's season for a file value. */
async function seasonFor(league, value, created, dryRun) {
  const seasons = await db.many("SELECT * FROM league_seasons WHERE league_id = $1", [league.id]);
  const y = yearOf(value);
  const found = seasons.find((s) => seasonKey(s.name) === seasonKey(value)) || (y && String(value).trim() === String(y) && seasons.find((s) => s.year === y && seasonKey(s.name).includes(String(y))));
  if (found) return { season: found, isNew: false };
  if (dryRun) return { season: { id: null, name: tidy(value), year: y }, isNew: true };
  const s = await leagues.addSeason(league.id, { name: tidy(value).slice(0, 40), year: y });
  created.seasons.push(s.id);
  return { season: s, isNew: true };
}

async function divisionFor(league, value, created, dryRun) {
  const divisions = await db.many("SELECT * FROM league_divisions WHERE league_id = $1 ORDER BY rank", [league.id]);
  const key = divisionKey(value);
  const found = divisions.find((d) => divisionKey(d.name) === key || String(d.id) === String(value));
  if (found) return { division: found, isNew: false };
  // "C League" → division "C".
  const name = (key ? tidy(value).replace(/\b(division|div\.?|league|level|tier|flight)\b/gi, "").trim() : tidy(value)) || tidy(value);
  if (dryRun) return { division: { id: null, name }, isNew: true };
  const d = await leagues.addDivision(league.id, { name: name.slice(0, 40) });
  created.divisions.push(d.id);
  return { division: d, isNew: true };
}

async function leagueImport(leagueId, rows, opts) {
  const league = await db.one("SELECT * FROM leagues WHERE id = $1", [leagueId]);
  if (!league) throw notFound("league");
  // Group rows by season and division (file values, or the defaults chosen).
  const groups = new Map();
  const missing = { season: 0, division: 0 };
  for (const r of rows) {
    const season = tidy(r.season) || tidy(opts.season);
    const division = tidy(r.division) || tidy(opts.division);
    if (!season) missing.season += 1;
    if (!division) missing.division += 1;
    if (!season || !division) continue;
    const k = `${seasonKey(season)}\u0000${divisionKey(division) || division.toLowerCase()}`;
    if (!groups.has(k)) groups.set(k, { season, division, rows: [] });
    groups.get(k).rows.push(r);
  }
  if (missing.season) throw badRequest(`${missing.season} row${missing.season === 1 ? " has" : "s have"} no season: map the season column, or choose the season they're from`);
  if (missing.division) throw badRequest(`${missing.division} row${missing.division === 1 ? " has" : "s have"} no division: map the division column, or choose the division they're from`);
  if (groups.size > 200) throw badRequest("more than 200 season-divisions in one file; split it up");

  const created = { seasons: [], divisions: [], competitions: [] };
  const out = [];
  // Oldest seasons first, then by division.
  const ordered = [...groups.values()].sort((a, b) => (yearOf(a.season) || 0) - (yearOf(b.season) || 0) || a.season.localeCompare(b.season) || a.division.localeCompare(b.division));
  for (const g of ordered) {
    const label = `${g.season} · ${g.division}`;
    try {
      const { season, isNew: newSeason } = await seasonFor(league, g.season, created, opts.dry_run);
      const { division, isNew: newDivision } = await divisionFor(league, g.division, created, opts.dry_run);
      let comp = season.id && division.id
        ? await db.one("SELECT * FROM tournaments WHERE league_season_id = $1 AND league_division_id = $2", [season.id, division.id]) : null;
      const teams = [...new Set(g.rows.map((r) => tidy(r.team_name)).filter(Boolean))];
      if (!comp && opts.dry_run) {
        out.push({ label, season: season.name, division: division.name, rows: g.rows.length, new_season: newSeason, new_division: newDivision, new_competition: true,
          teams: teams.length, dry_run: true, committed: false, imported: g.rows.length, errors: [] });
        continue;
      }
      let newComp = false;
      if (!comp) {
        comp = await leagues.addCompetition(league.id, season.id, division.id, { num_teams: Math.max(2, Math.min(64, teams.length || 2)), team_names: teams });
        await db.query("UPDATE tournaments SET imported = TRUE, status = 'completed' WHERE id = $1", [comp.id]);
        created.competitions.push(comp.id);
        newComp = true;
      }
      const report = await importer.importHistorical({ ...opts, rows: g.rows, tournament_id: comp.id, season: undefined, division: undefined });
      if (newComp && !report.committed) {
        // Nothing went in: don't leave an empty competition behind.
        await db.query("DELETE FROM tournaments WHERE id = $1", [comp.id]);
      }
      out.push({ ...report, label, season: season.name, division: division.name, competition_id: report.committed ? comp.id : newComp ? null : comp.id,
        new_season: newSeason, new_division: newDivision, new_competition: newComp });
    } catch (err) {
      out.push({ label, season: g.season, division: g.division, rows: g.rows.length, committed: false, imported: 0, errors: [{ row: null, error: err.message }],
        duplicate: Boolean(err.details && err.details.duplicate), status: err.status || 500 });
    }
  }
  // Seasons and divisions added for groups that all failed come back out.
  for (const id of created.seasons) {
    const used = await db.one("SELECT count(*)::int AS n FROM tournaments WHERE league_season_id = $1", [id]);
    if (!used.n) await db.query("DELETE FROM league_seasons WHERE id = $1", [id]);
  }
  for (const id of created.divisions) {
    const used = await db.one("SELECT count(*)::int AS n FROM tournaments WHERE league_division_id = $1", [id]);
    if (!used.n) await db.query("DELETE FROM league_divisions WHERE id = $1", [id]);
  }
  if (out.some((g) => g.committed)) emitDomain("history.imported", { league_id: league.id });
  return {
    kind: "league", league_id: league.id, dry_run: Boolean(opts.dry_run),
    totals: {
      groups: out.length, committed: out.filter((g) => g.committed).length, rows: rows.length,
      imported: out.reduce((a, g) => a + (g.committed || g.dry_run ? g.imported || 0 : 0), 0),
      created_players: out.reduce((a, g) => a + (g.committed ? g.created_players || 0 : 0), 0),
      failed: out.filter((g) => !g.committed && !g.dry_run).length,
    },
    groups: out,
  };
}

module.exports = { run, divisionKey };

const db = require("../db");
const { csvToObjects, normalizeHeader } = require("../lib/csv");
const { badRequest } = require("../lib/http");
const { emitDomain } = require("../lib/bus");

// Imports accept either CSV text or an array of JSON objects. Column names
// are matched loosely (case, spacing and common abbreviations), so exports
// from most stat sites and spreadsheets load without renaming headers.

const HISTORY_ALIASES = {
  season: ["season", "year"],
  event_name: ["event_name", "event", "tournament", "league"],
  team_name: ["team_name", "team", "tm"],
  gp: ["gp", "games_played", "games"],
  goals: ["g", "goals"],
  assists: ["a", "assists"],
  pim: ["pim", "penalty_minutes"],
  plus_minus: ["plus_minus", "pm"],
  ppg: ["ppg", "pp_goals", "power_play_goals"],
  ppa: ["ppa", "pp_assists", "power_play_assists"],
  shg: ["shg", "sh_goals", "shorthanded_goals"],
  sha: ["sha", "sh_assists", "shorthanded_assists"],
  gwg: ["gwg", "game_winning_goals"],
  shots: ["sog", "shots", "s", "shots_on_goal"],
  hits: ["hits", "hit"],
  blocks: ["blk", "blocks", "blocked_shots", "bks"],
  fow: ["fow", "faceoffs_won", "fo_won"],
  fol: ["fol", "faceoffs_lost", "fo_lost"],
  goalie_gp: ["goalie_gp", "gpi", "gp_g", "goalie_games"],
  wins: ["w", "wins"],
  losses: ["l", "losses"],
  ot_losses: ["otl", "ot_losses", "ot", "sol"],
  ties: ["t", "ties"],
  shots_against: ["sa", "shots_against"],
  goals_against: ["ga", "goals_against"],
  saves: ["sv", "saves"],
  shutouts: ["so", "shutouts"],
  toi_sec: ["toi_sec", "seconds"],
  toi_min: ["min", "mins", "minutes", "toi"],
};

const INT_FIELDS = [
  "gp", "goals", "assists", "pim", "plus_minus", "ppg", "ppa", "shg", "sha", "gwg", "shots", "hits", "blocks", "fow", "fol",
  "goalie_gp", "wins", "losses", "ot_losses", "ties", "shots_against", "goals_against", "shutouts", "toi_sec",
];

function rowsFrom(body) {
  if (Array.isArray(body.rows)) {
    return body.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [normalizeHeader(k), v == null ? "" : String(v).trim()])));
  }
  if (typeof body.csv === "string") return csvToObjects(body.csv);
  throw badRequest("provide rows (array of objects) or csv (string)");
}

function pick(row, aliases) {
  for (const a of aliases) if (row[a] !== undefined && row[a] !== "") return row[a];
  return undefined;
}

function toInt(value, field) {
  if (value === undefined) return 0;
  const n = Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new Error(`${field} is not a number: "${value}"`);
  return Math.round(n);
}

function parseMinutes(value) {
  const s = String(value).trim();
  const mmss = /^(\d+):([0-5]\d)$/.exec(s);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`minutes is not a number: "${value}"`);
  return Math.round(n * 60);
}

function splitName(row) {
  let first = pick(row, ["first_name", "first", "firstname", "given_name"]);
  let last = pick(row, ["last_name", "last", "lastname", "surname", "family_name"]);
  const full = pick(row, ["name", "player", "player_name", "full_name"]);
  if ((!first || !last) && full) {
    if (full.includes(",")) [last, first] = full.split(",").map((x) => x.trim());
    else {
      const parts = full.split(/\s+/);
      first = parts.shift();
      last = parts.join(" ");
    }
  }
  return { first: first || null, last: last || null };
}

/**
 * Finds a player by (in order) id, external_id, email, then exact name.
 * Creates one when allowed and nothing matched.
 */
async function resolvePlayer(c, row, { create, report }) {
  const id = pick(row, ["player_id", "blst_id"]);
  if (id) {
    const r = await c.query("SELECT * FROM players WHERE id = $1", [Number(id)]);
    if (!r.rowCount) throw new Error(`no player with id ${id}`);
    return r.rows[0];
  }
  const ext = pick(row, ["external_id", "ext_id"]);
  if (ext) {
    const r = await c.query("SELECT * FROM players WHERE external_id = $1", [ext]);
    if (r.rowCount) return r.rows[0];
  }
  const email = pick(row, ["email", "e_mail", "email_address"]);
  if (email) {
    const r = await c.query("SELECT * FROM players WHERE lower(email) = lower($1)", [email]);
    if (r.rowCount) return r.rows[0];
  }
  const { first, last } = splitName(row);
  if (!first || !last) throw new Error("row needs a player name (first_name + last_name, or name), player_id, external_id or email");
  const byName = await c.query("SELECT * FROM players WHERE lower(first_name) = lower($1) AND lower(last_name) = lower($2)", [first, last]);
  if (byName.rowCount > 1) throw new Error(`more than one player named ${first} ${last}; add external_id or email to disambiguate`);
  if (byName.rowCount) return byName.rows[0];
  if (!create) throw new Error(`player ${first} ${last} not found`);
  const position = normalizePosition(pick(row, ["position", "pos"]));
  const created = await c.query(
    `INSERT INTO players (first_name, last_name, email, external_id, position, shoots, preferred_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [first, last, email ? email.toLowerCase() : null, ext || null, position, normalizeShoots(pick(row, ["shoots", "hand"])),
      numberOrNull(pick(row, ["number", "no", "jersey", "jersey_number", "num"]))],
  );
  report.created_players += 1;
  return created.rows[0];
}

function normalizePosition(v) {
  if (!v) return null;
  const s = v.trim().toUpperCase();
  const map = { G: "G", GOALIE: "G", GK: "G", D: "D", DEF: "D", DEFENSE: "D", DEFENCE: "D", LD: "D", RD: "D",
    C: "C", CENTER: "C", CENTRE: "C", LW: "LW", RW: "RW", W: "F", F: "F", FWD: "F", FORWARD: "F" };
  if (!map[s]) throw new Error(`unknown position "${v}"`);
  return map[s];
}

function normalizeShoots(v) {
  if (!v) return null;
  const s = v.trim().toUpperCase()[0];
  return s === "L" || s === "R" ? s : null;
}

function numberOrNull(v) {
  if (v === undefined || v === "") return null;
  const n = Number(String(v).replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error(`jersey number must be 0-99, got "${v}"`);
  return n;
}

/**
 * Runs `perRow` for each row inside one transaction with a savepoint per
 * row. Bad rows are collected; unless skip_errors is set, any bad row rolls
 * the whole import back so a half-applied file never happens. dry_run
 * always rolls back.
 */
async function runImport(body, perRow) {
  const rows = rowsFrom(body);
  if (!rows.length) throw badRequest("no rows to import");
  if (rows.length > 20000) throw badRequest("too many rows (max 20000 per import)");
  const dryRun = Boolean(body.dry_run);
  const skipErrors = Boolean(body.skip_errors);
  const report = { rows: rows.length, imported: 0, created_players: 0, created_teams: 0, moved: 0, errors: [], dry_run: dryRun };
  const client = await db.getPool().connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < rows.length; i++) {
      await client.query("SAVEPOINT row");
      const counters = { created_players: report.created_players, created_teams: report.created_teams, moved: report.moved };
      try {
        await perRow(client, rows[i], report);
        await client.query("RELEASE SAVEPOINT row");
        report.imported += 1;
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT row");
        Object.assign(report, counters);
        report.errors.push({ row: i + 2, error: friendly(err) });
      }
    }
    const abort = dryRun || (report.errors.length > 0 && !skipErrors);
    await client.query(abort ? "ROLLBACK" : "COMMIT");
    report.committed = !abort;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return report;
}

function friendly(err) {
  if (err.code === "23505" && err.constraint === "roster_team_number_uniq") return "jersey number already taken on that team";
  if (err.code === "23505") return "duplicate value";
  return err.message;
}

/** Imports prior-season / prior-event stat lines into historical_stats. */
async function importHistorical(body) {
  const batch = body.batch || `import-${new Date().toISOString()}`;
  const create = body.create_missing_players !== false;
  const report = await runImport(body, async (c, row, rep) => {
    const player = await resolvePlayer(c, row, { create, report: rep });
    const v = {};
    for (const [field, aliases] of Object.entries(HISTORY_ALIASES)) v[field] = pick(row, aliases);
    const line = {};
    for (const f of INT_FIELDS) line[f] = toInt(v[f], f);
    if (v.toi_sec === undefined && v.toi_min !== undefined) line.toi_sec = parseMinutes(v.toi_min);
    const isGoalie = normalizePosition(pick(row, ["position", "pos"])) === "G" || player.position === "G";
    if (isGoalie && v.goalie_gp === undefined && v.gp !== undefined) {
      line.goalie_gp = line.gp;
      line.gp = 0;
    }
    if (v.shots_against === undefined && v.saves !== undefined) line.shots_against = toInt(v.saves, "saves") + line.goals_against;
    const cols = ["player_id", "season", "event_name", "team_name", ...INT_FIELDS, "source", "import_batch"];
    const vals = [player.id, v.season ?? null, v.event_name ?? null, v.team_name ?? null, ...INT_FIELDS.map((f) => line[f]),
      body.source || "import", batch];
    await c.query(`INSERT INTO historical_stats (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  });
  report.batch = batch;
  return report;
}

/**
 * Imports a tournament roster: creates/updates players, creates teams by
 * name when allowed, and assigns jersey numbers. Re-importing moves
 * players whose team changed (logged as roster moves).
 */
async function importRoster(tournamentId, body) {
  const t = await db.one("SELECT * FROM tournaments WHERE id = $1", [tournamentId]);
  if (!t) throw badRequest("tournament not found");
  const createTeams = Boolean(body.create_missing_teams);
  const report = await runImport(body, async (c, row, rep) => {
    const player = await resolvePlayer(c, row, { create: true, report: rep });
    const teamRef = pick(row, ["team", "team_name", "team_id"]);
    if (!teamRef) throw new Error("row needs a team");
    let team = (await c.query(
      "SELECT * FROM teams WHERE tournament_id = $1 AND (lower(name) = lower($2) OR lower(short_name) = lower($2) OR id::text = $2)",
      [tournamentId, teamRef],
    )).rows[0];
    if (!team) {
      if (!createTeams) throw new Error(`no team "${teamRef}" in this tournament`);
      team = (await c.query("INSERT INTO teams (tournament_id, name) VALUES ($1, $2) RETURNING *", [tournamentId, teamRef])).rows[0];
      rep.created_teams += 1;
    }
    const number = numberOrNull(pick(row, ["number", "no", "jersey", "jersey_number", "num"]));
    const position = normalizePosition(pick(row, ["position", "pos"]));
    const role = (pick(row, ["role", "captain", "letter"]) || "").toUpperCase().slice(0, 1) || null;
    const email = pick(row, ["email", "e_mail", "email_address"]);
    if (email && !player.email) await c.query("UPDATE players SET email = lower($2) WHERE id = $1", [player.id, email]);
    const existing = (await c.query("SELECT * FROM roster_entries WHERE tournament_id = $1 AND player_id = $2", [tournamentId, player.id])).rows[0];
    if (existing) {
      await c.query(
        "UPDATE roster_entries SET team_id = $2, jersey_number = $3, position = COALESCE($4, position), role = $5 WHERE id = $1",
        [existing.id, team.id, number, position, role === "C" || role === "A" ? role : null],
      );
      if (existing.team_id !== team.id) {
        await c.query(
          "INSERT INTO roster_moves (tournament_id, player_id, from_team_id, to_team_id, jersey_number, reason) VALUES ($1, $2, $3, $4, $5, 'roster import')",
          [tournamentId, player.id, existing.team_id, team.id, number],
        );
        rep.moved += 1;
      }
    } else {
      await c.query(
        "INSERT INTO roster_entries (tournament_id, team_id, player_id, jersey_number, position, role) VALUES ($1, $2, $3, $4, $5, $6)",
        [tournamentId, team.id, player.id, number, position, role === "C" || role === "A" ? role : null],
      );
    }
  });
  if (report.committed) emitDomain("roster.imported", { tournament_id: tournamentId, rows: report.imported });
  return report;
}

module.exports = { importHistorical, importRoster, splitName, parseMinutes };

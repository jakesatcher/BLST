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

/** Rows from a JSON array or CSV text, with normalized column names. */
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
  // Registration / player codes are the most reliable identifiers.
  const regCode = pick(row, ["registration_code", "reg_code", "registration", "code"]);
  if (regCode) {
    const r = await c.query(
      "SELECT p.* FROM tournament_registrations tr JOIN players p ON p.id = tr.player_id WHERE upper(tr.registration_code) = upper($1)",
      [regCode],
    );
    if (!r.rowCount) throw new Error(`no registration with code ${regCode}`);
    return r.rows[0];
  }
  const playerCode = pick(row, ["player_code", "blst_player_code"]);
  if (playerCode) {
    const r = await c.query("SELECT * FROM players WHERE upper(player_code) = upper($1)", [playerCode]);
    if (!r.rowCount) throw new Error(`no player with code ${playerCode}`);
    return r.rows[0];
  }
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
  return { ...created.rows[0], __created: true };
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
async function runImport(body, perRow, finish) {
  const rows = rowsFrom(body);
  if (!rows.length) throw badRequest("no rows to import");
  if (rows.length > 20000) throw badRequest("too many rows (max 20000 per import)");
  const dryRun = Boolean(body.dry_run);
  const skipErrors = Boolean(body.skip_errors);
  const report = { rows: rows.length, imported: 0, created_players: 0, created_teams: 0, moved: 0, errors: [], dry_run: dryRun };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < rows.length; i++) {
      await client.query("SAVEPOINT row");
      const counters = { created_players: report.created_players, created_teams: report.created_teams, moved: report.moved };
      try {
        const outcome = await perRow(client, rows[i], report, i + 2);
        await client.query("RELEASE SAVEPOINT row");
        if (outcome === "skip") report.skipped_blank = (report.skipped_blank || 0) + 1;
        else if (outcome === "unassigned") report.unassigned_count = (report.unassigned_count || 0) + 1;
        else report.imported += 1;
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT row");
        Object.assign(report, counters);
        report.errors.push({ row: i + 2, error: friendly(err) });
      }
    }
    if (finish) await finish(client, report);
    report.errors.sort((a, b) => a.row - b.row);
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

/**
 * The tournament (and team) an imported line belongs to. With
 * `tournament_id` every row goes to that tournament; otherwise rows with an
 * event name join the tournament with that name and season, which is
 * created (marked imported, completed) when it doesn't exist. Teams are
 * found or created by name inside it.
 */
async function importTarget(c, body, v, report, batch) {
  let tournamentId = body.tournament_id ? Number(body.tournament_id) : null;
  if (tournamentId) {
    const t = (await c.query("SELECT id, name, season FROM tournaments WHERE id = $1", [tournamentId])).rows[0];
    if (!t) throw new Error(`tournament ${tournamentId} not found`);
    report.tournaments[t.id] = report.tournaments[t.id] || { id: t.id, name: t.name, season: t.season, created: false };
  } else if (body.link_tournaments !== false && v.event_name) {
    const name = String(v.event_name).slice(0, 120);
    const season = v.season ? String(v.season).slice(0, 40) : null;
    let t = (await c.query(
      "SELECT id, name, season FROM tournaments WHERE lower(name) = lower($1) AND coalesce(lower(season), '') = coalesce(lower($2), '') ORDER BY id LIMIT 1",
      [name, season])).rows[0];
    let created = false;
    if (!t) {
      t = (await c.query(
        `INSERT INTO tournaments (name, season, status, imported, import_batch, format, num_teams)
         VALUES ($1, $2, 'completed', TRUE, $3, $4, 2) RETURNING id, name, season`,
        [name, season, batch, body.format === "team" || body.club_teams ? "team" : "draft"])).rows[0];
      created = true;
    }
    tournamentId = t.id;
    report.tournaments[t.id] = report.tournaments[t.id] || { id: t.id, name: t.name, season: t.season, created };
  }
  if (!tournamentId) return { tournamentId: null, teamId: null };
  let teamId = null;
  if (v.team_name) {
    const tn = String(v.team_name).slice(0, 80);
    const found = (await c.query("SELECT id FROM teams WHERE tournament_id = $1 AND blst_team_key(name) = blst_team_key($2) LIMIT 1", [tournamentId, tn])).rows[0];
    teamId = found ? found.id : (await c.query("INSERT INTO teams (tournament_id, name) VALUES ($1, $2) RETURNING id", [tournamentId, tn])).rows[0].id;
    // Imported tournaments' team count follows the teams in the file.
    await c.query(
      `UPDATE tournaments SET num_teams = GREATEST(2, LEAST(64, (SELECT count(*) FROM teams WHERE tournament_id = $1)))
        WHERE id = $1 AND imported`, [tournamentId]);
  }
  return { tournamentId, teamId };
}

/**
 * Imports prior-season / prior-event stat lines. Lines that name an event
 * (or with `tournament_id`) are kept with that tournament, so it has its own
 * stats page, and count toward players' and teams' all-time totals through it.
 */
async function importHistorical(body) {
  const batch = body.batch || `import-${new Date().toISOString()}`;
  const create = body.create_missing_players !== false;
  const tournaments = {};
  const report = await runImport(body, async (c, row, rep) => {
    rep.tournaments = tournaments;
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
    // Team tournaments (or the box ticked): the team name is a team that carries over.
    if ((body.club_teams || body.format === "team") && v.team_name) {
      await c.query("INSERT INTO clubs (name) VALUES ($1) ON CONFLICT (org_id, name_key) DO NOTHING", [String(v.team_name).slice(0, 80)]);
    }
    const target = await importTarget(c, body, v, rep, batch);
    const cols = ["player_id", "season", "event_name", "team_name", ...INT_FIELDS, "source", "import_batch", "tournament_id", "team_id"];
    const vals = [player.id, v.season ?? null, v.event_name ?? null, v.team_name ?? null, ...INT_FIELDS.map((f) => line[f]),
      body.source || "import", batch, target.tournamentId, target.teamId];
    await c.query(`INSERT INTO historical_stats (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  });
  report.batch = batch;
  report.tournaments = Object.values(tournaments);
  return report;
}

const TEAM_ALIASES = ["team", "team_name", "team_id", "drafted_by", "draft_team", "drafting_team", "drafted_to", "new_team"];
const NUMBER_ALIASES = ["number", "no", "jersey", "jersey_number", "jersey_no", "num", "sweater", "sweater_number"];

/**
 * Imports a tournament roster, typically the results of the draft: one row
 * per player with team, jersey number and optionally position, captaincy,
 * email and draft round/pick.
 *
 * Two passes so number swaps work (A takes #9 from B, B takes #12): pass 1
 * places every player on their team without a number, pass 2 hands out the
 * numbers. With `replace: true`, anyone on this tournament's rosters who
 * isn't in the file comes off their team (between the passes, so their
 * numbers are free). Re-importing moves players whose team changed and
 * logs it as a roster move. Rows with only a team filled in (the blank
 * lines of the downloadable template) are skipped.
 *
 * The report always includes a per-row `preview`, so a dry run shows
 * exactly what will happen before anything is saved.
 */
async function importRoster(tournamentId, body) {
  const t = await db.one("SELECT * FROM tournaments WHERE id = $1", [tournamentId]);
  if (!t) throw badRequest("tournament not found");
  const createTeams = Boolean(body.create_missing_teams);
  const replace = Boolean(body.replace);
  const planned = [];
  const seenPlayer = new Map();
  const seenNumber = new Map();
  const preview = [];

  const perRow = async (c, row, rep, rowNum) => {
    const { first, last } = splitName(row);
    const hasPlayer = first || last || pick(row, ["email", "e_mail", "email_address", "external_id", "player_id", "registration_code", "reg_code", "player_code"]);
    if (!hasPlayer) return "skip";
    // On the pre-filled draft sheet, players nobody drafted have no team:
    // list them rather than failing the upload.
    if (!pick(row, TEAM_ALIASES)) {
      rep.unassigned = rep.unassigned || [];
      rep.unassigned.push({ row: rowNum, name: [first, last].filter(Boolean).join(" ") || pick(row, ["registration_code", "reg_code", "player_code"]) });
      return "unassigned";
    }

    const player = await resolvePlayer(c, row, { create: true, report: rep });
    const playerName = `${player.first_name} ${player.last_name}`;
    if (seenPlayer.has(player.id)) throw new Error(`${playerName} is also on row ${seenPlayer.get(player.id)}`);
    seenPlayer.set(player.id, rowNum);

    const teamRef = pick(row, TEAM_ALIASES);
    if (!teamRef) throw new Error(`${playerName}: no team given`);
    let team = (await c.query(
      "SELECT * FROM teams WHERE tournament_id = $1 AND (lower(name) = lower($2) OR lower(short_name) = lower($2) OR id::text = $2)",
      [tournamentId, teamRef],
    )).rows[0];
    let newTeam = false;
    if (!team) {
      if (!createTeams) throw new Error(`${playerName}: there's no team called "${teamRef}" (tick "create teams that don't exist", or fix the name)`);
      team = (await c.query("INSERT INTO teams (tournament_id, name, seed) VALUES ($1, $2, (SELECT count(*) + 1 FROM teams WHERE tournament_id = $1)) RETURNING *", [tournamentId, teamRef])).rows[0];
      rep.created_teams += 1;
      newTeam = true;
    }

    const number = numberOrNull(pick(row, NUMBER_ALIASES));
    if (number != null) {
      const key = `${team.id}:${number}`;
      if (seenNumber.has(key)) throw new Error(`#${number} on ${team.name} is also given to ${seenNumber.get(key).name} (row ${seenNumber.get(key).row})`);
      seenNumber.set(key, { name: playerName, row: rowNum });
    }
    const position = normalizePosition(pick(row, ["position", "pos"]));
    const role = parseRole(row);
    const round = optionalInt(pick(row, ["round", "rd", "draft_round"]), "round");
    const overall = optionalInt(pick(row, ["pick", "overall", "overall_pick", "draft_pick", "pick_no", "selection"]), "pick");
    const email = pick(row, ["email", "e_mail", "email_address"]);
    if (email && !player.email) await c.query("UPDATE players SET email = lower($2) WHERE id = $1", [player.id, email]);

    const existing = (await c.query("SELECT * FROM roster_entries WHERE tournament_id = $1 AND player_id = $2", [tournamentId, player.id])).rows[0];
    let change;
    let entryId;
    if (existing) {
      const same = existing.team_id === team.id && existing.jersey_number === number && (position == null || existing.position === position) &&
        existing.role === role && existing.draft_round === round && existing.draft_pick === overall;
      change = existing.team_id !== team.id ? "moved" : same ? "unchanged" : "updated";
      await c.query(
        `UPDATE roster_entries SET team_id = $2, jersey_number = NULL, position = COALESCE($3, position), role = $4,
                draft_round = $5, draft_pick = $6 WHERE id = $1`,
        [existing.id, team.id, position, role, round, overall],
      );
      entryId = existing.id;
      if (existing.team_id !== team.id) {
        await c.query(
          "INSERT INTO roster_moves (tournament_id, player_id, from_team_id, to_team_id, jersey_number, reason) VALUES ($1, $2, $3, $4, $5, $6)",
          [tournamentId, player.id, existing.team_id, team.id, number, body.reason || "roster upload"],
        );
        rep.moved += 1;
      }
    } else {
      change = "added";
      entryId = (await c.query(
        `INSERT INTO roster_entries (tournament_id, team_id, player_id, jersey_number, position, role, draft_round, draft_pick)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7) RETURNING id`,
        [tournamentId, team.id, player.id, position, role, round, overall],
      )).rows[0].id;
    }
    planned.push({ entryId, number, rowNum, playerName, team });
    preview.push({
      row: rowNum, player_id: player.id, name: playerName, new_player: player.__created === true,
      team_id: team.id, team: team.name, new_team: newTeam, number, position: position ?? existing?.position ?? player.position ?? null,
      role, draft_round: round, draft_pick: overall, change,
    });
  };

  const finish = async (c, rep) => {
    // Players not in the file come off their teams before numbers are handed out.
    // ...but never when some rows failed: a typo'd name must not knock that
    // player off their team.
    if (replace && rep.errors.length) rep.replace_skipped = true;
    else if (replace) {
      const keep = [...seenPlayer.keys()];
      const removed = (await c.query(
        `DELETE FROM roster_entries re USING players p, teams tm
          WHERE re.tournament_id = $1 AND p.id = re.player_id AND tm.id = re.team_id AND NOT (re.player_id = ANY($2::int[]))
          RETURNING p.first_name, p.last_name, tm.name AS team, re.jersey_number`,
        [tournamentId, keep],
      )).rows;
      rep.removed = removed.map((r) => ({ name: `${r.first_name} ${r.last_name}`, team: r.team, number: r.jersey_number }));
    }
    for (const p of planned) {
      if (p.number == null) continue;
      await c.query("SAVEPOINT num");
      try {
        const holder = (await c.query(
          `SELECT p.first_name, p.last_name FROM roster_entries re JOIN players p ON p.id = re.player_id
            WHERE re.team_id = $1 AND re.jersey_number = $2 AND re.id <> $3`,
          [p.team.id, p.number, p.entryId],
        )).rows[0];
        if (holder) throw new Error(`#${p.number} on ${p.team.name} is already worn by ${holder.first_name} ${holder.last_name}, who isn't in this file. Change one of the numbers, or tick "replace current rosters"`);
        await c.query("UPDATE roster_entries SET jersey_number = $2 WHERE id = $1", [p.entryId, p.number]);
        await c.query("RELEASE SAVEPOINT num");
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT num");
        rep.errors.push({ row: p.rowNum, error: `${p.playerName}: ${friendly(err)}` });
        const pv = preview.find((x) => x.row === p.rowNum);
        if (pv) pv.number_error = true;
      }
    }
    rep.preview = preview.slice(0, 2000);
    const teams = await c.query(
      `SELECT tm.id, tm.name, tm.logo_version, tm.color, count(re.id)::int AS players FROM teams tm LEFT JOIN roster_entries re ON re.team_id = tm.id
        WHERE tm.tournament_id = $1 GROUP BY tm.id ORDER BY tm.seed NULLS LAST, tm.name`,
      [tournamentId],
    );
    rep.teams = teams.rows;
  };

  const report = await runImport(body, perRow, finish);
  report.replace = replace;
  if (report.committed) emitDomain("roster.imported", { tournament_id: tournamentId, rows: report.imported });
  return report;
}

function parseRole(row) {
  const v = (pick(row, ["role", "letter", "c_a"]) || "").trim().toUpperCase();
  if (v.startsWith("C")) return "C";
  if (v.startsWith("A")) return "A";
  const captain = (pick(row, ["captain", "is_captain"]) || "").trim().toLowerCase();
  if (["y", "yes", "true", "x", "1", "c"].includes(captain)) return "C";
  if (captain === "a") return "A";
  return null;
}

function optionalInt(v, name) {
  if (v === undefined || v === "") return null;
  const n = Number(String(v).replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got "${v}"`);
  return n;
}

/** CSV of the tournament's rosters in the upload format (the template when empty). */
async function rosterCsv(tournamentId, { template = false } = {}) {
  const teams = await db.many("SELECT * FROM teams WHERE tournament_id = $1 ORDER BY seed NULLS LAST, name", [tournamentId]);
  const rows = template ? [] : await db.many(
    `SELECT tm.name AS team, re.jersey_number AS number, p.first_name, p.last_name, COALESCE(re.position, p.position) AS position,
            re.role, p.email, re.draft_round AS round, re.draft_pick AS pick, tr.registration_code, p.external_id
       FROM roster_entries re JOIN players p ON p.id = re.player_id JOIN teams tm ON tm.id = re.team_id
       LEFT JOIN tournament_registrations tr ON tr.player_id = p.id AND tr.tournament_id = re.tournament_id
      WHERE re.tournament_id = $1 ORDER BY tm.seed NULLS LAST, tm.name, re.jersey_number NULLS LAST, p.last_name`,
    [tournamentId],
  );
  // The template is the draft sheet: every registered player not yet on a
  // team (with their registration code), plus a blank line per team.
  let out = rows;
  if (!rows.length) {
    const registered = await db.many(
      `SELECT '' AS team, p.first_name, p.last_name, p.position, p.email, tr.registration_code
         FROM tournament_registrations tr JOIN players p ON p.id = tr.player_id
        WHERE tr.tournament_id = $1 AND tr.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM roster_entries re WHERE re.player_id = p.id AND re.tournament_id = tr.tournament_id)
        ORDER BY p.last_name, p.first_name`,
      [tournamentId],
    );
    out = [...registered, ...teams.map((tm) => ({ team: tm.name }))];
  }
  const { toCsv } = require("../lib/csv");
  return toCsv(out, ["team", "number", "first_name", "last_name", "position", "role", "email", "round", "pick", "registration_code", "external_id"]);
}

module.exports = { rowsFrom, importHistorical, importRoster, rosterCsv, splitName, parseMinutes };

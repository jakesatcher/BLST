const db = require("../db");
const { badRequest, conflict, notFound } = require("../lib/http");
const { emitDomain } = require("../lib/bus");

// Registrations tie a person (players row, permanent player_code) to a
// tournament with a per-tournament registration code (e.g. FALL26-0042).
// Every registration goes through matchPlayer() so a returning player is
// linked to the record that already holds their history.

/** Same normalization as the SQL blst_name_key(): lowercase, no accents/punctuation. */
function nameKey(first, last) {
  return `${first || ""} ${last || ""}`
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const firstKey = (first) => nameKey(first, "");

function cleanEmail(e) {
  if (!e) return null;
  const s = String(e).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

function cleanDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // US m/d/yyyy (LeagueApps reports)
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (/^\d{10,13}$/.test(s)) return new Date(Number(s.length === 10 ? Number(s) * 1000 : s)).toISOString().slice(0, 10);
  return null;
}

const dateStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d || null);

/**
 * Finds the existing player this person is, or decides they're new.
 *
 * Strong matches (linked automatically): LeagueApps user id, external id,
 * email when the first name also agrees (parents register several kids
 * under one email), name + birth date. A unique name-only match with no
 * conflicting identifiers is linked but flagged for review; several
 * possible matches create a new player flagged for review with the
 * candidates listed, so nobody's stats get merged by guesswork.
 */
async function matchPlayer(c, person) {
  const q = (sql, params) => c.query(sql, params).then((r) => r.rows);
  const conflicts = (p) =>
    (person.leagueapps_user_id && p.leagueapps_user_id && String(p.leagueapps_user_id) !== String(person.leagueapps_user_id)) ||
    (person.birth_date && p.birth_date && dateStr(p.birth_date) !== person.birth_date);

  if (person.leagueapps_user_id) {
    const [p] = await q("SELECT * FROM players WHERE leagueapps_user_id = $1", [person.leagueapps_user_id]);
    if (p) return { player: p, method: "leagueapps_user_id" };
  }
  if (person.external_id) {
    const [p] = await q("SELECT * FROM players WHERE external_id = $1", [person.external_id]);
    if (p && !conflicts(p)) return { player: p, method: "external_id" };
  }
  if (person.email) {
    const rows = await q("SELECT * FROM players WHERE lower(email) = $1", [person.email]);
    const p = rows.find((r) => firstKey(r.first_name) === firstKey(person.first_name) && !conflicts(r));
    if (p) return { player: p, method: "email" };
  }
  const key = nameKey(person.first_name, person.last_name);
  const sameName = key ? await q("SELECT * FROM players WHERE name_key = $1 ORDER BY id", [key]) : [];
  if (person.birth_date) {
    const p = sameName.find((r) => dateStr(r.birth_date) === person.birth_date);
    if (p && !conflicts(p)) return { player: p, method: "name_birth_date" };
  }
  const possible = sameName.filter((r) => !conflicts(r));
  if (possible.length === 1) {
    return { player: possible[0], method: "name", needsReview: true, note: "Matched on name only: confirm this is the same person." };
  }
  // No exact name: imported players (no email) with the same last name and
  // a nickname or initial ("Mike" / "Michael", "J." / "John") are flagged
  // for an admin to confirm under Admin → History → Match players.
  let similar = [];
  if (!possible.length && key) {
    const { firstNameMatch } = require("./history");
    const [first, ...rest] = key.split(" ");
    const sameLast = await q("SELECT * FROM players WHERE email IS NULL AND name_key LIKE $1 ORDER BY id", [`% ${rest.join(" ")}`]);
    similar = sameLast.filter((r) => r.name_key.split(" ").slice(1).join(" ") === rest.join(" ") && firstNameMatch(first, r.name_key.split(" ")[0]) && !conflicts(r));
  }
  const maybe = possible.length > 1 ? possible : similar;
  return {
    player: null,
    method: "new",
    needsReview: maybe.length > 0,
    note: possible.length > 1 ? `Possible duplicates: ${possible.map((p) => p.player_code).join(", ")}`
      : similar.length ? `May be the same person as ${similar.map((p) => `${p.first_name} ${p.last_name} (${p.player_code})`).join(", ")} from imported history` : null,
    candidates: maybe.map((p) => p.id),
  };
}

/** Fills identifiers the existing record is missing (never overwrites). */
async function enrichPlayer(c, player, person) {
  await c.query(
    `UPDATE players SET email = COALESCE(email, $2), birth_date = COALESCE(birth_date, $3),
            leagueapps_user_id = COALESCE(leagueapps_user_id, $4), updated_at = now()
      WHERE id = $1`,
    [player.id, person.email && !(await emailTaken(c, person.email, player.id)) ? person.email : null, person.birth_date, person.leagueapps_user_id],
  );
}

async function emailTaken(c, email, exceptId) {
  const r = await c.query("SELECT 1 FROM players WHERE lower(email) = $1 AND id <> $2", [email, exceptId]);
  return r.rowCount > 0;
}

async function createPlayer(c, person) {
  const email = person.email && !(await emailTaken(c, person.email, 0)) ? person.email : null;
  return (await c.query(
    `INSERT INTO players (first_name, last_name, email, birth_date, leagueapps_user_id, external_id, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [person.first_name, person.last_name, email, person.birth_date, person.leagueapps_user_id || null, person.external_id || null, person.position || null],
  )).rows[0];
}

/**
 * What the player already has: imported historical stat lines and other
 * tournaments (registered, rostered or played in).
 */
async function playerHistory(c, playerId, exceptTournamentId = 0) {
  const r = await c.query(
    `SELECT
       (SELECT count(*) FROM historical_stats WHERE player_id = $1)::int AS historical_lines,
       (SELECT coalesce(sum(gp + goalie_gp), 0) FROM historical_stats WHERE player_id = $1)::int AS historical_gp,
       (SELECT coalesce(sum(goals + assists), 0) FROM historical_stats WHERE player_id = $1)::int AS historical_points,
       (SELECT count(DISTINCT t) FROM (
          SELECT tournament_id AS t FROM tournament_registrations WHERE player_id = $1 AND status <> 'cancelled'
          UNION SELECT tournament_id FROM roster_entries WHERE player_id = $1
          UNION SELECT g.tournament_id FROM game_rosters gr JOIN games g ON g.id = gr.game_id WHERE gr.player_id = $1
        ) x WHERE t <> $2)::int AS prior_tournaments`,
    [playerId, exceptTournamentId],
  );
  const h = r.rows[0];
  return { ...h, has_history: h.historical_lines > 0 || h.prior_tournaments > 0 };
}

/** Short tournament prefix for registration codes, e.g. "Fall Classic 2026" -> FC26. */
function derivePrefix(t) {
  const year = (t.season && /\d{2,4}/.exec(t.season)?.[0]) || (t.start_date ? String(t.start_date).slice(0, 4) : String(new Date().getFullYear()));
  const words = t.name.replace(/\d+/g, " ").split(/[^A-Za-z]+/).filter(Boolean);
  const letters = (words.length > 1 ? words.map((w) => w[0]) : [words[0] || "T"]).join("").toUpperCase().slice(0, 6);
  return `${letters}${year.slice(-2)}`;
}

async function ensurePrefix(c, t) {
  if (t.registration_prefix) return t.registration_prefix;
  let prefix = derivePrefix(t);
  const taken = await c.query("SELECT 1 FROM tournaments WHERE registration_prefix = $1 AND id <> $2", [prefix, t.id]);
  if (taken.rowCount) prefix = `${prefix}T${t.id}`;
  await c.query("UPDATE tournaments SET registration_prefix = $2 WHERE id = $1 AND registration_prefix IS NULL", [t.id, prefix]);
  return (await c.query("SELECT registration_prefix FROM tournaments WHERE id = $1", [t.id])).rows[0].registration_prefix;
}

async function nextCode(c, t) {
  const prefix = await ensurePrefix(c, t);
  const seq = (await c.query("UPDATE tournaments SET registration_seq = registration_seq + 1 WHERE id = $1 RETURNING registration_seq", [t.id])).rows[0].registration_seq;
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

function normalizePerson(input) {
  const person = {
    first_name: (input.first_name || "").trim(),
    last_name: (input.last_name || "").trim(),
    email: cleanEmail(input.email),
    birth_date: cleanDate(input.birth_date),
    leagueapps_user_id: input.leagueapps_user_id != null && /^\d+$/.test(String(input.leagueapps_user_id)) ? String(input.leagueapps_user_id) : null,
    external_id: input.external_id ? String(input.external_id).trim().slice(0, 100) : null,
    position: input.position || null,
  };
  if (!person.first_name || !person.last_name) throw badRequest("first and last name are required");
  if (person.first_name.length > 60 || person.last_name.length > 60) throw badRequest("name is too long");
  return person;
}

/**
 * Creates or updates one registration (inside transaction `c`). Idempotent
 * per LeagueApps registration id and per (tournament, player): re-syncing
 * keeps the existing code.
 */
async function upsertRegistration(c, tournament, input, meta = {}) {
  const person = normalizePerson(input);
  const status = ["active", "waitlist", "cancelled"].includes(meta.status) ? meta.status : "active";

  // Already have this exact LeagueApps registration? Update status only.
  if (meta.leagueapps_registration_id) {
    const existing = (await c.query("SELECT * FROM tournament_registrations WHERE leagueapps_registration_id = $1", [meta.leagueapps_registration_id])).rows[0];
    if (existing) {
      const row = (await c.query(
        `UPDATE tournament_registrations SET status = $2, program_name = COALESCE($3, program_name), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [existing.id, status, meta.program_name || null],
      )).rows[0];
      return { registration: row, created: false, updated: existing.status !== status };
    }
  }

  const match = await matchPlayer(c, person);
  const player = match.player || (await createPlayer(c, person));
  if (match.player) await enrichPlayer(c, player, person);
  const history = await playerHistory(c, player.id, tournament.id);

  const current = (await c.query("SELECT * FROM tournament_registrations WHERE tournament_id = $1 AND player_id = $2", [tournament.id, player.id])).rows[0];
  if (current) {
    const row = (await c.query(
      `UPDATE tournament_registrations SET status = $2, leagueapps_registration_id = COALESCE($3, leagueapps_registration_id),
              leagueapps_program_id = COALESCE($4, leagueapps_program_id), program_name = COALESCE($5, program_name),
              prior_tournaments = $6, has_history = $7, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [current.id, status, meta.leagueapps_registration_id || null, meta.leagueapps_program_id || null, meta.program_name || null,
        history.prior_tournaments, history.has_history],
    )).rows[0];
    return { registration: row, created: false, updated: true, player, match, history };
  }

  const code = await nextCode(c, tournament);
  const row = (await c.query(
    `INSERT INTO tournament_registrations
       (tournament_id, player_id, registration_code, status, source, leagueapps_registration_id, leagueapps_program_id, program_name,
        match_method, needs_review, review_note, prior_tournaments, has_history, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [tournament.id, player.id, code, status, meta.source || "manual", meta.leagueapps_registration_id || null, meta.leagueapps_program_id || null,
      meta.program_name || null, match.method, Boolean(match.needsReview), match.note || null, history.prior_tournaments, history.has_history,
      meta.registered_at || new Date()],
  )).rows[0];
  return { registration: row, created: true, player, match, history };
}

async function registerOne(tournamentId, input, meta) {
  const result = await db.tx(async (c) => {
    const t = (await c.query("SELECT * FROM tournaments WHERE id = $1 FOR UPDATE", [tournamentId])).rows[0];
    if (!t) throw notFound("tournament");
    return upsertRegistration(c, t, input, meta);
  });
  emitDomain("registration.created", { tournament_id: tournamentId, registration_code: result.registration.registration_code });
  return result;
}

/** Registrations for a tournament with the player's history and team. */
async function listRegistrations(tournamentId, { status, review } = {}) {
  const params = [tournamentId];
  let where = "r.tournament_id = $1";
  if (status) {
    params.push(status);
    where += ` AND r.status = $${params.length}`;
  }
  if (review === true) where += " AND r.needs_review";
  return db.many(
    `SELECT r.*, p.first_name, p.last_name, p.email, p.birth_date, p.player_code, p.leagueapps_user_id, p.position,
            tm.name AS team, re.jersey_number,
            (SELECT count(*) FROM historical_stats h WHERE h.player_id = p.id)::int AS historical_lines,
            (SELECT coalesce(sum(h.gp + h.goalie_gp), 0) FROM historical_stats h WHERE h.player_id = p.id)::int AS historical_gp
       FROM tournament_registrations r JOIN players p ON p.id = r.player_id
       LEFT JOIN roster_entries re ON re.player_id = p.id AND re.tournament_id = r.tournament_id
       LEFT JOIN teams tm ON tm.id = re.team_id
      WHERE ${where} ORDER BY r.needs_review DESC, r.registration_code`,
    params,
  );
}

/** Check-in / lookup: a registration code (or player code) -> the person and all their history. */
async function lookup(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c || c.length > 40) throw badRequest("enter a registration or player code");
  const reg = await db.one("SELECT * FROM tournament_registrations WHERE upper(registration_code) = $1", [c]);
  const player = await db.one("SELECT * FROM players WHERE id = $1 OR upper(player_code) = $2", [reg ? reg.player_id : 0, c]);
  if (!player) throw notFound("registration or player code");
  const [registrations, history, tournaments] = await Promise.all([
    db.many(
      `SELECT r.registration_code, r.status, r.tournament_id, t.name AS tournament, t.season, tm.name AS team, re.jersey_number
         FROM tournament_registrations r JOIN tournaments t ON t.id = r.tournament_id
         LEFT JOIN roster_entries re ON re.player_id = r.player_id AND re.tournament_id = r.tournament_id
         LEFT JOIN teams tm ON tm.id = re.team_id
        WHERE r.player_id = $1 ORDER BY r.created_at`,
      [player.id],
    ),
    db.many("SELECT season, event_name, team_name, gp, goals, assists, pim, goalie_gp, wins, losses, shutouts FROM historical_stats WHERE player_id = $1 ORDER BY season NULLS FIRST", [player.id]),
    playerHistory(db, player.id, reg ? reg.tournament_id : 0),
  ]);
  return { registration: reg, player, registrations, historical_stats: history, summary: tournaments };
}

/**
 * Merges a duplicate player into the one to keep: registrations, rosters,
 * game lineups, events, history and moves all move over, then the
 * duplicate is deleted. Refuses if both were in the same tournament.
 */
async function mergePlayers(keepId, removeId) {
  if (keepId === removeId) throw badRequest("pick two different players");
  return db.tx(async (c) => {
    const [keep, remove] = await Promise.all([keepId, removeId].map((id) => c.query("SELECT * FROM players WHERE id = $1 FOR UPDATE", [id]).then((r) => r.rows[0])));
    if (!keep || !remove) throw notFound("player");
    const clash = await c.query(
      `SELECT t.name FROM tournaments t WHERE t.id IN (
         SELECT tournament_id FROM tournament_registrations WHERE player_id = $1 UNION SELECT tournament_id FROM roster_entries WHERE player_id = $1)
       AND t.id IN (
         SELECT tournament_id FROM tournament_registrations WHERE player_id = $2 UNION SELECT tournament_id FROM roster_entries WHERE player_id = $2)`,
      [keepId, removeId],
    );
    if (clash.rowCount) throw conflict(`both players are in ${clash.rows.map((r) => r.name).join(", ")}; remove one of those entries first`);
    const games = await c.query("SELECT 1 FROM game_rosters a JOIN game_rosters b ON a.game_id = b.game_id WHERE a.player_id = $1 AND b.player_id = $2", [keepId, removeId]);
    if (games.rowCount) throw conflict("both players appear in the same game");

    await c.query("UPDATE tournament_registrations SET player_id = $1, needs_review = FALSE, updated_at = now() WHERE player_id = $2", [keepId, removeId]);
    await c.query("UPDATE roster_entries SET player_id = $1 WHERE player_id = $2", [keepId, removeId]);
    await c.query("UPDATE roster_moves SET player_id = $1 WHERE player_id = $2", [keepId, removeId]);
    await c.query("UPDATE game_rosters SET player_id = $1 WHERE player_id = $2", [keepId, removeId]);
    await c.query("UPDATE historical_stats SET player_id = $1 WHERE player_id = $2", [keepId, removeId]);
    for (const col of ["player_id", "assist1_id", "assist2_id", "secondary_player_id", "goalie_id"]) {
      await c.query(`UPDATE game_events SET ${col} = $1 WHERE ${col} = $2`, [keepId, removeId]);
    }
    await c.query("UPDATE games SET home_goalie_id = $1 WHERE home_goalie_id = $2", [keepId, removeId]);
    await c.query("UPDATE games SET away_goalie_id = $1 WHERE away_goalie_id = $2", [keepId, removeId]);
    for (const col of ["email", "leagueapps_user_id", "external_id", "factions_player_id"]) {
      if (remove[col] != null && keep[col] == null) {
        await c.query(`UPDATE players SET ${col} = NULL WHERE id = $1`, [removeId]);
        await c.query(`UPDATE players SET ${col} = $2 WHERE id = $1`, [keepId, remove[col]]);
      }
    }
    await c.query(
      `UPDATE players SET birth_date = COALESCE(birth_date, $2), position = COALESCE(position, $3), shoots = COALESCE(shoots, $4),
              preferred_number = COALESCE(preferred_number, $5), factions_order = COALESCE(factions_order, $6), updated_at = now() WHERE id = $1`,
      [keepId, remove.birth_date, remove.position, remove.shoots, remove.preferred_number, remove.factions_order],
    );
    await c.query("DELETE FROM players WHERE id = $1", [removeId]);
    // Refresh history flags on the merged player's registrations.
    const regs = (await c.query("SELECT id, tournament_id FROM tournament_registrations WHERE player_id = $1", [keepId])).rows;
    for (const r of regs) {
      const h = await playerHistory(c, keepId, r.tournament_id);
      await c.query("UPDATE tournament_registrations SET prior_tournaments = $2, has_history = $3 WHERE id = $1", [r.id, h.prior_tournaments, h.has_history]);
    }
    return (await c.query("SELECT * FROM players WHERE id = $1", [keepId])).rows[0];
  });
}

module.exports = {
  nameKey, cleanEmail, cleanDate, derivePrefix, normalizePerson, matchPlayer, playerHistory, upsertRegistration,
  registerOne, listRegistrations, lookup, mergePlayers,
};

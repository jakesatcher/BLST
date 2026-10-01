const crypto = require("crypto");
const db = require("../db");
const { bus, emitDomain } = require("../lib/bus");
const { HttpError, badRequest, conflict, notFound } = require("../lib/http");
const { csvToObjects } = require("../lib/csv");
const data = require("./data");

// BLPA Factions (Original Draft Society), built into BLST.
//
//   Order        one of six, for life, derived from the member's email
//   member       one person (keyed by email); every BLST player with an
//                email is one automatically (database trigger, 008_factions.sql)
//   event        usually a BLST tournament ("link" creates it)
//   participation  a member's points and placement at one event
//   achievement  a one-off award, unique per member and code
//   bonus points manual awards outside any event
//
// A member's Order total = bonus points + every event's points.
// Order assignment and member ids are identical to the standalone Factions
// app (and are computed by the database, see ORDERS below for the formula).

/** Fixed order: the hash bucket indexes into it. Append only. */
const ORDERS = [
  { slug: "varghona", name: "Varghona", animal: "wolf" },
  { slug: "tuskarium", name: "Tuskarium", animal: "elephant" },
  { slug: "aetherwing", name: "Aetherwing", animal: "eagle" },
  { slug: "serikon", name: "Serikon", animal: "snake" },
  { slug: "thalkara", name: "Thalkara", animal: "kraken" },
  { slug: "ursonne", name: "Ursonne", animal: "bear" },
];
const ORDER_BY_SLUG = new Map(ORDERS.map((o) => [o.slug, o]));

const normalizeEmail = (e) => String(e).trim().toLowerCase();
/** SHA-256 of the normalized email, first 4 bytes (uint32 BE) mod 6. */
const assignOrder = (email) => ORDERS[crypto.createHash("sha256").update(normalizeEmail(email)).digest().readUInt32BE(0) % ORDERS.length].slug;
/** base64url of the normalized email: reversible, so private like the email. */
const memberId = (email) => Buffer.from(normalizeEmail(email), "utf8").toString("base64url");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

const autoAward = () => !/^(0|false|no|off)$/i.test(process.env.FACTIONS_AUTO_AWARD ?? process.env.FACTIONS_AUTO_SYNC ?? "true");

// ---------------------------------------------------------------------------
// Members

/**
 * Finds the member for an email or creates one, assigning their Order the
 * first time the email is seen. An existing member's Order never changes
 * (the database refuses it). Name and LeagueApps id are updated if given.
 */
async function getOrCreateMember({ email, display_name: name, leagueapps_user_id: laId, source = "admin" }, c = db) {
  if (!email || !EMAIL_RE.test(String(email).trim())) throw badRequest("a valid email is required");
  try {
    const { rows } = await c.query(
      `INSERT INTO faction_members (id, email, display_name, leagueapps_user_id, order_slug, source)
       VALUES (blst_faction_member_id($1), blst_norm_email($1), $2, $3, blst_faction_order($1), $4)
       ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, faction_members.display_name),
              leagueapps_user_id = COALESCE(EXCLUDED.leagueapps_user_id, faction_members.leagueapps_user_id)
       RETURNING *, (xmax = 0) AS created`,
      [String(email), name ? String(name).trim().slice(0, 120) || null : null, laId ? String(laId) : null, source],
    );
    const { created, ...member } = rows[0];
    return { member, created };
  } catch (err) {
    if (err.code === "23505") throw conflict("that LeagueApps user id already belongs to another member");
    throw err;
  }
}

const MEMBER_TOTALS = `
  m.*, o.name AS order_name, o.animal AS order_animal,
  COALESCE((SELECT sum(points_earned) FROM faction_participation fp WHERE fp.member_id = m.id), 0)::int AS event_points,
  (SELECT count(*) FROM faction_participation fp WHERE fp.member_id = m.id)::int AS events,
  (SELECT count(*) FROM faction_achievements fa WHERE fa.member_id = m.id)::int AS achievements_count,
  (SELECT json_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name) FROM players p WHERE p.factions_player_id = m.id) AS player`;

function shapeMember(m) {
  return { ...m, order: ORDER_BY_SLUG.get(m.order_slug) || null, total_points: m.bonus_points + (m.event_points || 0) };
}

async function getMember(id) {
  const m = await db.one(`SELECT ${MEMBER_TOTALS} FROM faction_members m JOIN faction_orders o ON o.slug = m.order_slug WHERE m.id = $1`, [id]);
  if (!m) throw notFound("member");
  const [achievements, participation] = await Promise.all([
    db.many("SELECT a.*, e.name AS event_name FROM faction_achievements a LEFT JOIN faction_events e ON e.id = a.event_id WHERE a.member_id = $1 ORDER BY a.awarded_at DESC", [id]),
    db.many(
      `SELECT fp.*, e.name AS event_name, t.id AS tournament_id FROM faction_participation fp JOIN faction_events e ON e.id = fp.event_id
         LEFT JOIN tournaments t ON t.factions_event_id = e.id WHERE fp.member_id = $1 ORDER BY e.start_date DESC NULLS LAST, e.created_at DESC`,
      [id],
    ),
  ]);
  return { ...shapeMember(m), achievements, participation };
}

async function findMemberByEmail(email) {
  const m = await db.one("SELECT id FROM faction_members WHERE email = blst_norm_email($1)", [String(email)]);
  if (!m) throw notFound("member");
  return getMember(m.id);
}

async function listMembers({ q, order, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    params.push(`%${String(q).toLowerCase()}%`);
    where.push(`(m.email LIKE $${params.length} OR lower(coalesce(m.display_name, '')) LIKE $${params.length})`);
  }
  if (order) {
    params.push(order);
    where.push(`m.order_slug = $${params.length}`);
  }
  params.push(limit, offset);
  const rows = await db.many(
    `SELECT ${MEMBER_TOTALS} FROM faction_members m JOIN faction_orders o ON o.slug = m.order_slug
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY m.display_name NULLS LAST, m.email LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = (await db.one(`SELECT count(*) AS n FROM faction_members m ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, params.slice(0, -2))).n;
  return { total, members: rows.map(shapeMember) };
}

/** Manual award (negative to take points away). */
async function addBonusPoints(id, points) {
  const m = await db.one("UPDATE faction_members SET bonus_points = bonus_points + $2 WHERE id = $1 RETURNING id", [id, points]);
  if (!m) throw notFound("member");
  emitDomain("factions.updated", {});
  return getMember(id);
}

/** Idempotent per (member, code): awarding the same code again is a no-op. */
async function awardAchievement(id, { code, title, event_id: eventId }) {
  if (!(await db.one("SELECT 1 FROM faction_members WHERE id = $1", [id]))) throw notFound("member");
  if (eventId && !(await db.one("SELECT 1 FROM faction_events WHERE id = $1", [eventId]))) throw badRequest("event not found");
  const row = await db.one(
    `INSERT INTO faction_achievements (member_id, code, title, event_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id, code) DO NOTHING RETURNING *`,
    [id, code, title, eventId || null],
  );
  return { created: Boolean(row), achievement: row || (await db.one("SELECT * FROM faction_achievements WHERE member_id = $1 AND code = $2", [id, code])) };
}

/**
 * Bulk member upload: a CSV (comma, semicolon or tab) with an email column
 * and optionally a name. Existing members keep their Order; re-uploading
 * the same file changes nothing. dryRun previews without writing.
 */
async function importMembers(text, { dryRun = false } = {}) {
  let rows;
  try {
    rows = csvToObjects(String(text || ""));
  } catch (err) {
    throw badRequest(`could not read the CSV: ${err.message}`);
  }
  if (!rows.length) throw badRequest("no data rows found");
  if (rows.length > 20000) throw badRequest("too many rows (max 20,000)");
  const headers = Object.keys(rows[0]);
  const emailKey = headers.find((h) => ["email", "email_address", "emailaddress", "e_mail"].includes(h));
  if (!emailKey) throw badRequest(`no "email" column (saw: ${headers.join(", ")})`);
  const nameKey = headers.find((h) => ["display_name", "displayname", "name", "full_name", "fullname", "player_name"].includes(h));
  const summary = { dry_run: dryRun, rows: rows.length, new_members: 0, existing_members: 0, invalid: 0, results: [], errors: [] };
  const seen = new Set();
  await db.tx(async (c) => {
    for (const [i, row] of rows.entries()) {
      const line = i + 2;
      const email = (row[emailKey] || "").trim();
      if (!email || !EMAIL_RE.test(email)) {
        summary.invalid += 1;
        summary.errors.push({ line, error: email ? `invalid email "${email.slice(0, 80)}"` : "missing email" });
        continue;
      }
      const name = (nameKey && row[nameKey]) || [row.first_name, row.last_name].filter(Boolean).join(" ") || null;
      const dup = seen.has(normalizeEmail(email));
      seen.add(normalizeEmail(email));
      let created;
      let slug;
      if (dryRun) {
        const existing = (await c.query("SELECT order_slug FROM faction_members WHERE email = blst_norm_email($1)", [email])).rows[0];
        created = !existing && !dup;
        slug = existing ? existing.order_slug : assignOrder(email);
      } else {
        const r = await getOrCreateMember({ email, display_name: name, source: "upload" }, c);
        created = r.created;
        slug = r.member.order_slug;
      }
      if (created) summary.new_members += 1;
      else summary.existing_members += 1;
      if (summary.results.length < 2000) summary.results.push({ line, email: normalizeEmail(email), name, order: slug, new: created, duplicate_in_file: dup || undefined });
    }
    if (dryRun) throw Object.assign(new Error("dry run"), { rollback: true });
  }).catch((err) => {
    if (!err.rollback) throw err;
  });
  if (!dryRun && summary.new_members) emitDomain("factions.updated", { imported: summary.new_members });
  return summary;
}

// ---------------------------------------------------------------------------
// Events

const EVENT_COLS = `e.*, t.id AS tournament_id, t.name AS tournament_name,
  (SELECT count(*) FROM faction_participation fp WHERE fp.event_id = e.id)::int AS participants,
  COALESCE((SELECT sum(points_earned) FROM faction_participation fp WHERE fp.event_id = e.id), 0)::int AS points`;

async function listEvents() {
  return db.many(`SELECT ${EVENT_COLS} FROM faction_events e LEFT JOIN tournaments t ON t.factions_event_id = e.id
                   ORDER BY e.start_date DESC NULLS LAST, e.created_at DESC`);
}

async function createEvent({ name, leagueapps_event_id: la, start_date: s, end_date: e }) {
  try {
    return await db.one(
      "INSERT INTO faction_events (name, leagueapps_event_id, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, la || null, s || null, e || null],
    );
  } catch (err) {
    if (err.code === "23505") throw conflict("an event with that LeagueApps id already exists");
    throw err;
  }
}

async function getEvent(id) {
  const e = await db.one(`SELECT ${EVENT_COLS} FROM faction_events e LEFT JOIN tournaments t ON t.factions_event_id = e.id WHERE e.id = $1`, [id]);
  if (!e) throw notFound("event");
  e.participation = await db.many(
    `SELECT fp.*, m.display_name, m.email, m.order_slug FROM faction_participation fp JOIN faction_members m ON m.id = fp.member_id
      WHERE fp.event_id = $1 ORDER BY fp.points_earned DESC, m.display_name`,
    [id],
  );
  return e;
}

async function recordParticipation(eventId, { member_id: mid, email, points_earned: pts = 0, placement = null }) {
  if (!(await db.one("SELECT 1 FROM faction_events WHERE id = $1", [eventId]))) throw notFound("event");
  let id = mid;
  if (!id && email) id = (await getOrCreateMember({ email, source: "admin" })).member.id;
  if (!id || !(await db.one("SELECT 1 FROM faction_members WHERE id = $1", [id]))) throw badRequest("member not found");
  const row = await db.one(
    `INSERT INTO faction_participation (member_id, event_id, points_earned, placement) VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id, event_id) DO UPDATE SET points_earned = EXCLUDED.points_earned, placement = EXCLUDED.placement
     RETURNING *`,
    [id, eventId, pts, placement],
  );
  emitDomain("factions.updated", { event_id: eventId });
  return row;
}

// ---------------------------------------------------------------------------
// Standings (aggregates only: safe to show publicly)

async function orderTotals() {
  const rows = await db.many(
    `SELECT o.slug, o.name, o.animal,
            count(m.id)::int AS members,
            COALESCE(sum(m.bonus_points), 0)::int AS bonus_points,
            COALESCE(sum(ep.points), 0)::int AS event_points
       FROM faction_orders o
       LEFT JOIN faction_members m ON m.order_slug = o.slug
       LEFT JOIN (SELECT member_id, sum(points_earned) AS points FROM faction_participation GROUP BY member_id) ep ON ep.member_id = m.id
      GROUP BY o.slug, o.name, o.animal, o.position ORDER BY o.position`,
  );
  return rank(rows.map((r) => ({ ...r, total_points: r.bonus_points + r.event_points })));
}

async function eventTotals(eventId) {
  if (!(await db.one("SELECT 1 FROM faction_events WHERE id = $1", [eventId]))) throw notFound("event");
  const rows = await db.many(
    `SELECT o.slug, o.name, o.animal, count(fp.id)::int AS members, COALESCE(sum(fp.points_earned), 0)::int AS total_points
       FROM faction_orders o
       LEFT JOIN faction_members m ON m.order_slug = o.slug
       LEFT JOIN faction_participation fp ON fp.member_id = m.id AND fp.event_id = $1
      GROUP BY o.slug, o.name, o.animal, o.position ORDER BY o.position`,
    [eventId],
  );
  return rank(rows);
}

function rank(rows) {
  const sorted = [...rows].sort((a, b) => b.total_points - a.total_points);
  return sorted.map((r) => ({ ...r, rank: sorted.findIndex((x) => x.total_points === r.total_points) + 1 }));
}

/** Top members by total points (names only; no emails or ids). */
async function leaders({ order, limit = 10 } = {}) {
  return db.many(
    `SELECT COALESCE(m.display_name, 'Member') AS name, m.order_slug,
            m.bonus_points + COALESCE(ep.points, 0) AS total_points, p.id AS player_id
       FROM faction_members m
       LEFT JOIN (SELECT member_id, sum(points_earned)::int AS points FROM faction_participation GROUP BY member_id) ep ON ep.member_id = m.id
       LEFT JOIN players p ON p.factions_player_id = m.id
      WHERE ($1::text IS NULL OR m.order_slug = $1) AND m.bonus_points + COALESCE(ep.points, 0) > 0
      ORDER BY total_points DESC, name LIMIT $2`,
    [order || null, limit],
  );
}

// ---------------------------------------------------------------------------
// Tournaments -> Factions points

function pointsConfig(t) {
  return { ...DEFAULT_POINTS, ...(t.factions_points || {}) };
}

/** Counts a tournament for Factions: links it to an event (created if needed). */
async function linkTournament(tournamentId, { event_id: eventId } = {}) {
  const t = await data.getTournament(tournamentId);
  let id = eventId;
  if (id) {
    if (!(await db.one("SELECT 1 FROM faction_events WHERE id = $1", [id]))) throw badRequest("event not found");
  } else if (t.factions_event_id && (await db.one("SELECT 1 FROM faction_events WHERE id = $1", [t.factions_event_id]))) {
    id = t.factions_event_id;
  } else {
    id = (await createEvent({ name: t.name, start_date: t.start_date, end_date: t.end_date })).id;
  }
  await db.query("UPDATE tournaments SET factions_event_id = $2, updated_at = now() WHERE id = $1", [tournamentId, id]);
  return { tournament_id: tournamentId, factions_event_id: id, created: id !== eventId && id !== t.factions_event_id };
}

async function unlinkTournament(tournamentId) {
  await data.getTournament(tournamentId);
  await db.query("UPDATE tournaments SET factions_event_id = NULL, updated_at = now() WHERE id = $1", [tournamentId]);
  return { tournament_id: tournamentId, factions_event_id: null };
}

/**
 * Each player's Factions points for the tournament and the achievements
 * they earned. Pure apart from its inputs, so it can be previewed.
 */
function computeParticipation(stats, players) {
  const { tournament: t, standings, teams, gameStats } = stats;
  const pts = pointsConfig(t);
  const placementByTeam = new Map();
  for (const team of teams) placementByTeam.set(team.id, team.final_placement ?? null);
  for (const row of standings) if (placementByTeam.get(row.team_id) == null) placementByTeam.set(row.team_id, row.rank);

  const lines = new Map();
  const line = (pid) => {
    if (!lines.has(pid)) lines.set(pid, { player_id: pid, gp: 0, goals: 0, assists: 0, wins: 0, shutouts: 0, hat_tricks: 0, achievements: [] });
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
    let points = l.gp * pts.game_played + l.goals * pts.goal + l.assists * pts.assist + l.wins * pts.win +
      l.shutouts * pts.shutout + l.hat_tricks * pts.hat_trick;
    if (placement === 1) {
      points += pts.champion;
      l.achievements.push({ code: `blst:t${t.id}:champion`, title: `Champion — ${t.name}` });
    } else if (placement === 2) points += pts.runner_up;
    out.push({
      ...l,
      name: p ? `${p.first_name} ${p.last_name}` : `Player ${l.player_id}`,
      member_id: p?.factions_player_id ?? null,
      order: p?.factions_order ?? null,
      placement,
      points_earned: points,
    });
  }
  return out.sort((a, b) => b.points_earned - a.points_earned);
}

async function participationPreview(tournamentId) {
  const stats = await data.tournamentStats(tournamentId);
  const players = await db.many(
    `SELECT p.id, p.first_name, p.last_name, p.factions_player_id, p.factions_order, re.team_id AS current_team_id
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

/**
 * Writes the tournament's points, placements and achievements to its
 * Factions event. Idempotent: re-running after a stat correction replaces
 * this tournament's numbers (and withdraws achievements no longer earned)
 * instead of adding to them.
 */
async function awardResults(tournamentId) {
  const { tournament: t, participation } = await participationPreview(tournamentId);
  if (!t.factions_event_id) throw conflict("this tournament doesn't count for Factions yet (link it first)");
  if (!(await db.one("SELECT 1 FROM faction_events WHERE id = $1", [t.factions_event_id]))) {
    throw conflict("this tournament is linked to a Factions event that doesn't exist here; link it again");
  }
  const result = { awarded: 0, points: 0, achievements: 0, skipped_no_email: [] };
  await db.tx(async (c) => {
    const byMember = new Map();
    for (const p of participation) {
      if (!p.member_id) {
        result.skipped_no_email.push({ player_id: p.player_id, name: p.name });
        continue;
      }
      const cur = byMember.get(p.member_id) || { points: 0, placement: null, achievements: [], stats: [] };
      cur.points += p.points_earned;
      if (p.placement != null) cur.placement = cur.placement == null ? p.placement : Math.min(cur.placement, p.placement);
      cur.achievements.push(...p.achievements);
      cur.stats.push({ player_id: p.player_id, gp: p.gp, goals: p.goals, assists: p.assists, wins: p.wins, shutouts: p.shutouts });
      byMember.set(p.member_id, cur);
    }
    const ids = [...byMember.keys()];
    await c.query(
      "DELETE FROM faction_participation WHERE event_id = $1 AND metadata->>'source' = 'blst' AND NOT (member_id = ANY($2::text[]))",
      [t.factions_event_id, ids],
    );
    const codes = [];
    for (const [mid, v] of byMember) {
      await c.query(
        `INSERT INTO faction_participation (member_id, event_id, points_earned, placement, metadata) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (member_id, event_id) DO UPDATE SET points_earned = EXCLUDED.points_earned, placement = EXCLUDED.placement, metadata = EXCLUDED.metadata`,
        [mid, t.factions_event_id, v.points, v.placement, JSON.stringify({ source: "blst", tournament_id: t.id, stats: v.stats })],
      );
      result.awarded += 1;
      result.points += v.points;
      for (const a of v.achievements) {
        codes.push(`${mid}|${a.code}`);
        await c.query(
          `INSERT INTO faction_achievements (member_id, code, title, event_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (member_id, code) DO UPDATE SET title = EXCLUDED.title`,
          [mid, a.code, a.title, t.factions_event_id],
        );
        result.achievements += 1;
      }
    }
    // Achievements from this tournament that a correction took away.
    await c.query(
      `DELETE FROM faction_achievements WHERE code LIKE $1 AND NOT ((member_id || '|' || code) = ANY($2::text[]))`,
      [`blst:t${t.id}:%`, codes],
    );
  });
  emitDomain("factions.updated", { tournament_id: t.id, event_id: t.factions_event_id });
  return result;
}

async function status() {
  const counts = await db.one(
    `SELECT (SELECT count(*) FROM faction_members)::int AS members, (SELECT count(*) FROM faction_events)::int AS events,
            (SELECT count(*) FROM players WHERE email IS NULL)::int AS players_without_email`,
  );
  return { ...counts, auto_award: autoAward(), default_points: DEFAULT_POINTS, orders: ORDERS };
}

// Points update on every final whistle for tournaments that count, one
// tournament at a time so two games ending together can't interleave.
const queues = new Map();
function start() {
  bus.on("domain", ({ event, data: payload }) => {
    if (!autoAward() || (event !== "game.final" && event !== "game.reopened")) return;
    const tid = payload.tournament_id;
    const next = (queues.get(tid) || Promise.resolve())
      .then(async () => {
        const t = await data.getTournament(tid);
        if (t.factions_event_id) await awardResults(tid);
      })
      .catch((err) => console.error(`Factions auto-award for tournament ${tid} failed:`, err.message));
    queues.set(tid, next);
  });
}
/** Resolves once queued auto-awards have finished (tests, shutdown). */
const settled = () => Promise.all([...queues.values()]);

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
  ORDERS, DEFAULT_POINTS, assignOrder, memberId, normalizeEmail,
  getOrCreateMember, getMember, findMemberByEmail, listMembers, addBonusPoints, awardAchievement, importMembers,
  listEvents, createEvent, getEvent, recordParticipation, orderTotals, eventTotals, leaders,
  linkTournament, unlinkTournament, computeParticipation, participationPreview, awardResults,
  status, start, settled, validatePoints, HttpError,
};

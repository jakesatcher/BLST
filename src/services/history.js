const db = require("../db");
const data = require("./data");
const { badRequest, notFound, conflict } = require("../lib/http");

// History across tournaments.
//   Players: every stat a player has (imported history + every BLST game),
//   whatever team they were on. Draft tournaments reshuffle teams, so this
//   is what "follows" a person.
//   Clubs: teams that carry over between team tournaments (and the team
//   names in imported history), with their record and their players' stats.
//   Matching: imported players often have no email; suggestions pair them
//   with players who do (same name, nickname, or initial) so an admin can
//   merge them, and an email list can be attached in bulk.

// ---------------------------------------------------------------------------
// All-time player totals

const SKATER_KEYS = ["gp", "goals", "assists", "pim", "plus_minus", "ppg", "shg", "gwg", "shots"];
const GOALIE_KEYS = ["wins", "losses", "ot_losses", "ties", "shots_against", "goals_against", "shutouts", "toi_sec"];

function emptySkater() {
  return Object.fromEntries(SKATER_KEYS.map((k) => [k, 0]));
}
function emptyGoalie() {
  return { gp: 0, ...Object.fromEntries(GOALIE_KEYS.map((k) => [k, 0])) };
}
function finishSkater(s) {
  return { ...s, points: s.goals + s.assists, ppg_rate: s.gp ? Math.round(((s.goals + s.assists) / s.gp) * 100) / 100 : null };
}
function finishGoalie(g) {
  const saves = g.shots_against - g.goals_against;
  return {
    ...g, saves,
    save_pct: g.shots_against ? Math.round((saves / g.shots_against) * 1000) / 1000 : null,
    gaa: g.toi_sec ? Math.round(((g.goals_against * 3600) / g.toi_sec) * 100) / 100 : null,
  };
}
function addHistory(sk, gl, h) {
  for (const k of SKATER_KEYS) sk[k] += h[k] || 0;
  gl.gp += h.goalie_gp || 0;
  for (const k of GOALIE_KEYS) gl[k] += h[k] || 0;
}
function addLine(target, line, keys) {
  for (const k of keys) target[k] += line[k] || 0;
}

async function allTournamentStats(where = "TRUE", params = []) {
  const ts = await db.many(`SELECT id FROM tournaments WHERE ${where} ORDER BY start_date NULLS LAST, id`, params);
  return Promise.all(ts.map((t) => data.tournamentStats(t.id)));
}

/**
 * Career totals for every player (imported history + BLST games), for the
 * all-time leaderboards and the player directory.
 */
async function allTime() {
  const [players, history, stats] = await Promise.all([
    db.many(`SELECT ${data.PUBLIC_PLAYER_COLS}, p.player_code FROM players p`),
    db.many("SELECT * FROM historical_stats WHERE tournament_id IS NULL"), // the rest count through their tournament
    allTournamentStats(),
  ]);
  const by = new Map();
  const get = (id) => {
    if (!by.has(id)) by.set(id, { skater: emptySkater(), goalie: emptyGoalie(), seasons: new Set(), events: 0 });
    return by.get(id);
  };
  for (const h of history) {
    const r = get(h.player_id);
    addHistory(r.skater, r.goalie, h);
    if (h.season) r.seasons.add(h.season);
    r.events += 1;
  }
  for (const s of stats) {
    const seen = new Set();
    for (const l of s.skaters) {
      const r = get(l.player_id);
      addLine(r.skater, l, SKATER_KEYS);
      seen.add(l.player_id);
    }
    for (const l of s.goalies) {
      const r = get(l.player_id);
      r.goalie.gp += l.gp || 0;
      addLine(r.goalie, l, GOALIE_KEYS);
      seen.add(l.player_id);
    }
    for (const id of seen) {
      const r = get(id);
      r.events += 1;
      if (s.tournament.season) r.seasons.add(s.tournament.season);
    }
  }
  return players.map((p) => {
    const r = by.get(p.id) || { skater: emptySkater(), goalie: emptyGoalie(), seasons: new Set(), events: 0 };
    return {
      player_id: p.id, name: `${p.first_name} ${p.last_name}`, first_name: p.first_name, last_name: p.last_name,
      position: p.position, player_code: p.player_code,
      events: r.events, seasons: r.seasons.size,
      skater: finishSkater(r.skater), goalie: finishGoalie(r.goalie),
    };
  });
}

/** Player directory: search by name or code, with all-time totals. */
async function directory({ q, sort = "points", limit = 100 }) {
  let rows = await allTime();
  if (q) {
    const needle = q.toLowerCase().trim();
    rows = rows.filter((r) => r.name.toLowerCase().includes(needle) || (r.player_code || "").toLowerCase() === needle);
  }
  const key = {
    points: (r) => r.skater.points, goals: (r) => r.skater.goals, assists: (r) => r.skater.assists, gp: (r) => r.skater.gp + r.goalie.gp,
    pim: (r) => r.skater.pim, wins: (r) => r.goalie.wins, shutouts: (r) => r.goalie.shutouts, events: (r) => r.events,
  }[sort];
  if (!key && sort !== "name") throw badRequest("sort must be one of points, goals, assists, gp, pim, wins, shutouts, events, name");
  rows.sort(sort === "name" ? (a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name) : (a, b) => key(b) - key(a) || a.name.localeCompare(b.name));
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Clubs (teams that carry over between team tournaments)

async function listClubs() {
  const clubs = await db.many(
    `SELECT c.*,
            (SELECT count(*) FROM teams t WHERE t.club_id = c.id)::int AS tournaments,
            (SELECT count(*) FROM historical_stats h WHERE h.club_id = c.id)::int AS history_lines
       FROM clubs c ORDER BY lower(c.name)`,
  );
  // Overall record from the tournaments they played.
  const teams = await db.many("SELECT id, club_id, tournament_id FROM teams WHERE club_id IS NOT NULL");
  const stats = new Map((await allTournamentStats("id = ANY($1)", [[...new Set(teams.map((t) => t.tournament_id))]])).map((s) => [s.tournament.id, s]));
  return clubs.map((c) => {
    const rec = { gp: 0, w: 0, l: 0, otl: 0, t: 0, gf: 0, ga: 0, titles: 0 };
    for (const t of teams.filter((x) => x.club_id === c.id)) {
      const s = stats.get(t.tournament_id);
      const row = s && s.standings.find((r) => r.team_id === t.id);
      if (row) for (const k of ["gp", "w", "l", "otl", "t", "gf", "ga"]) rec[k] += row[k];
      const team = s && s.teams.find((x) => x.id === t.id);
      if (team && team.final_placement === 1) rec.titles += 1;
    }
    return { ...c, name_key: undefined, record: rec };
  });
}

/**
 * One club: each tournament it played (record, placement), imported seasons,
 * and every player's totals while on this club.
 */
async function club(id) {
  const c = await db.one("SELECT * FROM clubs WHERE id = $1", [id]);
  if (!c) throw notFound("team");
  const [teams, history] = await Promise.all([
    db.many(
      `SELECT tm.*, t.name AS tournament_name, t.season, t.start_date, t.imported FROM teams tm JOIN tournaments t ON t.id = tm.tournament_id
        WHERE tm.club_id = $1 ORDER BY t.start_date NULLS LAST, t.id`, [id]),
    db.many("SELECT * FROM historical_stats WHERE club_id = $1 AND tournament_id IS NULL ORDER BY season NULLS FIRST, id", [id]),
  ]);
  const players = new Map();
  const get = (pid) => {
    if (!players.has(pid)) players.set(pid, { player_id: pid, skater: emptySkater(), goalie: emptyGoalie(), events: new Set() });
    return players.get(pid);
  };
  const seasons = [];
  for (const tm of teams) {
    const s = await data.tournamentStats(tm.tournament_id);
    const row = s.standings.find((r) => r.team_id === tm.id) || null;
    seasons.push({
      kind: "tournament", tournament_id: tm.tournament_id, tournament: tm.tournament_name, season: tm.season, team_id: tm.id,
      team_name: tm.name, final_placement: tm.final_placement, imported: tm.imported, standing: row && row.gp ? { gp: row.gp, w: row.w, l: row.l, otl: row.otl, t: row.t, pts: row.pts, gf: row.gf, ga: row.ga } : null,
      rank: row && row.gp ? s.standings.indexOf(row) + 1 : null, teams: s.standings.length,
    });
    for (const l of s.skaters) {
      const split = l.by_team.find((b) => b.team_id === tm.id);
      if (split) {
        const p = get(l.player_id);
        addLine(p.skater, split, SKATER_KEYS);
        p.events.add(`t${tm.tournament_id}`);
      }
    }
    for (const l of s.goalies) {
      const split = l.by_team.find((b) => b.team_id === tm.id);
      if (split) {
        const p = get(l.player_id);
        p.goalie.gp += split.gp || 0;
        addLine(p.goalie, split, GOALIE_KEYS);
        p.events.add(`t${tm.tournament_id}`);
      }
    }
  }
  const imported = new Map();
  for (const h of history) {
    const p = get(h.player_id);
    addHistory(p.skater, p.goalie, h);
    const ev = `${h.season || ""}|${h.event_name || ""}`;
    p.events.add(`h${ev}`);
    if (!imported.has(ev)) imported.set(ev, { kind: "imported", season: h.season, event: h.event_name, team_name: h.team_name, players: new Set(), goals: 0 });
    const e = imported.get(ev);
    e.players.add(h.player_id);
    e.goals += h.goals || 0;
  }
  for (const e of imported.values()) seasons.push({ ...e, players: e.players.size });
  // Oldest first; imported seasons before tournaments in the same season.
  const startOf = new Map(teams.map((t) => [t.tournament_id, t.start_date ? new Date(t.start_date).getTime() : 0]));
  seasons.sort((a, b) => String(a.season || "").localeCompare(String(b.season || ""), undefined, { numeric: true })
    || (a.kind === b.kind ? (startOf.get(a.tournament_id) || 0) - (startOf.get(b.tournament_id) || 0) : a.kind === "imported" ? -1 : 1));

  const ids = [...players.keys()];
  const names = new Map((ids.length ? await db.many(`SELECT ${data.PUBLIC_PLAYER_COLS} FROM players p WHERE p.id = ANY($1)`, [ids]) : []).map((p) => [p.id, p]));
  const roster = [...players.values()].map((p) => {
    const n = names.get(p.player_id) || {};
    return {
      player_id: p.player_id, name: n.first_name ? `${n.first_name} ${n.last_name}` : `Player ${p.player_id}`, position: n.position ?? null,
      events: p.events.size, skater: finishSkater(p.skater), goalie: finishGoalie(p.goalie),
    };
  }).sort((a, b) => b.skater.points - a.skater.points || b.events - a.events || a.name.localeCompare(b.name));
  return { club: { ...c, name_key: undefined }, seasons, players: roster };
}

async function createClub({ name, short_name: shortName, color }) {
  if (!name) throw badRequest("name is required");
  try {
    const c = await db.one("INSERT INTO clubs (name, short_name, color) VALUES ($1, $2, $3) RETURNING *", [name, shortName ?? null, color ?? null]);
    await linkHistory(c.id);
    return c;
  } catch (err) {
    if (err.code === "23505") throw conflict("there's already a team with that name");
    throw err;
  }
}

async function updateClub(id, { name, short_name: shortName, color }) {
  try {
    const c = await db.one(
      "UPDATE clubs SET name = COALESCE($2, name), short_name = COALESCE($3, short_name), color = COALESCE($4, color) WHERE id = $1 RETURNING *",
      [id, name ?? null, shortName ?? null, color ?? null]);
    if (!c) throw notFound("team");
    await linkHistory(c.id);
    return c;
  } catch (err) {
    if (err.code === "23505") throw conflict("there's already a team with that name");
    throw err;
  }
}

/** Imported lines with this club's name (or one of its tournament team names) join it. */
async function linkHistory(clubId) {
  await db.query(
    `UPDATE historical_stats h SET club_id = $1
      WHERE h.club_id IS NULL AND blst_team_key(h.team_name) IN (
        SELECT name_key FROM clubs WHERE id = $1
        UNION SELECT blst_team_key(name) FROM teams WHERE club_id = $1)`, [clubId]);
}

/** Folds one club into another (two names for the same team). */
async function mergeClubs(keepId, removeId) {
  if (keepId === removeId) throw badRequest("pick two different teams");
  await db.tx(async (c) => {
    const n = (await c.query("SELECT count(*)::int AS n FROM clubs WHERE id IN ($1, $2)", [keepId, removeId])).rows[0].n;
    if (n !== 2) throw notFound("team");
    await c.query("UPDATE teams SET club_id = $1 WHERE club_id = $2", [keepId, removeId]);
    await c.query("UPDATE historical_stats SET club_id = $1 WHERE club_id = $2", [keepId, removeId]);
    await c.query("DELETE FROM clubs WHERE id = $1", [removeId]);
  });
  return club(keepId);
}

async function deleteClub(id) {
  const r = await db.query("DELETE FROM clubs WHERE id = $1", [id]);
  if (!r.rowCount) throw notFound("team");
}

/** Puts a tournament team in a club (or takes it out with null). */
async function setTeamClub(teamId, clubId) {
  if (clubId !== null && !(await db.one("SELECT 1 FROM clubs WHERE id = $1", [clubId]))) throw badRequest("team history not found");
  const t = await db.one("UPDATE teams SET club_id = $2 WHERE id = $1 RETURNING *", [teamId, clubId]);
  if (!t) throw notFound("team");
  if (clubId) await linkHistory(clubId);
  return t;
}

// ---------------------------------------------------------------------------
// Matching people across imports and registrations

const NICKNAMES = [
  ["michael", "mike", "mikey", "mick"], ["matthew", "matt"], ["christopher", "chris"], ["nicholas", "nick", "nicky"],
  ["david", "dave"], ["daniel", "dan", "danny"], ["james", "jim", "jimmy", "jamie"], ["william", "will", "bill", "billy", "liam"],
  ["robert", "rob", "bob", "bobby", "robbie"], ["thomas", "tom", "tommy"], ["anthony", "tony"], ["joseph", "joe", "joey"],
  ["jonathan", "jon", "john", "johnny", "jack"], ["steven", "steve", "stephen"], ["jeffrey", "jeff", "geoffrey"], ["kenneth", "ken", "kenny"],
  ["alexander", "alex", "alec", "xander"], ["andrew", "andy", "drew"], ["benjamin", "ben", "benny"], ["samuel", "sam", "sammy"],
  ["zachary", "zach", "zack"], ["jacob", "jake"], ["joshua", "josh"], ["gregory", "greg"], ["patrick", "pat", "paddy"],
  ["richard", "rick", "rich", "ricky", "dick"], ["ronald", "ron", "ronnie"], ["timothy", "tim", "timmy"], ["edward", "ed", "eddie", "ted"],
  ["frederick", "fred", "freddie"], ["charles", "charlie", "chuck", "chaz"], ["katherine", "kate", "katie", "kathy", "catherine", "cathy"],
  ["elizabeth", "liz", "beth", "lizzie", "betty"], ["jennifer", "jen", "jenny"], ["susan", "sue", "suzy"], ["margaret", "maggie", "meg", "peggy"],
  ["rebecca", "becky", "becca"], ["victoria", "vicky", "tori"], ["abigail", "abby"], ["samantha", "sam"], ["alexandra", "alex", "lexi"],
  ["douglas", "doug"], ["donald", "don", "donnie"], ["gerald", "gerry", "jerry"], ["lawrence", "larry"], ["leonard", "leo", "len", "lenny"],
  ["nathaniel", "nate", "nathan"], ["peter", "pete"], ["phillip", "phil", "philip"], ["raymond", "ray"], ["russell", "russ"],
  ["theodore", "theo", "teddy"], ["vincent", "vince", "vinny"], ["walter", "walt"], ["cameron", "cam"], ["maxwell", "max"],
  ["mitchell", "mitch"], ["dominic", "dom"], ["frank", "francis", "frankie"], ["harold", "harry", "hal"], ["henry", "hank"],
];
const CANON = new Map();
for (const group of NICKNAMES) for (const n of group) if (!CANON.has(n)) CANON.set(n, group[0]);
const firstPart = (key) => String(key || "").split(" ")[0] || "";
const lastPart = (key) => String(key || "").split(" ").slice(1).join(" ");
const canon = (first) => CANON.get(first) || first;

/** How alike two first names are: exact, nickname, initial (null if not). */
function firstNameMatch(a, b) {
  if (!a || !b) return null;
  if (a === b) return "same name";
  if (canon(a) === canon(b)) return "nickname";
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) return "initial";
  return null;
}
const SCORE = { "same name": 3, nickname: 2, initial: 1 };

/**
 * Pairs of players who may be the same person: one without an email
 * (usually from an imported history file) and one with an email (usually
 * from a registration), same last name and a matching first name. Pairs an
 * admin marked "different people" are left out.
 */
async function suggestions() {
  const players = await db.many(
    `SELECT p.id, p.first_name, p.last_name, p.name_key, p.email, p.player_code, p.position, p.birth_date,
            (SELECT count(*) FROM historical_stats h WHERE h.player_id = p.id)::int AS history_lines,
            (SELECT string_agg(DISTINCT coalesce(h.season, '') || CASE WHEN h.team_name IS NULL THEN '' ELSE ' ' || h.team_name END, '; ')
               FROM historical_stats h WHERE h.player_id = p.id) AS history_summary,
            (SELECT count(DISTINCT x) FROM (SELECT tournament_id AS x FROM roster_entries WHERE player_id = p.id
                                            UNION SELECT tournament_id FROM tournament_registrations WHERE player_id = p.id) y)::int AS tournaments
       FROM players p`,
  );
  const dismissed = new Set((await db.many("SELECT player_a, player_b FROM player_identity_dismissals")).map((d) => `${d.player_a}:${d.player_b}`));
  const withEmail = players.filter((p) => p.email);
  const byLast = new Map();
  for (const p of withEmail) {
    const k = lastPart(p.name_key);
    (byLast.get(k) || byLast.set(k, []).get(k)).push(p);
  }
  const out = [];
  for (const a of players.filter((p) => !p.email)) {
    for (const b of byLast.get(lastPart(a.name_key)) || []) {
      const how = firstNameMatch(firstPart(a.name_key), firstPart(b.name_key));
      if (!how) continue;
      const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      if (dismissed.has(`${x}:${y}`)) continue;
      const pos = a.position && b.position && a.position !== b.position && (a.position === "G" || b.position === "G") ? "different position" : null;
      out.push({ match: how, score: SCORE[how] - (pos ? 1 : 0), note: pos, without_email: describe(a), with_email: describe(b) });
    }
  }
  return out.sort((p, q) => q.score - p.score || p.with_email.name.localeCompare(q.with_email.name));
}
function describe(p) {
  return {
    id: p.id, name: `${p.first_name} ${p.last_name}`, email: p.email || null, player_code: p.player_code, position: p.position,
    history_lines: p.history_lines, history: p.history_summary || null, tournaments: p.tournaments,
  };
}

async function dismiss(a, b) {
  if (a === b) throw badRequest("pick two different players");
  const [x, y] = a < b ? [a, b] : [b, a];
  await db.query("INSERT INTO player_identity_dismissals (player_a, player_b) VALUES ($1, $2) ON CONFLICT DO NOTHING", [x, y]);
}

/**
 * Attaches emails to existing players in bulk (rows: player_code or
 * player_id, or first/last name; plus email). Never overwrites an email.
 * When the email already belongs to another player, that pair is reported
 * as a likely duplicate to merge.
 */
async function linkEmails(rows, { dryRun = false } = {}) {
  const { cleanEmail, nameKey } = require("./registrations");
  const report = { rows: rows.length, linked: 0, already: 0, merge_suggested: [], errors: [], dry_run: dryRun };
  const pick = (r, keys) => {
    for (const k of keys) if (r[k] !== undefined && String(r[k]).trim() !== "") return String(r[k]).trim();
    return null;
  };
  await db.tx(async (c) => {
    for (const [i, r] of rows.entries()) {
      const rowNo = i + 2;
      try {
        const email = cleanEmail(pick(r, ["email", "e_mail", "email_address"]));
        if (!email) throw new Error("no valid email");
        let player;
        const code = pick(r, ["player_code", "code", "blst_player_code"]);
        const id = pick(r, ["player_id", "blst_id", "id"]);
        if (code) player = (await c.query("SELECT * FROM players WHERE upper(player_code) = upper($1)", [code])).rows[0];
        else if (id) player = (await c.query("SELECT * FROM players WHERE id = $1", [Number(id)])).rows[0];
        else {
          let first = pick(r, ["first_name", "first", "firstname"]);
          let last = pick(r, ["last_name", "last", "lastname", "surname"]);
          const full = pick(r, ["name", "player", "full_name"]);
          if ((!first || !last) && full) {
            const parts = full.includes(",") ? full.split(",").map((s) => s.trim()).reverse() : [full.split(/\s+/)[0], full.split(/\s+/).slice(1).join(" ")];
            [first, last] = parts;
          }
          const matches = (await c.query("SELECT * FROM players WHERE name_key = $1", [nameKey(first, last)])).rows;
          if (matches.length > 1) {
            const noEmail = matches.filter((m) => !m.email);
            if (noEmail.length !== 1) throw new Error(`more than one player named ${first} ${last}; use player_code`);
            player = noEmail[0];
          } else player = matches[0];
        }
        if (!player) throw new Error("player not found");
        if (player.email === email) {
          report.already += 1;
          continue;
        }
        if (player.email) throw new Error(`${player.player_code} already has a different email`);
        const owner = (await c.query("SELECT id, player_code, first_name, last_name FROM players WHERE lower(email) = $1", [email])).rows[0];
        if (owner) {
          report.merge_suggested.push({ row: rowNo, keep_id: owner.id, keep: `${owner.first_name} ${owner.last_name} (${owner.player_code})`, merge_id: player.id, merge: `${player.first_name} ${player.last_name} (${player.player_code})` });
          continue;
        }
        if (!dryRun) await c.query("UPDATE players SET email = $2, updated_at = now() WHERE id = $1", [player.id, email]);
        report.linked += 1;
      } catch (err) {
        report.errors.push({ row: rowNo, error: err.message });
      }
    }
  });
  return report;
}

module.exports = {
  allTime, directory, listClubs, club, createClub, updateClub, mergeClubs, deleteClub, setTeamClub, linkHistory,
  suggestions, dismiss, linkEmails, firstNameMatch,
};

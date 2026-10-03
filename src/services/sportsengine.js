const db = require("../db");
const data = require("./data");
const reg = require("./registrations");
const box = require("../lib/secretbox");
const { bus, emitDomain } = require("../lib/bus");
const { withOrg } = require("../lib/context");
const { HttpError, badRequest, notFound } = require("../lib/http");

// SportsEngine integration, per organization.
//
//   SportsEngine API: GraphQL at https://api.sportsengine.com/graphql, with
//   OAuth2 access tokens from https://user.sportsengine.com/oauth/token
//   (client credentials for this server-to-server use). An organization
//   admin creates the API client in SportsEngine and enters its id and
//   secret here, plus which SportsEngine organization to read.
//
//   In:  teams and rosters (players, jersey numbers; email and birth date
//        from each player's profile, for matching) into a BLST tournament or
//        league division; games (events) into its schedule.
//   Out: final scores of BLST-scored games back to the SportsEngine event.
//
// Every GraphQL document is in QUERIES below, so they can be adjusted in one
// place if SportsEngine's schema differs. Responses are read tolerantly
// (results / nodes / edges / plain lists).

const TOKEN_URL = () => process.env.SPORTSENGINE_TOKEN_URL || "https://user.sportsengine.com/oauth/token";
const GRAPHQL_URL = () => process.env.SPORTSENGINE_GRAPHQL_URL || "https://api.sportsengine.com/graphql";
const TIMEOUT_MS = 20000;

const QUERIES = {
  organizations: `query Organizations($page: Int!) {
    organizations(perPage: 100, page: $page) { pageInformation { pages page } results { id name } } }`,
  teams: `query Teams($organizationId: String!, $page: Int!) {
    teams(organizationId: $organizationId, perPage: 100, page: $page) {
      pageInformation { pages page } results { id name status program { id name } } } }`,
  team: `query Team($id: String!) {
    team(id: $id) { id name roster { players { profileId firstName lastName jerseyNumber rosterStatus } } } }`,
  profile: `query Profile($id: String!) {
    profile(id: $id) { id firstName lastName email dateOfBirth } }`,
  events: `query Events($organizationId: String!, $start: String!, $end: String!, $page: Int!) {
    events(organizationId: $organizationId, start: $start, end: $end, perPage: 100, page: $page) {
      pageInformation { pages page }
      results { id name type start end status location { name } eventTeams { teamId homeTeam score name } } } }`,
  // Final score for one event (both teams' scores, status final).
  updateScore: process.env.SPORTSENGINE_SCORE_MUTATION || `mutation UpdateEventScore($input: UpdateEventInput!) {
    updateEvent(input: $input) { event { id status eventTeams { teamId score } } } }`,
};

/** A list from whatever shape a GraphQL connection comes back in. */
function items(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (Array.isArray(x.results)) return x.results;
  if (Array.isArray(x.nodes)) return x.nodes;
  if (Array.isArray(x.edges)) return x.edges.map((e) => e.node).filter(Boolean);
  if (Array.isArray(x.players)) return x.players;
  return [];
}
const pages = (x) => Number((x && x.pageInformation && x.pageInformation.pages) || 1);

// ---------------------------------------------------------------------------
// Connection and API access

async function connection() {
  return db.one("SELECT * FROM sportsengine_connections WHERE org_id = blst_org()");
}

function publicConnection(c) {
  if (!c) return { connected: false };
  return {
    connected: true, client_id: c.client_id, se_organization_id: c.se_organization_id, se_organization_name: c.se_organization_name,
    auto_push: c.auto_push, last_error: c.last_error, last_sync_at: c.last_sync_at, updated_at: c.updated_at,
  };
}

async function log(action, ok, message, details) {
  await db.query("INSERT INTO sportsengine_sync_log (action, ok, message, details) VALUES ($1, $2, $3, $4)",
    [action, ok, String(message).slice(0, 500), details ? JSON.stringify(details).slice(0, 20000) : null]);
  await db.query(`DELETE FROM sportsengine_sync_log WHERE id IN (SELECT id FROM sportsengine_sync_log ORDER BY at DESC OFFSET 300)`);
  await db.query("UPDATE sportsengine_connections SET last_error = $1, last_sync_at = CASE WHEN $2 THEN now() ELSE last_sync_at END WHERE org_id = blst_org()",
    [ok ? null : String(message).slice(0, 500), ok]);
}

async function fetchJson(url, opts) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new HttpError(502, `Couldn't reach SportsEngine (${err.message})`);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { res, body };
}

/** An access token (client credentials), cached until shortly before it expires. */
async function token(c, { fresh = false } = {}) {
  if (!fresh && c.access_token_enc && c.token_expires_at && new Date(c.token_expires_at).getTime() > Date.now() + 60e3) {
    return box.open("sportsengine-token", c.access_token_enc);
  }
  const { res, body } = await fetchJson(TOKEN_URL(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: c.client_id, client_secret: box.open("sportsengine-secret", c.client_secret_enc), grant_type: "client_credentials" }),
  });
  if (!res.ok || !body.access_token) {
    throw new HttpError(502, `SportsEngine sign-in failed (${res.status}${body.error ? `: ${body.error_description || body.error}` : ""}). Check the client id and secret.`);
  }
  const expires = new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000);
  await db.query("UPDATE sportsengine_connections SET access_token_enc = $1, token_expires_at = $2 WHERE org_id = blst_org()",
    [box.seal("sportsengine-token", body.access_token), expires]);
  c.access_token_enc = box.seal("sportsengine-token", body.access_token);
  c.token_expires_at = expires;
  return body.access_token;
}

/** Runs a GraphQL document; one retry with a fresh token on 401. */
async function gql(c, query, variables = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { res, body } = await fetchJson(GRAPHQL_URL(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${await token(c, { fresh: attempt > 0 })}` },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok || (body.errors && body.errors.length && !body.data)) {
      const msg = body.errors ? body.errors.map((e) => e.message).join("; ") : `HTTP ${res.status}`;
      throw new HttpError(502, `SportsEngine: ${msg.slice(0, 300)}`);
    }
    return body.data || {};
  }
  throw new HttpError(502, "SportsEngine refused the access token");
}

async function requireConnection() {
  const c = await connection();
  if (!c) throw badRequest("Connect SportsEngine first (Admin → Integrations → SportsEngine).");
  return c;
}

/** Saves credentials; checks them by listing the organizations they can see. */
async function connect({ client_id: clientId, client_secret: secret, se_organization_id: seOrg, auto_push: autoPush }) {
  const existing = await connection();
  if (!clientId || (!secret && !existing)) throw badRequest("client_id and client_secret are required");
  const c = {
    client_id: clientId,
    client_secret_enc: secret ? box.seal("sportsengine-secret", secret) : existing.client_secret_enc,
    se_organization_id: seOrg || (existing && existing.se_organization_id) || "",
  };
  // Saved, then tried; put back if they don't work.
  const probe = { ...c, access_token_enc: null };
  await db.query(
    `INSERT INTO sportsengine_connections (client_id, client_secret_enc, se_organization_id, auto_push)
     VALUES ($1, $2, $3, COALESCE($4, TRUE))
     ON CONFLICT (org_id) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc,
       se_organization_id = EXCLUDED.se_organization_id, auto_push = COALESCE($4, sportsengine_connections.auto_push),
       access_token_enc = NULL, token_expires_at = NULL, updated_at = now()`,
    [c.client_id, c.client_secret_enc, c.se_organization_id, autoPush ?? null]);
  let orgs;
  try {
    orgs = await organizations(probe);
  } catch (err) {
    // Keep what worked before (or nothing) rather than credentials that don't.
    if (existing) {
      await db.query("UPDATE sportsengine_connections SET client_id = $1, client_secret_enc = $2, se_organization_id = $3, auto_push = $4 WHERE org_id = blst_org()",
        [existing.client_id, existing.client_secret_enc, existing.se_organization_id, existing.auto_push]);
    } else {
      await disconnect();
    }
    await log("connect", false, err.message);
    throw err;
  }
  const chosen = orgs.find((o) => String(o.id) === String(c.se_organization_id)) || (orgs.length === 1 ? orgs[0] : null);
  await db.query("UPDATE sportsengine_connections SET se_organization_id = $1, se_organization_name = $2 WHERE org_id = blst_org()",
    [chosen ? String(chosen.id) : c.se_organization_id, chosen ? chosen.name : null]);
  await log("connect", true, `Connected${chosen ? ` to ${chosen.name}` : ""} (${orgs.length} organization${orgs.length === 1 ? "" : "s"} visible)`);
  return { ...publicConnection(await connection()), organizations: orgs };
}

async function disconnect() {
  await db.query("DELETE FROM sportsengine_connections WHERE org_id = blst_org()");
}

async function setOptions({ auto_push: autoPush, se_organization_id: seOrg }) {
  await requireConnection();
  await db.query("UPDATE sportsengine_connections SET auto_push = COALESCE($1, auto_push), se_organization_id = COALESCE($2, se_organization_id), updated_at = now() WHERE org_id = blst_org()",
    [autoPush ?? null, seOrg ?? null]);
  return publicConnection(await connection());
}

async function organizations(c) {
  const out = [];
  for (let page = 1, total = 1; page <= total && page <= 20; page++) {
    const d = await gql(c, QUERIES.organizations, { page });
    out.push(...items(d.organizations));
    total = pages(d.organizations);
  }
  return out.map((o) => ({ id: String(o.id), name: o.name }));
}

async function teams() {
  const c = await requireConnection();
  if (!c.se_organization_id) throw badRequest("Choose the SportsEngine organization first.");
  const out = [];
  for (let page = 1, total = 1; page <= total && page <= 50; page++) {
    const d = await gql(c, QUERIES.teams, { organizationId: c.se_organization_id, page });
    out.push(...items(d.teams));
    total = pages(d.teams);
  }
  const links = new Map((await db.many("SELECT se_id, blst_id FROM sportsengine_links WHERE kind = 'team'")).map((l) => [l.se_id, l.blst_id]));
  const blstTeams = links.size ? await db.many(
    "SELECT tm.id, tm.name, t.id AS tournament_id, t.name AS tournament FROM teams tm JOIN tournaments t ON t.id = tm.tournament_id WHERE tm.id = ANY($1)", [[...links.values()]]) : [];
  return out.map((t) => {
    const linked = blstTeams.find((b) => b.id === links.get(String(t.id)));
    return { id: String(t.id), name: t.name, status: t.status || null, program: t.program ? t.program.name : null,
      linked: linked ? { team_id: linked.id, team: linked.name, tournament_id: linked.tournament_id, tournament: linked.tournament } : null };
  });
}

// ---------------------------------------------------------------------------
// In: teams and rosters

async function link(c, kind, seId, blstId, extra = {}) {
  // One link per BLST record: the latest SportsEngine id wins.
  await c.query("DELETE FROM sportsengine_links WHERE kind = $1 AND blst_id = $2 AND se_id <> $3", [kind, blstId, String(seId)]);
  await c.query(
    `INSERT INTO sportsengine_links (kind, se_id, blst_id, data) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, kind, se_id) DO UPDATE SET blst_id = EXCLUDED.blst_id, data = EXCLUDED.data, updated_at = now()`,
    [kind, String(seId), blstId, JSON.stringify(extra)]);
}

/** The BLST player for a SportsEngine profile: linked before, else matched (email, name + birth date, name), else new. */
async function playerFor(c, profile, report) {
  const linked = (await c.query("SELECT blst_id FROM sportsengine_links WHERE kind = 'player' AND se_id = $1", [String(profile.id)])).rows[0];
  if (linked) {
    const p = (await c.query("SELECT * FROM players WHERE id = $1", [linked.blst_id])).rows[0];
    if (p) return p;
  }
  const person = {
    first_name: String(profile.firstName || "").trim(), last_name: String(profile.lastName || "").trim(),
    email: reg.cleanEmail(profile.email), birth_date: reg.cleanDate(profile.dateOfBirth),
  };
  if (!person.first_name || !person.last_name) throw new Error("roster player without a name");
  const m = await reg.matchPlayer(c, person);
  let player = m.player;
  if (player) {
    await reg.enrichPlayer(c, player, person);
    if (m.needsReview) report.review.push(`${person.first_name} ${person.last_name}: ${m.note}`);
  } else {
    player = await reg.createPlayer(c, person);
    report.created_players += 1;
    if (m.needsReview && m.note) report.review.push(`${person.first_name} ${person.last_name}: ${m.note}`);
  }
  await link(c, "player", profile.id, player.id);
  return player;
}

/**
 * Brings SportsEngine teams (and their rosters) into a BLST tournament or
 * league division. Each SportsEngine team becomes the BLST team with the same
 * name (added when missing) and stays linked for later syncs and results.
 */
async function importTeams(tournamentId, seTeamIds) {
  const c = await requireConnection();
  const t = await data.getTournament(tournamentId);
  if (!Array.isArray(seTeamIds) || !seTeamIds.length) throw badRequest("choose at least one SportsEngine team");
  const report = { tournament_id: t.id, teams: 0, created_teams: 0, players: 0, created_players: 0, moved: 0, review: [], errors: [] };
  for (const seId of seTeamIds.slice(0, 64)) {
    let team;
    try {
      const d = await gql(c, QUERIES.team, { id: String(seId) });
      team = d.team;
      if (!team) throw new Error("team not found");
    } catch (err) {
      report.errors.push(`team ${seId}: ${err.message}`);
      continue;
    }
    const players = items(team.roster && (team.roster.players || team.roster)).filter((p) => !p.rosterStatus || !/inactive|removed|declined/i.test(p.rosterStatus));
    // Profiles (for email and birth date) are fetched one by one; a missing one isn't fatal.
    const profiles = [];
    for (const p of players) {
      let prof = { id: p.profileId || `${team.id}:${p.firstName}:${p.lastName}`, firstName: p.firstName, lastName: p.lastName };
      if (p.profileId) {
        try {
          const pd = await gql(c, QUERIES.profile, { id: String(p.profileId) });
          if (pd.profile) prof = { ...prof, ...pd.profile, id: p.profileId };
        } catch {
          /* names alone still work */
        }
      }
      const n = p.jerseyNumber === null || p.jerseyNumber === "" || p.jerseyNumber === undefined ? NaN : Number(p.jerseyNumber);
      profiles.push({ prof, jersey: Number.isInteger(n) && n >= 0 && n <= 99 ? n : null });
    }
    await db.tx(async (tx) => {
      let blstTeam = (await tx.query("SELECT * FROM teams WHERE tournament_id = $1 AND blst_team_key(name) = blst_team_key($2) LIMIT 1", [t.id, team.name])).rows[0];
      if (!blstTeam) {
        blstTeam = (await tx.query(
          "INSERT INTO teams (tournament_id, name, seed, external_id) VALUES ($1, $2, (SELECT count(*) + 1 FROM teams WHERE tournament_id = $1), $3) RETURNING *",
          [t.id, String(team.name).slice(0, 80), `sportsengine:${team.id}`])).rows[0];
        report.created_teams += 1;
      }
      await link(tx, "team", team.id, blstTeam.id, { tournament_id: t.id });
      report.teams += 1;
      for (const { prof, jersey } of profiles) {
        try {
          await tx.query("SAVEPOINT p");
          const player = await playerFor(tx, prof, report);
          const cur = (await tx.query("SELECT * FROM roster_entries WHERE tournament_id = $1 AND player_id = $2", [t.id, player.id])).rows[0];
          const taken = jersey == null ? null : (await tx.query("SELECT player_id FROM roster_entries WHERE team_id = $1 AND jersey_number = $2", [blstTeam.id, jersey])).rows[0];
          const number = taken && taken.player_id !== player.id ? null : jersey;
          if (!cur) {
            await tx.query("INSERT INTO roster_entries (tournament_id, team_id, player_id, jersey_number) VALUES ($1, $2, $3, $4)", [t.id, blstTeam.id, player.id, number]);
          } else if (cur.team_id !== blstTeam.id || (number != null && cur.jersey_number !== number)) {
            if (cur.team_id !== blstTeam.id) {
              await tx.query("INSERT INTO roster_moves (tournament_id, player_id, from_team_id, to_team_id, jersey_number, reason) VALUES ($1, $2, $3, $4, $5, 'SportsEngine roster')",
                [t.id, player.id, cur.team_id, blstTeam.id, number]);
              report.moved += 1;
            }
            await tx.query("UPDATE roster_entries SET team_id = $2, jersey_number = COALESCE($3, jersey_number) WHERE id = $1", [cur.id, blstTeam.id, number]);
          }
          await tx.query("RELEASE SAVEPOINT p");
          report.players += 1;
        } catch (err) {
          await tx.query("ROLLBACK TO SAVEPOINT p");
          report.errors.push(`${prof.firstName} ${prof.lastName}: ${err.message}`);
        }
      }
    });
  }
  await log("rosters", report.errors.length === 0, `${report.teams} team${report.teams === 1 ? "" : "s"}, ${report.players} players into ${t.name}`, report);
  emitDomain("roster.synced", { tournament_id: t.id, source: "sportsengine" });
  return report;
}

// ---------------------------------------------------------------------------
// In: schedule

/**
 * Games between linked teams of this tournament in a date range become BLST
 * games (or update their time and rink). Games already being scored in BLST
 * keep their BLST data.
 */
async function importSchedule(tournamentId, { start, end, include_results: includeResults = true }) {
  const c = await requireConnection();
  const t = await data.getTournament(tournamentId);
  const from = start ? new Date(start) : new Date(Date.now() - 30 * 864e5);
  const to = end ? new Date(end) : new Date(Date.now() + 365 * 864e5);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw badRequest("start and end must be dates, start first");
  const teamLinks = new Map((await db.many(
    "SELECT l.se_id, l.blst_id FROM sportsengine_links l JOIN teams tm ON tm.id = l.blst_id WHERE l.kind = 'team' AND tm.tournament_id = $1", [t.id])).map((l) => [l.se_id, l.blst_id]));
  if (teamLinks.size < 2) throw badRequest("link at least two SportsEngine teams to this tournament first (import its teams)");
  const events = [];
  for (let page = 1, total = 1; page <= total && page <= 50; page++) {
    const d = await gql(c, QUERIES.events, { organizationId: c.se_organization_id, start: from.toISOString(), end: to.toISOString(), page });
    events.push(...items(d.events));
    total = pages(d.events);
  }
  const report = { tournament_id: t.id, seen: events.length, created: 0, updated: 0, skipped: 0, results: 0 };
  const scoreOf = (side) => (side.score === null || side.score === undefined || side.score === "" || !Number.isFinite(Number(side.score)) ? null : Number(side.score));
  for (const ev of events) {
    if (ev.type && !/game/i.test(ev.type)) continue;
    const sides = items(ev.eventTeams).filter((x) => teamLinks.has(String(x.teamId)));
    if (sides.length !== 2) continue;
    const home = sides.find((x) => x.homeTeam === true) || sides[0];
    const away = sides.find((x) => x !== home);
    const homeId = teamLinks.get(String(home.teamId));
    const awayId = teamLinks.get(String(away.teamId));
    const venue = ev.location && ev.location.name ? String(ev.location.name).slice(0, 120) : null;
    const when = ev.start ? new Date(ev.start) : null;
    // A game already played in SportsEngine comes in with its final score
    // (standings and team records; player stats come from a stats import).
    const hs = scoreOf(home);
    const as = scoreOf(away);
    const played = includeResults && hs !== null && as !== null && (/final|complete|played|closed/i.test(ev.status || "") || (when && when.getTime() < Date.now()));
    const existing = await db.one(
      "SELECT g.* FROM sportsengine_links l JOIN games g ON g.id = l.blst_id WHERE l.kind = 'game' AND l.se_id = $1", [String(ev.id)]);
    if (existing) {
      if (existing.status !== "scheduled" && !existing.result_only) {
        report.skipped += 1; // scored live in BLST: BLST's record stands
        continue;
      }
      if (played) {
        await db.query(
          `UPDATE games SET scheduled_at = $2, venue = COALESCE($3, venue), home_team_id = $4, away_team_id = $5, status = 'final', result_only = TRUE,
                  home_score = $6, away_score = $7, decision = COALESCE(decision, 'REG'), ended_at = COALESCE(ended_at, $2, now()), updated_at = now() WHERE id = $1`,
          [existing.id, when, venue, homeId, awayId, hs, as]);
        report.results += 1;
      } else if (existing.status === "scheduled") {
        await db.query("UPDATE games SET scheduled_at = $2, venue = COALESCE($3, venue), home_team_id = $4, away_team_id = $5, updated_at = now() WHERE id = $1",
          [existing.id, when, venue, homeId, awayId]);
      }
      report.updated += 1;
    } else {
      const g = played
        ? await db.one(
          `INSERT INTO games (tournament_id, home_team_id, away_team_id, scheduled_at, venue, status, result_only, home_score, away_score, decision, ended_at)
           VALUES ($1, $2, $3, $4, $5, 'final', TRUE, $6, $7, 'REG', COALESCE($4, now())) RETURNING id`,
          [t.id, homeId, awayId, when, venue, hs, as])
        : await db.one(
          "INSERT INTO games (tournament_id, home_team_id, away_team_id, scheduled_at, venue) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [t.id, homeId, awayId, when, venue]);
      if (played) report.results += 1;
      await db.query("INSERT INTO sportsengine_links (kind, se_id, blst_id, data) VALUES ('game', $1, $2, $3)",
        [String(ev.id), g.id, JSON.stringify({ home_team: String(home.teamId), away_team: String(away.teamId) })]);
      report.created += 1;
    }
  }
  await log("schedule", true, `${report.created} new, ${report.updated} updated game${report.updated === 1 ? "" : "s"}${report.results ? ` (${report.results} final scores)` : ""} for ${t.name}`, report);
  emitDomain("schedule.synced", { tournament_id: t.id, source: "sportsengine" });
  return report;
}

// ---------------------------------------------------------------------------
// Out: results

/** Sends a final BLST game's score to its SportsEngine event. */
async function pushResult(gameId) {
  const c = await requireConnection();
  const g = await data.getGame(gameId);
  const linkRow = await db.one("SELECT * FROM sportsengine_links WHERE kind = 'game' AND blst_id = $1", [g.id]);
  if (!linkRow) throw badRequest("this game didn't come from SportsEngine");
  if (g.status !== "final") throw badRequest("only final games are sent");
  if (g.result_only) throw badRequest("this score came from SportsEngine; nothing to send");
  const teamOf = async (blstTeamId, fallback) => {
    const l = await db.one("SELECT se_id FROM sportsengine_links WHERE kind = 'team' AND blst_id = $1", [blstTeamId]);
    return l ? l.se_id : fallback;
  };
  const input = {
    id: linkRow.se_id,
    status: "final",
    eventTeams: [
      { teamId: await teamOf(g.home_team_id, linkRow.data.home_team), score: g.home_score },
      { teamId: await teamOf(g.away_team_id, linkRow.data.away_team), score: g.away_score },
    ],
  };
  try {
    await gql(c, QUERIES.updateScore, { input });
  } catch (err) {
    await log("result", false, `Game ${g.id}: ${err.message}`, { input });
    throw err;
  }
  await db.query("UPDATE sportsengine_links SET data = data || $2, updated_at = now() WHERE kind = 'game' AND se_id = $1",
    [linkRow.se_id, JSON.stringify({ pushed_at: new Date().toISOString(), pushed_score: `${g.home_score}-${g.away_score}` })]);
  await log("result", true, `Game ${g.id}: sent ${g.home_score}-${g.away_score}`);
  return { ok: true, event_id: linkRow.se_id, home_score: g.home_score, away_score: g.away_score };
}

/** What in one tournament is linked to SportsEngine (teams, and games with what was last sent). */
async function tournamentLinks(tournamentId) {
  const t = await data.getTournament(tournamentId);
  const [teams_, games] = await Promise.all([
    db.many(`SELECT l.se_id, tm.id AS team_id, tm.name FROM sportsengine_links l JOIN teams tm ON tm.id = l.blst_id
              WHERE l.kind = 'team' AND tm.tournament_id = $1 ORDER BY tm.name`, [t.id]),
    db.many(`SELECT l.se_id AS event_id, g.id AS game_id, g.status, g.scheduled_at, g.home_score, g.away_score,
                    h.name AS home, a.name AS away, l.data->>'pushed_at' AS pushed_at, l.data->>'pushed_score' AS pushed_score
               FROM sportsengine_links l JOIN games g ON g.id = l.blst_id
               JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
              WHERE l.kind = 'game' AND g.tournament_id = $1 ORDER BY g.scheduled_at NULLS LAST, g.id`, [t.id]),
  ]);
  return { tournament_id: t.id, teams: teams_, games };
}

async function status() {
  const c = await connection();
  const [log_, counts] = await Promise.all([
    db.many("SELECT at, action, ok, message FROM sportsengine_sync_log ORDER BY at DESC LIMIT 30"),
    db.one(`SELECT count(*) FILTER (WHERE kind = 'team')::int AS teams, count(*) FILTER (WHERE kind = 'player')::int AS players,
                   count(*) FILTER (WHERE kind = 'game')::int AS games FROM sportsengine_links`),
  ]);
  return { ...publicConnection(c), linked: counts, log: log_, graphql_url: GRAPHQL_URL() };
}

/** Final whistle: send the score, when the game came from SportsEngine and auto-send is on. */
function start() {
  bus.on("domain", ({ event, data: payload, orgId }) => {
    if (event !== "game.final" || !payload || !payload.game_id) return;
    if (!Number.isInteger(orgId)) return;
    withOrg(orgId, async () => {
      const c = await connection();
      if (!c || !c.auto_push) return;
      const linked = await db.one("SELECT 1 FROM sportsengine_links WHERE kind = 'game' AND blst_id = $1", [payload.game_id]);
      if (linked) await pushResult(payload.game_id);
    }).catch((err) => console.error(`SportsEngine result for game ${payload.game_id} failed:`, err.message));
  });
}

module.exports = { QUERIES, items, connection, connect, disconnect, setOptions, teams, importTeams, importSchedule, pushResult, tournamentLinks, status, start };

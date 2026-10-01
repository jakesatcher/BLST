const crypto = require("crypto");
const db = require("../db");
const { HttpError, conflict } = require("../lib/http");
const { emitDomain } = require("../lib/bus");
const registrations = require("./registrations");

// LeagueApps Private API client and registration sync.
//
// Verified against LeagueApps' official sample (github.com/LeagueApps/api-example)
// and the standalone BLPA Factions member import (members-2, see syncMembers):
//   auth   POST {auth}/v2/auth/token, grant_type=jwt-bearer, assertion = RS256 JWT
//          { aud: https://auth.leagueapps.io/v2/auth/token, iss/sub: client id, iat, exp: +300 }
//   export GET {api}/v2/sites/{siteId}/export/registrations-2?last-updated=&last-id=
//          ~1000 rows per page; the first row repeats when it equals the cursor.
//   retry  401 -> new token; 429/5xx/timeout -> exponential backoff.
//
// LeagueApps doesn't publish the registrations-2 record shape anywhere we
// could check, so fields are read through FIELD_CANDIDATES (the names
// LeagueApps uses elsewhere, e.g. members-2's id/userId/firstName/lastName/
// email/lastUpdated) and an admin-editable override map. "Preview" shows
// the real field names from your account before anything is imported.

const SOURCE = "leagueapps-registrations-2";
const AUDIENCE = "https://auth.leagueapps.io/v2/auth/token";

const FIELD_CANDIDATES = {
  registration_id: ["id", "registrationId"],
  last_updated: ["lastUpdated"],
  program_id: ["programId", "program.id", "programID"],
  program_name: ["programName", "program.name"],
  user_id: ["userId", "memberId", "playerId", "user.id"],
  first_name: ["firstName", "playerFirstName", "user.firstName", "first_name"],
  last_name: ["lastName", "playerLastName", "user.lastName", "last_name"],
  email: ["email", "userEmail", "playerEmail", "user.email", "parentEmail"],
  birth_date: ["birthDate", "dateOfBirth", "dob", "user.birthDate"],
  status: ["registrationStatus", "status"],
  deleted: ["deleted"],
  registered_at: ["registrationDate", "created", "createdAt", "dateCreated"],
};

function settings() {
  const key = (process.env.LEAGUEAPPS_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  return {
    siteId: (process.env.LEAGUEAPPS_SITE_ID || "").trim(),
    clientId: (process.env.LEAGUEAPPS_CLIENT_ID || "").trim(),
    privateKey: key,
    apiBase: (process.env.LEAGUEAPPS_API_BASE || "https://public.leagueapps.io").replace(/\/+$/, ""),
    authUrl: process.env.LEAGUEAPPS_AUTH_URL || AUDIENCE,
    audience: process.env.LEAGUEAPPS_AUTH_AUDIENCE || AUDIENCE,
  };
}

// The LeagueApps credentials are server settings, so they belong to one
// organization (LEAGUEAPPS_ORG_ID, default 1 = BLPA). Other organizations
// see LeagueApps as not connected.
const LA_ORG_ID = Number(process.env.LEAGUEAPPS_ORG_ID || 1);

function isConfigured() {
  const s = settings();
  return Boolean(s.siteId && s.clientId && s.privateKey) && require("../lib/context").currentOrg() === LA_ORG_ID;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** RS256 JWT assertion with exactly the claims LeagueApps' sample uses. */
function buildAssertion(s, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ aud: s.audience, iss: s.clientId, sub: s.clientId, iat: now, exp: now + 300 }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  let signature;
  try {
    signature = signer.sign(s.privateKey);
  } catch {
    throw new HttpError(500, "LEAGUEAPPS_PRIVATE_KEY isn't a valid PEM private key (convert the .p12 with openssl, see README)");
  }
  return `${header}.${payload}.${b64url(signature)}`;
}

let tokenCache = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timing = { slotMs: 1420, maxAttempts: 5 }; // sample.py: 1.42s slots, 5 attempts

async function accessToken(force = false) {
  const s = settings();
  if (!force && tokenCache && tokenCache.expires > Date.now()) return tokenCache.token;
  const res = await fetch(s.authUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: buildAssertion(s) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new HttpError(502, `LeagueApps sign-in failed (HTTP ${res.status}); check LEAGUEAPPS_CLIENT_ID and the private key`);
  const data = await res.json().catch(() => ({}));
  if (typeof data.access_token !== "string") throw new HttpError(502, "LeagueApps sign-in returned no access token");
  tokenCache = { token: data.access_token, expires: Date.now() + ((Number(data.expires_in) || 900) - 30) * 1000 };
  return tokenCache.token;
}

/** One export page, with the sample's retry rules. */
async function exportPage(type, cursor, extra = {}) {
  const s = settings();
  const url = new URL(`${s.apiBase}/v2/sites/${encodeURIComponent(s.siteId)}/export/${type}`);
  url.searchParams.set("last-updated", String(cursor.lastUpdated));
  url.searchParams.set("last-id", String(cursor.lastId));
  for (const [k, v] of Object.entries(extra)) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  let refreshed = false;
  for (let attempt = 1; attempt <= timing.maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(30000) });
    } catch {
      await sleep(Math.floor(Math.random() * 2 ** Math.min(attempt, 5)) * timing.slotMs);
      continue;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      tokenCache = null;
      attempt -= 1;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : Math.floor(Math.random() * 2 ** Math.min(attempt, 5)) * timing.slotMs);
      continue;
    }
    if (!res.ok) throw new HttpError(502, `LeagueApps export/${type} failed with HTTP ${res.status}`);
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows)) throw new HttpError(502, `LeagueApps export/${type} returned something other than a list`);
    return rows;
  }
  throw new HttpError(502, `LeagueApps export/${type} kept failing; try again later`);
}

/** Pages through an export from `cursor`, dropping the repeated boundary row (sample.py rule). */
async function* iterate(type, start, extra) {
  let cursor = { ...start };
  for (let page = 0; page < 10000; page++) {
    const raw = await exportPage(type, cursor, extra);
    const rows = raw.length && cursor.lastId > 0 && raw[0].id === cursor.lastId && raw[0].lastUpdated === cursor.lastUpdated ? raw.slice(1) : raw;
    if (!rows.length) return;
    const last = raw[raw.length - 1];
    cursor = { lastUpdated: Number(last.lastUpdated) || cursor.lastUpdated, lastId: Number(last.id) || cursor.lastId };
    yield { rows, cursor };
  }
}

// ---------------------------------------------------------------------------
// Field mapping

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function fieldMap() {
  const row = await db.one("SELECT value FROM integration_settings WHERE key = 'leagueapps_field_map'");
  const override = row ? row.value : {};
  const map = {};
  for (const [field, names] of Object.entries(FIELD_CANDIDATES)) map[field] = override[field] ? [override[field], ...names] : names;
  return { map, override };
}

function pick(rec, names) {
  for (const n of names) {
    const v = getPath(rec, n);
    if (v !== undefined && v !== null && v !== "") return { value: v, from: n };
  }
  return { value: null, from: null };
}

const STATUS = (v, deleted) => {
  if (deleted === true || deleted === "true") return "cancelled";
  const s = String(v || "").toUpperCase();
  if (/CANCEL|REFUND|DELETE|INACTIVE|REMOVED|WITHDRAW/.test(s)) return "cancelled";
  if (/WAIT/.test(s)) return "waitlist";
  return "active";
};

function mapRecord(rec, map) {
  const out = {};
  const sources = {};
  for (const field of Object.keys(FIELD_CANDIDATES)) {
    const { value, from } = pick(rec, map[field]);
    out[field] = value;
    sources[field] = from;
  }
  out.status = STATUS(out.status, out.deleted);
  return { record: out, sources };
}

// ---------------------------------------------------------------------------
// Sync

async function loadCursor() {
  const r = await db.one("SELECT * FROM sync_state WHERE source = $1", [SOURCE]);
  return { lastUpdated: Number(r?.last_updated || 0), lastId: Number(r?.last_id || 0) };
}

/**
 * Pulls new/changed registrations since the last run and files each one
 * under the tournament its LeagueApps program is linked to. Programs not
 * linked to a tournament are recorded (so they can be linked) and skipped.
 * One sync at a time (Postgres advisory lock); the cursor is saved after
 * every page so a failure resumes where it stopped.
 */
async function sync({ fromScratch = false } = {}) {
  if (!isConfigured()) throw new HttpError(503, "LeagueApps isn't configured (set LEAGUEAPPS_SITE_ID, LEAGUEAPPS_CLIENT_ID, LEAGUEAPPS_PRIVATE_KEY)");
  const client = await db.connect();
  const lockKey = 4815162342;
  try {
    const locked = (await client.query("SELECT pg_try_advisory_lock($1) AS ok", [lockKey])).rows[0].ok;
    if (!locked) throw conflict("a LeagueApps sync is already running");
    const start = fromScratch ? { lastUpdated: 0, lastId: 0 } : await loadCursor();
    const { map } = await fieldMap();
    const tournaments = await db.many("SELECT * FROM tournaments WHERE cardinality(leagueapps_program_ids) > 0");
    const byProgram = new Map();
    for (const t of tournaments) for (const pid of t.leagueapps_program_ids) byProgram.set(String(pid), t);

    const summary = { pages: 0, seen: 0, created: 0, updated: 0, cancelled: 0, returning: 0, needs_review: 0, skipped_unlinked: 0, errors: [], cursor: start };
    for await (const { rows, cursor } of iterate("registrations-2", start)) {
      summary.pages += 1;
      for (const raw of rows) {
        summary.seen += 1;
        const { record: r } = mapRecord(raw, map);
        if (r.program_id != null) {
          await db.query(
            `INSERT INTO leagueapps_programs (program_id, name, registrations, last_seen_at) VALUES ($1, $2, 1, now())
             ON CONFLICT (org_id, program_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, leagueapps_programs.name),
               registrations = leagueapps_programs.registrations + 1, last_seen_at = now()`,
            [String(r.program_id), r.program_name ? String(r.program_name).slice(0, 200) : null],
          );
        }
        const t = r.program_id != null ? byProgram.get(String(r.program_id)) : null;
        if (!t) {
          summary.skipped_unlinked += 1;
          continue;
        }
        try {
          const res = await db.tx(async (c) => {
            const fresh = (await c.query("SELECT * FROM tournaments WHERE id = $1 FOR UPDATE", [t.id])).rows[0];
            return registrations.upsertRegistration(c, fresh, {
              first_name: r.first_name, last_name: r.last_name, email: r.email, birth_date: r.birth_date, leagueapps_user_id: r.user_id,
            }, {
              source: "leagueapps", status: r.status, leagueapps_registration_id: /^\d+$/.test(String(r.registration_id)) ? String(r.registration_id) : null,
              leagueapps_program_id: String(r.program_id), program_name: r.program_name ? String(r.program_name).slice(0, 200) : null,
              registered_at: r.registered_at ? new Date(Number.isFinite(Number(r.registered_at)) ? Number(r.registered_at) : r.registered_at) : null,
            });
          });
          if (res.created) summary.created += 1;
          else if (res.updated) summary.updated += 1;
          if (res.registration.status === "cancelled") summary.cancelled += 1;
          if (res.created && res.history?.has_history) summary.returning += 1;
          if (res.created && res.registration.needs_review) summary.needs_review += 1;
        } catch (err) {
          if (summary.errors.length < 50) summary.errors.push({ leagueapps_registration_id: r.registration_id ?? null, error: err.message });
        }
      }
      summary.cursor = cursor;
      await db.query(
        `INSERT INTO sync_state (source, last_updated, last_id, last_run_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (org_id, source) DO UPDATE SET last_updated = $2, last_id = $3, last_run_at = now()`,
        [SOURCE, cursor.lastUpdated, cursor.lastId],
      );
    }
    await db.query(
      `INSERT INTO sync_state (source, last_updated, last_id, last_run_at, last_result) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (org_id, source) DO UPDATE SET last_run_at = now(), last_result = $4`,
      [SOURCE, summary.cursor.lastUpdated, summary.cursor.lastId, JSON.stringify(summary)],
    );
    if (summary.created || summary.updated) emitDomain("registrations.synced", { created: summary.created, updated: summary.updated });
    return summary;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
    client.release();
  }
}

const MEMBERS_SOURCE = "leagueapps-members-2";

/**
 * BLPA Factions member import (ported from the standalone Factions app):
 * every LeagueApps member with an email becomes a Factions member and gets
 * their Order, even before they register for a tournament. members-2 is
 * the export whose fields are documented (id, userId, firstName, lastName,
 * email, deleted, lastUpdated). Existing members keep their Order.
 */
async function syncMembers({ fromScratch = false } = {}) {
  if (!isConfigured()) throw new HttpError(503, "LeagueApps isn't configured (set LEAGUEAPPS_SITE_ID, LEAGUEAPPS_CLIENT_ID, LEAGUEAPPS_PRIVATE_KEY)");
  const factions = require("./factions");
  const client = await db.connect();
  const lockKey = 4815162343;
  try {
    const locked = (await client.query("SELECT pg_try_advisory_lock($1) AS ok", [lockKey])).rows[0].ok;
    if (!locked) throw conflict("a LeagueApps member import is already running");
    const saved = await db.one("SELECT * FROM sync_state WHERE source = $1", [MEMBERS_SOURCE]);
    const start = fromScratch || !saved ? { lastUpdated: 0, lastId: 0 } : { lastUpdated: Number(saved.last_updated), lastId: Number(saved.last_id) };
    const summary = { pages: 0, seen: 0, new_members: 0, existing_members: 0, skipped_deleted: 0, skipped_no_email: 0, errors: [], cursor: start };
    for await (const { rows, cursor } of iterate("members-2", start)) {
      summary.pages += 1;
      for (const m of rows) {
        summary.seen += 1;
        if (m.deleted) {
          summary.skipped_deleted += 1;
          continue;
        }
        if (!m.email) {
          summary.skipped_no_email += 1;
          continue;
        }
        try {
          const { created } = await factions.getOrCreateMember({
            email: m.email,
            display_name: [m.firstName, m.lastName].filter(Boolean).join(" ") || null,
            leagueapps_user_id: m.userId != null ? String(m.userId) : null,
            source: "leagueapps",
          });
          if (created) summary.new_members += 1;
          else summary.existing_members += 1;
        } catch (err) {
          if (summary.errors.length < 50) summary.errors.push({ leagueapps_user_id: m.userId ?? null, error: err.message });
        }
      }
      summary.cursor = cursor;
      await db.query(
        `INSERT INTO sync_state (source, last_updated, last_id, last_run_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (org_id, source) DO UPDATE SET last_updated = $2, last_id = $3, last_run_at = now()`,
        [MEMBERS_SOURCE, cursor.lastUpdated, cursor.lastId],
      );
    }
    await db.query(
      `INSERT INTO sync_state (source, last_updated, last_id, last_run_at, last_result) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (org_id, source) DO UPDATE SET last_run_at = now(), last_result = $4`,
      [MEMBERS_SOURCE, summary.cursor.lastUpdated, summary.cursor.lastId, JSON.stringify(summary)],
    );
    if (summary.new_members) emitDomain("factions.updated", { imported: summary.new_members });
    return summary;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
    client.release();
  }
}

/** First few raw records with how each field was read, to confirm the mapping. */
async function preview() {
  if (!isConfigured()) throw new HttpError(503, "LeagueApps isn't configured");
  const rows = (await exportPage("registrations-2", { lastUpdated: 0, lastId: 0 })).slice(0, 5);
  const { map, override } = await fieldMap();
  return {
    record_fields: [...new Set(rows.flatMap((r) => Object.keys(r)))].sort(),
    mapped: rows.map((r) => mapRecord(r, map)),
    override,
    candidates: FIELD_CANDIDATES,
  };
}

async function setFieldMap(input) {
  const clean = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in FIELD_CANDIDATES)) throw new HttpError(400, `unknown field "${k}"`);
    if (v === null || v === "") continue;
    if (typeof v !== "string" || !/^[A-Za-z_][\w.]{0,60}$/.test(v)) throw new HttpError(400, `field name for ${k} isn't valid`);
    clean[k] = v;
  }
  await db.query(
    "INSERT INTO integration_settings (key, value) VALUES ('leagueapps_field_map', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify(clean)],
  );
  return clean;
}

async function status() {
  const s = settings();
  const [state, programs] = await Promise.all([
    db.one("SELECT * FROM sync_state WHERE source = $1", [SOURCE]),
    db.many(
      `SELECT p.*, (SELECT json_agg(json_build_object('id', t.id, 'name', t.name)) FROM tournaments t WHERE p.program_id = ANY(t.leagueapps_program_ids)) AS tournaments
         FROM leagueapps_programs p ORDER BY p.last_seen_at DESC LIMIT 200`,
    ),
  ]);
  return {
    configured: isConfigured(),
    site_id: s.siteId || null,
    api_base: s.apiBase,
    last_run_at: state?.last_run_at || null,
    last_result: state?.last_result || null,
    cursor: state ? { last_updated: state.last_updated, last_id: state.last_id } : null,
    programs,
    auto_sync_minutes: Number(process.env.LEAGUEAPPS_SYNC_INTERVAL_MIN || 0),
    members: await db.one("SELECT last_run_at, last_result FROM sync_state WHERE source = $1", [MEMBERS_SOURCE]),
  };
}

let timer = null;
function startSchedule(log = console) {
  const minutes = Number(process.env.LEAGUEAPPS_SYNC_INTERVAL_MIN || 0);
  if (!minutes || !require("../lib/context").withOrg(LA_ORG_ID, isConfigured) || timer) return;
  const { withOrg } = require("../lib/context");
  timer = setInterval(() => withOrg(LA_ORG_ID, () => {
    sync().then((s) => s.created + s.updated && log.log(`LeagueApps sync: ${s.created} new, ${s.updated} updated`))
      .catch((err) => err.status !== 409 && log.error("LeagueApps sync failed:", err.message))
      .then(() => syncMembers())
      .then((s) => s && s.new_members && log.log(`LeagueApps members: ${s.new_members} new Factions members`))
      .catch((err) => err.status !== 409 && log.error("LeagueApps member import failed:", err.message));
  }), Math.max(5, minutes) * 60000);
  timer.unref();
}

module.exports = {
  SOURCE, MEMBERS_SOURCE, FIELD_CANDIDATES, settings, isConfigured, buildAssertion, accessToken, exportPage, iterate, mapRecord, sync, syncMembers, preview,
  setFieldMap, status, startSchedule, timing, _reset: () => (tokenCache = null),
};

const { parseCsv, sniffDelimiter, normalizeHeader } = require("../lib/csv");
const { readXlsx, isXlsx } = require("../lib/xlsx");
const { safeFetch } = require("../lib/netguard");
const { badRequest, HttpError } = require("../lib/http");

// Where historical stats come from, made flexible: an uploaded file (CSV,
// TSV, Excel .xlsx, JSON), pasted text, or a link (a Google Sheet, Dropbox
// or OneDrive file, any https CSV/JSON). Every source becomes the same
// table: column names + rows. A preview guesses what each column means
// (goals, assists, season, division…) and the admin confirms or changes
// that mapping before anything is imported.

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20000;

/**
 * Fields an import understands. `key` is the column name the importers
 * read; `aliases` are normalized header names that mean the same thing.
 */
const FIELDS = [
  // Who
  { field: "name", key: "name", group: "player", label: "Full name", aliases: ["name", "player", "player_name", "full_name", "skater", "goalie_name"] },
  { field: "first_name", key: "first_name", group: "player", label: "First name", aliases: ["first_name", "first", "firstname", "given_name", "fname"] },
  { field: "last_name", key: "last_name", group: "player", label: "Last name", aliases: ["last_name", "last", "lastname", "surname", "family_name", "lname"] },
  { field: "email", key: "email", group: "player", label: "Email", aliases: ["email", "e_mail", "email_address", "player_email"] },
  { field: "birth_date", key: "birth_date", group: "player", label: "Birth date", aliases: ["birth_date", "dob", "date_of_birth", "birthdate", "birthday"] },
  { field: "external_id", key: "external_id", group: "player", label: "ID from the other system", aliases: ["external_id", "ext_id", "member_id", "user_id", "player_id_external", "usa_hockey_id", "usah_id"] },
  { field: "position", key: "position", group: "player", label: "Position", aliases: ["position", "pos"] },
  { field: "number", key: "number", group: "player", label: "Jersey number", aliases: ["number", "no", "jersey", "jersey_number", "num", "sweater"] },
  // Where
  { field: "season", key: "season", group: "where", label: "Season", aliases: ["season", "year", "season_name", "season_year", "yr"] },
  { field: "division", key: "division", group: "where", label: "Division", aliases: ["division", "div", "level", "tier", "flight", "league_level", "skill_level", "class"] },
  { field: "team_name", key: "team_name", group: "where", label: "Team", aliases: ["team_name", "team", "tm", "club"] },
  // Skater stats
  { field: "gp", key: "gp", group: "skater", label: "Games played", aliases: ["gp", "games_played", "games", "g_p"] },
  { field: "goals", key: "g", group: "skater", label: "Goals", aliases: ["g", "goals", "gls"] },
  { field: "assists", key: "a", group: "skater", label: "Assists", aliases: ["a", "assists", "ast", "asst"] },
  { field: "pim", key: "pim", group: "skater", label: "Penalty minutes", aliases: ["pim", "penalty_minutes", "pen_min", "pims"] },
  { field: "plus_minus", key: "plus_minus", group: "skater", label: "+/-", aliases: ["plus_minus", "pm"] },
  { field: "ppg", key: "ppg", group: "skater", label: "Power-play goals", aliases: ["ppg", "pp_goals", "power_play_goals", "pp"] },
  { field: "ppa", key: "ppa", group: "skater", label: "Power-play assists", aliases: ["ppa", "pp_assists", "power_play_assists"] },
  { field: "shg", key: "shg", group: "skater", label: "Short-handed goals", aliases: ["shg", "sh_goals", "shorthanded_goals", "sh"] },
  { field: "sha", key: "sha", group: "skater", label: "Short-handed assists", aliases: ["sha", "sh_assists", "shorthanded_assists"] },
  { field: "gwg", key: "gwg", group: "skater", label: "Game-winning goals", aliases: ["gwg", "game_winning_goals", "gw"] },
  { field: "shots", key: "sog", group: "skater", label: "Shots", aliases: ["sog", "shots", "s", "shots_on_goal"] },
  { field: "hits", key: "hits", group: "skater", label: "Hits", aliases: ["hits", "hit"] },
  { field: "blocks", key: "blk", group: "skater", label: "Blocked shots", aliases: ["blk", "blocks", "blocked_shots", "bks"] },
  { field: "fow", key: "fow", group: "skater", label: "Faceoffs won", aliases: ["fow", "faceoffs_won", "fo_won"] },
  { field: "fol", key: "fol", group: "skater", label: "Faceoffs lost", aliases: ["fol", "faceoffs_lost", "fo_lost"] },
  // Goalie stats
  { field: "goalie_gp", key: "goalie_gp", group: "goalie", label: "Goalie games", aliases: ["goalie_gp", "gpi", "gp_g", "goalie_games"] },
  { field: "wins", key: "w", group: "goalie", label: "Wins", aliases: ["w", "wins"] },
  { field: "losses", key: "l", group: "goalie", label: "Losses", aliases: ["l", "losses"] },
  { field: "ot_losses", key: "otl", group: "goalie", label: "OT/SO losses", aliases: ["otl", "ot_losses", "sol", "ot_so_l"] },
  { field: "ties", key: "t", group: "goalie", label: "Ties", aliases: ["t", "ties"] },
  { field: "shots_against", key: "sa", group: "goalie", label: "Shots against", aliases: ["sa", "shots_against"] },
  { field: "goals_against", key: "ga", group: "goalie", label: "Goals against", aliases: ["ga", "goals_against"] },
  { field: "saves", key: "sv", group: "goalie", label: "Saves", aliases: ["sv", "saves"] },
  { field: "shutouts", key: "so", group: "goalie", label: "Shutouts", aliases: ["so", "shutouts", "sho"] },
  { field: "toi_min", key: "min", group: "goalie", label: "Minutes played", aliases: ["min", "mins", "minutes", "toi", "mp"] },
];
const BY_FIELD = new Map(FIELDS.map((f) => [f.field, f]));

// ---------------------------------------------------------------------------
// Loading

/** Google Sheets / Dropbox / OneDrive share links → their direct download. */
function directUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw badRequest("that link isn't a valid URL");
  }
  if (u.protocol !== "https:") throw badRequest("links must start with https://");
  const sheet = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  if (u.hostname === "docs.google.com" && sheet && !/\/(export|pub)/.test(u.pathname)) {
    const gid = (/gid=(\d+)/.exec(u.hash + u.search) || [])[1];
    return `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
  }
  if (/(^|\.)dropbox\.com$/.test(u.hostname)) {
    u.searchParams.delete("dl");
    u.searchParams.set("dl", "1");
  }
  return u.toString();
}

async function fetchLink(url) {
  const target = directUrl(url);
  let res;
  try {
    res = await safeFetch(target, { headers: { accept: "text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*" }, signal: AbortSignal.timeout(20000) }, { maxRedirects: 5 });
  } catch (err) {
    if (err.status) throw err;
    throw new HttpError(502, `Couldn't download the link (${err.message})`);
  }
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 || res.status === 404
      ? " Make it viewable by anyone with the link (Google Sheets: Share → Anyone with the link → Viewer)." : "";
    throw new HttpError(400, `The link answered HTTP ${res.status}.${hint}`);
  }
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw badRequest("that file is larger than 10 MB");
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw badRequest("that file is larger than 10 MB");
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  const type = res.headers.get("content-type") || "";
  if (/text\/html/.test(type) && /<html/i.test(buf.subarray(0, 2000).toString("utf8"))) {
    throw badRequest("The link opened a web page, not a file. Share it as \"anyone with the link\", or download the file and upload it.");
  }
  return { buf, name: decodeURIComponent(new URL(target).pathname.split("/").pop() || "download"), type };
}

/** Flattens nested JSON objects one level deep: { player: { name } } → "player.name". */
function flatten(obj, prefix = "", out = {}, depth = 0) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) flatten(v, key, out, depth + 1);
    else out[key] = v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** The list of records in a JSON document: the array itself, or the biggest array of objects inside it. */
function jsonRecords(doc) {
  if (Array.isArray(doc)) return doc;
  let best = null;
  const visit = (x, depth) => {
    if (!x || typeof x !== "object" || depth > 3) return;
    for (const v of Object.values(x)) {
      if (Array.isArray(v) && v.length && v.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
        if (!best || v.length > best.length) best = v;
      } else if (v && typeof v === "object") visit(v, depth + 1);
    }
  };
  visit(doc, 0);
  if (!best) throw badRequest("no list of records found in the JSON");
  return best;
}

/** Tables (name + rows of cells) from file bytes. */
function tablesFrom(buf, name = "") {
  if (isXlsx(buf)) {
    try {
      return readXlsx(buf);
    } catch (err) {
      throw badRequest(`Couldn't read the spreadsheet: ${err.message}. Save it as .xlsx or CSV and try again.`);
    }
  }
  if (/\.xls$/i.test(name) || (buf[0] === 0xd0 && buf[1] === 0xcf)) throw badRequest("Old Excel .xls files can't be read: save it as .xlsx or CSV.");
  const text = buf.toString("utf8").replace(/^﻿/, "");
  const trimmed = text.trim();
  if (/\.json$/i.test(name) || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let doc;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      throw badRequest("the JSON couldn't be read");
    }
    const recs = jsonRecords(doc).map((r) => flatten(r));
    const cols = [];
    for (const r of recs) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    return [{ name: "JSON", rows: [cols, ...recs.map((r) => cols.map((c) => r[c] ?? ""))] }];
  }
  const delim = /\.tsv$/i.test(name) ? "\t" : sniffDelimiter(text);
  return [{ name: name || "CSV", rows: parseCsv(text, delim).map((r) => r.map((v) => v.trim())) }];
}

const knownAliases = new Set(FIELDS.flatMap((f) => f.aliases));

/** The header row: the first of the top 15 rows that looks most like column names. */
function headerRowIndex(rows) {
  let best = 0;
  let bestScore = -1;
  rows.slice(0, 15).forEach((row, i) => {
    const filled = row.filter((v) => v !== "").length;
    const known = row.filter((v) => knownAliases.has(normalizeHeader(v)) || knownAliases.has(lastPart(v))).length;
    const score = known * 3 + (filled >= 2 ? 1 : 0) - row.filter((v) => /^-?\d+(\.\d+)?$/.test(v)).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}
const lastPart = (h) => normalizeHeader(String(h).split(".").pop());

/**
 * Loads a source into { columns, records, sheets, sheet }.
 *   { type: "file", name, data_base64 }   uploaded file (CSV, TSV, XLSX, JSON)
 *   { type: "text", text }                pasted CSV / tab-separated / JSON
 *   { type: "url", url }                  a link (Google Sheets, Dropbox, OneDrive, https)
 *   { type: "rows", rows }                already-parsed objects (API callers)
 */
async function load(source = {}, { sheet } = {}) {
  let tables;
  let label;
  if (source.type === "rows" || Array.isArray(source.rows)) {
    const recs = (source.rows || []).map((r) => flatten(r));
    const cols = [];
    for (const r of recs) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    tables = [{ name: "rows", rows: [cols, ...recs.map((r) => cols.map((c) => r[c] ?? ""))] }];
    label = "rows";
  } else if (source.type === "file") {
    const buf = Buffer.from(String(source.data_base64 || ""), "base64");
    if (!buf.length) throw badRequest("the file is empty");
    if (buf.length > MAX_BYTES) throw badRequest("that file is larger than 10 MB");
    tables = tablesFrom(buf, source.name);
    label = source.name || "file";
  } else if (source.type === "text") {
    if (!String(source.text || "").trim()) throw badRequest("paste the stats first");
    tables = tablesFrom(Buffer.from(String(source.text)), "");
    label = "pasted";
  } else if (source.type === "url") {
    const { buf, name } = await fetchLink(source.url);
    tables = tablesFrom(buf, name);
    label = source.url;
  } else {
    throw badRequest("source.type must be file, text, url or rows");
  }
  const usable = tables.filter((t) => t.rows.length > 1);
  if (!usable.length) throw badRequest("no rows found (a header row and at least one row of stats are needed)");
  const chosen = (sheet && usable.find((t) => t.name === sheet)) || usable[0];
  const h = headerRowIndex(chosen.rows);
  const rawHeader = chosen.rows[h];
  // Blank or repeated headers get a usable name.
  const seen = new Map();
  const columns = rawHeader.map((c, i) => {
    const base = c || `Column ${i + 1}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const records = chosen.rows.slice(h + 1)
    .filter((r) => r.some((v) => v !== ""))
    // Repeated header rows and "Totals" lines inside exports aren't players.
    .filter((r) => !(r.join("|") === rawHeader.join("|")) && !/^(totals?|team totals?)$/i.test(String(r[0] || "")))
    .map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""])));
  if (records.length > MAX_ROWS) throw badRequest(`too many rows (${records.length}; at most ${MAX_ROWS} per import)`);
  return { columns, records, sheets: usable.map((t) => t.name), sheet: chosen.name, header_row: h + 1, label };
}

// ---------------------------------------------------------------------------
// Mapping

/** Best guess of which column holds each field. */
function guessMapping(columns) {
  const mapping = {};
  const taken = new Set();
  // Exact header matches first, then the last part of dotted JSON names.
  const compact = (x) => x.replace(/_/g, "");
  const passes = [(c, a) => normalizeHeader(c) === a, (c, a) => lastPart(c) === a, (c, a) => a.length > 2 && compact(lastPart(c)) === compact(a)];
  for (const matches of passes) {
    for (const f of FIELDS) {
      if (mapping[f.field]) continue;
      for (const alias of f.aliases) {
        const col = columns.find((c) => !taken.has(c) && matches(c, alias));
        if (col) {
          mapping[f.field] = col;
          taken.add(col);
          break;
        }
      }
    }
  }
  // A full-name column isn't needed when first and last are there.
  if (mapping.first_name && mapping.last_name) delete mapping.name;
  return mapping;
}

function cleanMapping(mapping, columns) {
  const out = {};
  for (const [field, col] of Object.entries(mapping || {})) {
    if (!col) continue;
    if (!BY_FIELD.has(field)) throw badRequest(`unknown field "${field}"`);
    if (!columns.includes(col)) throw badRequest(`column "${col}" isn't in the file`);
    out[field] = col;
  }
  if (!out.name && !(out.first_name && out.last_name) && !out.email && !out.external_id) {
    throw badRequest("choose the player's name column (or first and last name)");
  }
  return out;
}

/** Records → importer rows (canonical column names) using the mapping. */
function applyMapping(records, mapping) {
  return records.map((r) => {
    const row = {};
    for (const [field, col] of Object.entries(mapping)) {
      const v = r[col];
      if (v !== undefined && v !== "") row[BY_FIELD.get(field).key] = String(v).trim();
    }
    return row;
  });
}

/** Values in a column with how often each appears (for seasons and divisions). */
function distinct(records, col) {
  if (!col) return [];
  const m = new Map();
  for (const r of records) {
    const v = String(r[col] ?? "").trim();
    if (v) m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].map(([value, rows]) => ({ value, rows })).sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
}

/** What a source contains and how its columns will be read. */
async function preview(source, { sheet, mapping } = {}) {
  const t = await load(source, { sheet });
  const map = mapping && Object.keys(mapping).length ? Object.fromEntries(Object.entries(mapping).filter(([, c]) => t.columns.includes(c))) : guessMapping(t.columns);
  const used = new Set(Object.values(map));
  return {
    label: t.label, sheets: t.sheets, sheet: t.sheet, header_row: t.header_row, row_count: t.records.length,
    columns: t.columns, mapping: map, unmapped: t.columns.filter((c) => !used.has(c)),
    sample: t.records.slice(0, 8),
    seasons: distinct(t.records, map.season), divisions: distinct(t.records, map.division), teams: distinct(t.records, map.team_name),
    fields: FIELDS.map(({ field, group, label }) => ({ field, group, label })),
  };
}

module.exports = { FIELDS, load, preview, guessMapping, cleanMapping, applyMapping, distinct, directUrl, tablesFrom };

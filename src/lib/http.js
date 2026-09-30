class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const notFound = (what = "resource") => new HttpError(404, `${what} not found`);
const conflict = (msg) => new HttpError(409, msg);

function intParam(value, name = "id") {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`invalid ${name}`);
  return n;
}

function optInt(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be an integer${Number.isFinite(min) ? ` >= ${min}` : ""}${Number.isFinite(max) ? ` <= ${max}` : ""}`);
  return n;
}

function optEnum(value, name, allowed) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!allowed.includes(value)) throw badRequest(`${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

function optString(value, name, { max = 200 } = {}) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw badRequest(`${name} must be a string`);
  const s = value.trim();
  if (s.length > max) throw badRequest(`${name} is too long`);
  return s === "" ? null : s;
}

function optBool(value, name) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  throw badRequest(`${name} must be a boolean`);
}

function requireFields(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === "");
  if (missing.length) throw badRequest(`missing required field(s): ${missing.join(", ")}`);
}

/**
 * Builds "SET a = $1, b = $2" from the defined keys of `fields`, for
 * PATCH-style updates. Returns null when nothing is being changed.
 */
function buildUpdate(fields, startIndex = 1) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (!keys.length) return null;
  return {
    set: keys.map((k, i) => `${k} = $${i + startIndex}`).join(", "),
    values: keys.map((k) => fields[k]),
    next: startIndex + keys.length,
  };
}

/** Translates Postgres constraint violations into 4xx responses. */
function pgToHttp(err) {
  if (err instanceof HttpError) return err;
  switch (err && err.code) {
    case "23505":
      return conflict(uniqueMessage(err));
    case "23502":
      return badRequest(`${err.column || "a required field"} can't be blank`);
    case "23503":
      return badRequest("referenced record does not exist");
    case "23514":
      return badRequest(`value violates constraint ${err.constraint || ""}`.trim());
    case "22P02":
    case "22003":
      return badRequest("invalid value");
    default:
      return null;
  }
}

function uniqueMessage(err) {
  if (err.constraint === "roster_team_number_uniq") return "that jersey number is already taken on this team";
  if (err.constraint === "roster_entries_tournament_id_player_id_key") return "player is already on a team in this tournament";
  if (err.constraint === "teams_tournament_id_name_key") return "a team with that name already exists in this tournament";
  if (err.constraint === "players_email_key") return "a player with that email already exists";
  if (err.constraint === "players_external_id_key") return "a player with that external_id already exists";
  return "duplicate value";
}

module.exports = {
  HttpError, badRequest, notFound, conflict, intParam, optInt, optEnum, optString, optBool,
  requireFields, buildUpdate, pgToHttp,
};

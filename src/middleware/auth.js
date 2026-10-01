const crypto = require("crypto");
const config = require("../config");
const db = require("../db");
const { HttpError } = require("../lib/http");
const { failureCounter } = require("../lib/rateLimit");

const RANK = { readonly: 1, scorekeeper: 2, admin: 3 };
const MIN_ADMIN_TOKEN_LENGTH = 16;

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** Constant-time comparison that doesn't leak the secret's length. */
function safeEqual(a, b) {
  const ah = crypto.createHash("sha256").update(String(a)).digest();
  const bh = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function extractToken(req) {
  const auth = req.header("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return req.header("x-api-key") || req.header("x-admin-token") || null;
}

// Brute-force protection: after N bad keys from one IP in 15 minutes, every
// authenticated request from that IP is refused until the window passes.
const failures = failureCounter({ windowMs: 15 * 60 * 1000, max: config.rateLimits.authFailuresPer15Min });

/**
 * Resolves the caller's role from ADMIN_TOKEN or a stored API key and
 * attaches it as req.auth. Requests without credentials continue as
 * anonymous (public reads); requireRole() rejects them where needed.
 *
 * Fails closed: with no ADMIN_TOKEN configured nobody is an admin, unless
 * ALLOW_OPEN_DEV=true on a non-deployed machine (local development).
 */
async function authenticate(req, res, next) {
  req.auth = { role: null, via: null };
  if (req.query && ["token", "api_key", "key", "access_token"].some((k) => k in req.query)) {
    return next(new HttpError(400, "send API keys in the Authorization header, never in the URL"));
  }
  const token = extractToken(req);
  if (!config.adminToken && config.allowOpenDev) {
    req.auth = { role: "admin", via: "dev-open" };
    return next();
  }
  if (!token) return next();

  const blockedFor = failures.blocked(req.ip);
  if (blockedFor) {
    res.set("Retry-After", String(blockedFor));
    req.auth = { role: null, via: "blocked" };
    return next(new HttpError(429, `too many failed sign-in attempts; try again in ${Math.ceil(blockedFor / 60)} min`));
  }

  if (config.adminToken && safeEqual(token, config.adminToken)) {
    req.auth = { role: "admin", via: "admin-token", actor: "admin-token" };
    return next();
  }
  const key = await db.one(
    `UPDATE api_keys SET last_used_at = now()
      WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      RETURNING id, name, role, tournament_id`,
    [hashKey(token)],
  );
  if (key) {
    req.auth = { role: key.role, via: "api-key", keyId: key.id, keyName: key.name, tournamentId: key.tournament_id, actor: `key:${key.id}:${key.name}` };
    return next();
  }
  failures.fail(req.ip);
  req.auth = { role: null, via: "invalid" };
  next(new HttpError(401, "invalid, expired or revoked API key"));
}

function hasRole(req, role) {
  return Boolean(req.auth && req.auth.role && RANK[req.auth.role] >= RANK[role]);
}

function requireRole(role) {
  return (req, _res, next) => {
    if (hasRole(req, role)) return next();
    const status = req.auth && req.auth.role ? 403 : 401;
    next(new HttpError(status, status === 401 ? "missing or invalid API key" : `requires ${role} access`));
  };
}

/**
 * Object-level check for keys limited to one tournament: the resource's
 * tournament must match. Admin-token and unscoped keys pass.
 */
function assertTournamentScope(req, tournamentId) {
  const scope = req.auth && req.auth.tournamentId;
  if (scope && Number(scope) !== Number(tournamentId)) {
    throw new HttpError(403, "this key is limited to a different tournament");
  }
}

function generateKey() {
  return `blst_${crypto.randomBytes(24).toString("base64url")}`;
}

module.exports = {
  authenticate, requireRole, hasRole, assertTournamentScope, hashKey, generateKey, safeEqual, failures, MIN_ADMIN_TOKEN_LENGTH,
};

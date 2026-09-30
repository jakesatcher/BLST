const crypto = require("crypto");
const config = require("../config");
const db = require("../db");
const { HttpError } = require("../lib/http");

const RANK = { readonly: 1, scorekeeper: 2, admin: 3 };

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function extractToken(req) {
  const auth = req.header("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return req.header("x-api-key") || req.header("x-admin-token") || null;
}

/**
 * Resolves the caller's role from ADMIN_TOKEN or a stored API key and
 * attaches it as req.auth. Never rejects on its own — requireRole does.
 *
 * With no ADMIN_TOKEN configured (local development only; the server
 * refuses to boot that way when deployed) every request is treated as
 * admin, mirroring the BLPA Factions app.
 */
async function authenticate(req, _res, next) {
  req.auth = { role: null, via: null };
  const token = extractToken(req);
  if (!config.adminToken) {
    req.auth = { role: "admin", via: "dev-open" };
    return next();
  }
  if (!token) return next();
  if (safeEqual(token, config.adminToken)) {
    req.auth = { role: "admin", via: "admin-token" };
    return next();
  }
  const key = await db.one(
    "UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, name, role",
    [hashKey(token)],
  );
  if (key) req.auth = { role: key.role, via: "api-key", keyId: key.id, keyName: key.name };
  next();
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

function generateKey() {
  return `blst_${crypto.randomBytes(24).toString("base64url")}`;
}

module.exports = { authenticate, requireRole, hasRole, hashKey, generateKey };

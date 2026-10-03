const config = require("../config");
const db = require("../db");
const { withOrg } = require("../lib/context");

// Which organization a request is for, from the host name:
//   <APP_DOMAIN>, www.<APP_DOMAIN>      the platform (sign up, request an org)
//   <slug>.<APP_DOMAIN>                 that organization
//   <slug>.localhost                    that organization (local development)
//   anything else                       DEFAULT_ORG, when set (e.g. Railway's
//                                       generated *.up.railway.app address)
// Everything after this runs in that organization's database context.

const RESERVED = new Set(["www", "api", "app", "admin", "platform", "stats", "factions", "mail", "smtp", "static", "assets", "cdn", "status", "help", "support", "docs", "blog"]);
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

let cache = new Map();
const CACHE_MS = 15000;
function invalidateOrgCache() {
  cache = new Map();
}

async function findOrg(slug) {
  const hit = cache.get(slug);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.org;
  const org = await db.one("SELECT id, slug, name, status, factions_enabled, tournament_types, onboarding FROM organizations WHERE slug = $1", [slug]);
  cache.set(slug, { org, at: Date.now() });
  return org;
}

/** The organization slug a host name points at, "" for the platform, or null for "use the default". */
function slugFromHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  const apex = config.appDomain;
  if (apex) {
    if (h === apex || h === `www.${apex}`) return "";
    if (h.endsWith(`.${apex}`)) return h.slice(0, -(apex.length + 1));
  }
  if (h.endsWith(".localhost")) return h.slice(0, -".localhost".length);
  return null;
}

async function resolveOrg(req, _res, next) {
  let slug = slugFromHost(req.hostname);
  if (slug === null) slug = config.defaultOrg || "";
  req.org = null;
  req.orgMissing = null;
  if (slug) {
    const org = SLUG_RE.test(slug) ? await findOrg(slug) : null;
    if (org && org.status === "active") req.org = org;
    else req.orgMissing = { slug, status: org ? org.status : "missing" };
  }
  withOrg(req.org ? req.org.id : "", () => next());
}

/** API requests for an organization that doesn't exist (or isn't live) stop here. */
function requireLiveOrg(req, res, next) {
  if (!req.orgMissing) return next();
  const pending = req.orgMissing.status === "pending";
  res.status(404).json({ error: pending ? "this organization is waiting for approval" : "organization not found" });
}

module.exports = { resolveOrg, requireLiveOrg, slugFromHost, invalidateOrgCache, findOrg, RESERVED, SLUG_RE };

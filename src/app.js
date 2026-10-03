const path = require("path");
const net = require("net");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const config = require("./config");
const db = require("./db");
const { authenticate } = require("./middleware/auth");
const { resolveOrg, requireLiveOrg } = require("./middleware/org");
const { HttpError, pgToHttp } = require("./lib/http");
const { rateLimit } = require("./lib/rateLimit");

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Heroku's router is the single trusted proxy: req.ip / req.protocol come
  // from its X-Forwarded-* headers, nothing further upstream is trusted.
  app.set("trust proxy", 1);
  app.use((req, _res, next) => {
    if (config.clientIpHeader) {
      const v = (req.get(config.clientIpHeader) || "").trim();
      if (net.isIP(v)) Object.defineProperty(req, "ip", { value: v, configurable: true });
    }
    next();
  });

  // Plain HTTP is redirected to HTTPS once deployed (HSTS takes over after).
  if (config.deployed) {
    app.use((req, res, next) => {
      if (req.secure || req.path === "/health") return next();
      // Only a plain host[:port] goes into the redirect (no open redirect via Host).
      const host = String(req.headers.host || "");
      if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(host)) return res.status(400).send("bad host");
      res.redirect(308, `https://${host}${req.originalUrl}`);
    });
  }

  // Which organization (from the subdomain); everything after runs as it.
  app.use(resolveOrg);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "blob:"],
          // Watch page: embedded players and video from the stream host.
          "frame-src": ["'self'", "https:"],
          "media-src": ["'self'", "https:", "blob:"],
          "connect-src": ["'self'", "https:"],
          "worker-src": ["'self'", "blob:"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'self'"],
        },
      },
      strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );
  app.use((_req, res, next) => {
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
    next();
  });

  // Reads and the export API are meant to be called from other sites.
  // Credentials are bearer tokens (never cookies), so CORS isn't what
  // protects writes; CORS_ORIGINS can still narrow it.
  const allowAll = config.corsOrigins.includes("*");
  app.use("/api", cors({
    origin: allowAll ? "*" : config.corsOrigins,
    exposedHeaders: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After", "Content-Disposition"],
    maxAge: 600,
  }));

  // Body size limits: large uploads only where they're needed.
  const big = { limit: "10mb" };
  app.use("/api/v1/import", express.json(big), express.text({ type: ["text/csv", "text/plain"], ...big }));
  app.use(/^\/api\/v1\/tournaments\/\d+\/registrations\/import$/, express.json(big), express.text({ type: ["text/csv", "text/plain"], ...big }));
  app.use("/api/v1/factions/members/import", express.json(big), express.text({ type: ["text/csv", "text/plain"], ...big }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.text({ type: ["text/csv", "text/plain"], limit: "1mb" }));
  // A raw CSV body is accepted anywhere JSON { csv } is.
  app.use((req, _res, next) => {
    if (typeof req.body === "string") req.body = { csv: req.body, ...req.query };
    if (req.body === undefined) req.body = {};
    next();
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  if (config.securityContact) {
    app.get("/.well-known/security.txt", (_req, res) => {
      const expires = new Date(Date.now() + 365 * 86400e3).toISOString();
      res.type("text/plain").send(`Contact: ${config.securityContact}\nExpires: ${expires}\nPreferred-Languages: en\n`);
    });
  }

  const api = express.Router();
  api.use(auditTrail);
  api.use(requireLiveOrg);
  api.use(rateLimit({ windowMs: 60_000, max: config.rateLimits.readsPerMinute, name: "requests" }));
  api.use(rateLimit({ windowMs: 60_000, max: config.rateLimits.writesPerMinute, name: "changes", skip: (req) => !WRITE_METHODS.has(req.method) }));
  api.use("/import", rateLimit({ windowMs: 60_000, max: config.rateLimits.importsPerMinute, name: "imports", skip: (req) => req.method !== "POST" }));
  api.use(authenticate);
  // Responses to signed-in callers may contain private data: never cache them.
  api.use((req, res, next) => {
    if (req.auth.role || req.get("authorization")) res.set("Cache-Control", "no-store");
    next();
  });
  // On the platform's own address only platform and account routes exist;
  // everything else belongs to an organization's address.
  api.use((req, _res, next) => {
    if (req.org || /^\/(platform|auth|account|me|org)(\/|$)/.test(req.path)) return next();
    next(new HttpError(404, "open this from your organization's address"));
  });
  api.use(require("./routes/platform"));
  api.use(require("./routes/auth"));
  api.use(require("./routes/media"));
  api.use(require("./routes/streams"));
  api.use(require("./routes/tournaments"));
  api.use(require("./routes/players"));
  api.use(require("./routes/games"));
  api.use(require("./routes/stream"));
  api.use(require("./routes/importExport"));
  api.use(require("./routes/registrations"));
  api.use(require("./routes/history"));
  api.use(require("./routes/leagues"));
  api.use(require("./routes/factions"));
  api.use(require("./routes/admin"));
  api.use((_req, _res, next) => next(new HttpError(404, "not found")));
  app.use("/api/v1", api);

  // hls.js is served from our own origin (no third-party scripts).
  app.get("/vendor/hls.min.js", (_req, res) => {
    res.set("Cache-Control", "public, max-age=86400");
    res.sendFile(require.resolve("hls.js/dist/hls.min.js"));
  });
  // Pages. An organization's site: /stats, /factions, /admin, … ; the bare
  // domain: the platform (sign in, request an organization, approvals).
  const page = (name) => path.join(__dirname, "..", "public", `${name}.html`);
  const ORG_PAGES = /^\/(stats|league|history|club|factions|admin|scorekeeper|tournament|game|player|watch|overlay|api)(\.html)?\/?$|^\/index\.html$/;
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.orgMissing && (req.path === "/" || ORG_PAGES.test(req.path))) return res.status(404).type("html").send(missingOrgPage(req.orgMissing));
    if (req.path === "/") return req.org ? res.redirect(302, "/stats") : res.sendFile(page("platform"));
    if (!req.org && ORG_PAGES.test(req.path)) return res.redirect(302, "/");
    if (/^\/factions(\.html)?\/?$/.test(req.path) && !req.org.factions_enabled) return res.redirect(302, "/stats");
    if (/^\/stats\/?$/.test(req.path)) return res.sendFile(page("index"));
    if (/^\/platform\/?$/.test(req.path)) return res.sendFile(page("platform-admin"));
    next();
  });
  app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"], dotfiles: "ignore", index: false }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === "entity.parse.failed") err = new HttpError(400, "request body is not valid JSON");
    if (err.type === "entity.too.large") err = new HttpError(413, "request body too large");
    const http = pgToHttp(err);
    if (http) return res.status(http.status).json({ error: http.message, ...(http.details ? { details: http.details } : {}) });
    // Unexpected errors: details go to the server log only, never the client.
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });
  return app;
}

/**
 * Security audit trail: every change and every rejected request
 * (401/403/429), with who made it. Paths only: no query strings, bodies
 * or tokens are recorded.
 */
// Factions member ids are a reversible encoding of an email: never log them.
const loggedPath = (req) => `${req.baseUrl}${req.path}`.replace(/(\/factions\/members\/)(?!find$|import$)[^/]+/, "$1:id").slice(0, 300);

function auditTrail(req, res, next) {
  res.on("finish", () => {
    const rejected = [401, 403, 429].includes(res.statusCode);
    if (!WRITE_METHODS.has(req.method) && !rejected) return;
    const a = req.auth || {};
    if (rejected) console.warn(`[security] ${res.statusCode} ${req.method} ${loggedPath(req)} ip=${req.ip} actor=${a.actor || a.via || "anonymous"}`);
    db.query(
      "INSERT INTO audit_log (actor, role, key_id, method, path, status, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [a.actor || a.via || "anonymous", a.role || null, a.keyId || null, req.method, loggedPath(req),
        res.statusCode, req.ip, (req.get("user-agent") || "").slice(0, 200)],
    ).catch((err) => console.error("audit log write failed", err.message));
  });
  next();
}

/** Small static page for an unknown or not-yet-approved organization. */
function missingOrgPage({ slug, status }) {
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const home = config.appDomain ? `https://${config.appDomain}/` : "/";
  const msg = status === "pending" ? "This organization is waiting for approval." : status === "suspended" ? "This organization is suspended." : "There's no organization here.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(slug)} · Beer League Stats</title><link rel="icon" href="/icons/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/css/app.css"></head>
<body><main><div class="card auth-card"><h1>${esc(slug)}</h1><p>${esc(msg)}</p><p><a class="btn primary" href="${esc(home)}">Beer League Stats home</a></p></div></main></body></html>`;
}

module.exports = { createApp };

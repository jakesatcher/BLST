const crypto = require("crypto");
const { Router } = require("express");
const db = require("../db");
const { requireRole, requireInteractiveAdmin, hashKey, generateKey } = require("../middleware/auth");
const { badRequest, notFound, intParam, optInt, optEnum, optString, optBool, requireFields, buildUpdate } = require("../lib/http");
const { assertPublicUrl } = require("../lib/netguard");
const webhooks = require("../services/webhooks");

const router = Router();
const admin = requireRole("admin");
const person = requireInteractiveAdmin;

router.get("/me", (req, res) => {
  res.json({
    role: req.auth.role, via: req.auth.via, key_name: req.auth.keyName || null, tournament_id: req.auth.tournamentId || null,
    account_id: req.auth.accountId || null, email: req.auth.email || null, platform_admin: Boolean(req.auth.platformAdmin),
    mfa_required: Boolean(req.auth.mfaRequired),
    org: req.org ? { slug: req.org.slug, name: req.org.name, factions_enabled: req.org.factions_enabled } : null,
  });
});

// ---------------------------------------------------------------------------
// API keys. The plaintext key is only returned once, at creation.

router.get("/admin/api-keys", admin, async (_req, res) => {
  res.json(await db.many(
    `SELECT k.id, k.name, k.key_prefix, k.role, k.created_at, k.last_used_at, k.revoked_at, k.expires_at, k.tournament_id, t.name AS tournament
       FROM api_keys k LEFT JOIN tournaments t ON t.id = k.tournament_id ORDER BY k.id`,
  ));
});

router.post("/admin/api-keys", person, async (req, res) => {
  const name = optString(req.body.name, "name", { max: 80 });
  const role = optEnum(req.body.role, "role", ["admin", "scorekeeper", "readonly"]);
  if (!name || !role) throw badRequest("name and role are required");
  const tournamentId = optInt(req.body.tournament_id, "tournament_id", { min: 1 }) ?? null;
  const days = optInt(req.body.expires_in_days, "expires_in_days", { min: 1, max: 3650 }) ?? null;
  if (tournamentId && role === "admin") throw badRequest("admin keys can't be limited to one tournament; use a scorekeeper key");
  if (tournamentId && !(await db.one("SELECT 1 FROM tournaments WHERE id = $1", [tournamentId]))) throw badRequest("tournament not found");
  const key = generateKey();
  const row = await db.one(
    `INSERT INTO api_keys (name, key_prefix, key_hash, role, tournament_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END)
     RETURNING id, name, key_prefix, role, created_at, tournament_id, expires_at`,
    [name, key.slice(0, 12), hashKey(key), role, tournamentId, days],
  );
  res.status(201).json({ ...row, key });
});

router.delete("/admin/api-keys/:id", admin, async (req, res) => {
  const row = await db.one("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id", [intParam(req.params.id)]);
  if (!row) throw notFound("active API key");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Security audit log

router.get("/admin/audit-log", admin, async (req, res) => {
  const limit = optInt(req.query.limit, "limit", { min: 1, max: 1000 }) || 200;
  const onlyRejected = req.query.rejected === "true";
  res.json(await db.many(
    `SELECT id, at, actor, role, method, path, status, ip, user_agent FROM audit_log
      ${onlyRejected ? "WHERE status IN (401, 403, 429)" : ""} ORDER BY id DESC LIMIT $1`,
    [limit],
  ));
});

router.get("/admin/security", admin, async (_req, res) => {
  const config = require("../config");
  const { MIN_ADMIN_TOKEN_LENGTH } = require("../middleware/auth");
  const counts = await db.one(
    `SELECT count(*) FILTER (WHERE status IN (401, 403)) AS denied, count(*) FILTER (WHERE status = 429) AS throttled,
            count(*) FILTER (WHERE method <> 'GET' AND status < 400) AS changes
       FROM audit_log WHERE at > now() - interval '24 hours'`,
  );
  res.json({
    admin_token_set: Boolean(config.adminToken),
    admin_token_strong: config.adminToken.length >= MIN_ADMIN_TOKEN_LENGTH,
    open_dev_mode: !config.adminToken && config.allowOpenDev,
    deployed: config.deployed,
    public_exports: config.publicExports,
    cors_origins: config.corsOrigins,
    private_network_urls_allowed: config.allowPrivateUrls,
    rate_limits: config.rateLimits,
    last_24h: counts,
    database: {
      ...(await db.one(`SELECT current_user AS role, r.rolsuper AS superuser, r.rolcreaterole AS can_create_roles,
                               has_schema_privilege(current_user, 'public', 'CREATE') AS can_change_schema,
                               current_setting('statement_timeout') AS statement_timeout,
                               (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls
                          FROM pg_roles r WHERE r.rolname = current_user`)),
      separate_migration_login: Boolean(config.migrationDatabaseUrl),
      mode: config.dbMode || null,
    },
    client_ip_header: config.clientIpHeader || null,
    platform: config.platform,
    accounts: {
      ...(await db.one(`SELECT count(*) FILTER (WHERE role = 'admin' AND disabled_at IS NULL) AS admins,
                               count(*) FILTER (WHERE role = 'scorekeeper' AND disabled_at IS NULL) AS scorekeepers,
                               count(*) FILTER (WHERE role = 'user' AND disabled_at IS NULL) AS users FROM accounts`)),
      email_configured: require("../services/notify").emailConfigured(),
      // People with staff access here who haven't set up an authenticator or passkey yet.
      staff_without_second_factor: (await db.one(
        `SELECT count(*)::int AS n FROM org_members m JOIN accounts a ON a.id = m.account_id
          WHERE a.disabled_at IS NULL AND a.totp_secret_enc IS NULL
            AND NOT EXISTS (SELECT 1 FROM account_passkeys k WHERE k.account_id = a.id)`)).n,
      auth_secret_set: Boolean(process.env.AUTH_SECRET),
      auth_secret_source: process.env.AUTH_SECRET ? "config" : "database",
      codes_in_log: config.auth.logCodes,
      admin_token_retired: !config.auth.adminTokenBreakGlass,
      admin_token_break_glass: config.auth.adminTokenBreakGlass,
    },
  });
});

// ---------------------------------------------------------------------------
// Webhooks

function parseEvents(v) {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : String(v).split(",");
  const clean = list.map((x) => String(x).trim()).filter(Boolean);
  if (!clean.length) throw badRequest("events must list at least one event (or \"*\")");
  if (clean.length > 50) throw badRequest("at most 50 event names");
  if (clean.some((e) => !/^[a-z*][a-z0-9_.*]{0,63}$/i.test(e))) throw badRequest("event names may only contain letters, digits, dots, underscores and *");
  return clean;
}

/** Webhook targets must be public http(s) URLs (no internal network: SSRF). */
async function parseUrl(v) {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > 2000) throw badRequest("url is not valid");
  return (await assertPublicUrl(v.trim(), { label: "Webhook URL" })).toString();
}

const hide = (h) => ({ ...h, secret: h.secret ? `${h.secret.slice(0, 6)}…` : null });

router.get("/admin/webhooks", admin, async (_req, res) => {
  res.json((await db.many("SELECT * FROM webhooks ORDER BY id")).map(hide));
});

router.post("/admin/webhooks", person, async (req, res) => {
  const fields = { name: optString(req.body.name, "name", { max: 80 }), url: await parseUrl(req.body.url) };
  requireFields(fields, ["name", "url"]);
  const secret = optString(req.body.secret, "secret", { max: 200 }) || crypto.randomBytes(24).toString("hex");
  const hook = await db.one(
    "INSERT INTO webhooks (name, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING *",
    [fields.name, fields.url, secret, parseEvents(req.body.events) || ["*"]],
  );
  res.status(201).json(hook);
});

router.patch("/admin/webhooks/:id", person, async (req, res) => {
  const upd = buildUpdate({
    name: optString(req.body.name, "name", { max: 80 }),
    url: await parseUrl(req.body.url),
    events: parseEvents(req.body.events),
    active: optBool(req.body.active, "active"),
    secret: optString(req.body.secret, "secret", { max: 200 }),
  }, 2);
  if (!upd) throw badRequest("nothing to update");
  const hook = await db.one(`UPDATE webhooks SET ${upd.set} WHERE id = $1 RETURNING *`, [intParam(req.params.id), ...upd.values]);
  if (!hook) throw notFound("webhook");
  res.json(hide(hook));
});

router.delete("/admin/webhooks/:id", admin, async (req, res) => {
  const r = await db.query("DELETE FROM webhooks WHERE id = $1", [intParam(req.params.id)]);
  if (!r.rowCount) throw notFound("webhook");
  res.status(204).end();
});

router.get("/admin/webhooks/:id/deliveries", admin, async (req, res) => {
  res.json(
    await db.many(
      "SELECT id, event, status, attempts, response_code, error, created_at, delivered_at FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY id DESC LIMIT 100",
      [intParam(req.params.id)],
    ),
  );
});

router.post("/admin/webhooks/:id/test", admin, async (req, res) => {
  const hook = await db.one("SELECT * FROM webhooks WHERE id = $1", [intParam(req.params.id)]);
  if (!hook) throw notFound("webhook");
  res.status(202).json({ delivery_id: await webhooks.ping(hook) });
});

module.exports = router;

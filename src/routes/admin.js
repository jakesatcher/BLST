const crypto = require("crypto");
const { Router } = require("express");
const db = require("../db");
const { requireRole, hashKey, generateKey } = require("../middleware/auth");
const { badRequest, notFound, intParam, optEnum, optString, optBool, requireFields, buildUpdate } = require("../lib/http");
const webhooks = require("../services/webhooks");
const factions = require("../services/factions");

const router = Router();
const admin = requireRole("admin");

router.get("/me", (req, res) => {
  res.json({ role: req.auth.role, via: req.auth.via, key_name: req.auth.keyName || null });
});

// ---------------------------------------------------------------------------
// API keys. The plaintext key is only returned once, at creation.

router.get("/admin/api-keys", admin, async (_req, res) => {
  res.json(await db.many("SELECT id, name, key_prefix, role, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id"));
});

router.post("/admin/api-keys", admin, async (req, res) => {
  const name = optString(req.body.name, "name", { max: 80 });
  const role = optEnum(req.body.role, "role", ["admin", "scorekeeper", "readonly"]);
  if (!name || !role) throw badRequest("name and role are required");
  const key = generateKey();
  const row = await db.one(
    "INSERT INTO api_keys (name, key_prefix, key_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, key_prefix, role, created_at",
    [name, key.slice(0, 12), hashKey(key), role],
  );
  res.status(201).json({ ...row, key });
});

router.delete("/admin/api-keys/:id", admin, async (req, res) => {
  const row = await db.one("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id", [intParam(req.params.id)]);
  if (!row) throw notFound("active API key");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Webhooks

function parseEvents(v) {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : String(v).split(",");
  const clean = list.map((x) => String(x).trim()).filter(Boolean);
  if (!clean.length) throw badRequest("events must list at least one event (or \"*\")");
  return clean;
}

function parseUrl(v) {
  if (v === undefined) return undefined;
  let u;
  try {
    u = new URL(v);
  } catch {
    throw badRequest("url is not valid");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw badRequest("url must be http(s)");
  return u.toString();
}

const hide = (h) => ({ ...h, secret: h.secret ? `${h.secret.slice(0, 6)}…` : null });

router.get("/admin/webhooks", admin, async (_req, res) => {
  res.json((await db.many("SELECT * FROM webhooks ORDER BY id")).map(hide));
});

router.post("/admin/webhooks", admin, async (req, res) => {
  const fields = { name: optString(req.body.name, "name", { max: 80 }), url: parseUrl(req.body.url) };
  requireFields(fields, ["name", "url"]);
  const secret = optString(req.body.secret, "secret", { max: 200 }) || crypto.randomBytes(24).toString("hex");
  const hook = await db.one(
    "INSERT INTO webhooks (name, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING *",
    [fields.name, fields.url, secret, parseEvents(req.body.events) || ["*"]],
  );
  res.status(201).json(hook);
});

router.patch("/admin/webhooks/:id", admin, async (req, res) => {
  const upd = buildUpdate({
    name: optString(req.body.name, "name", { max: 80 }),
    url: parseUrl(req.body.url),
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

// ---------------------------------------------------------------------------
// BLPA Factions

router.get("/factions/status", admin, async (_req, res) => {
  res.json(await factions.status());
});

router.post("/tournaments/:id/factions/link", admin, async (req, res) => {
  res.json(await factions.linkTournament(intParam(req.params.id), { event_id: optString(req.body.event_id, "event_id", { max: 100 }) }));
});

router.post("/tournaments/:id/factions/sync-players", admin, async (req, res) => {
  res.json(await factions.syncPlayers(intParam(req.params.id)));
});

router.get("/tournaments/:id/factions/preview", admin, async (req, res) => {
  res.json(await factions.participationPreview(intParam(req.params.id)));
});

router.post("/tournaments/:id/factions/push", admin, async (req, res) => {
  res.json(await factions.pushResults(intParam(req.params.id)));
});

// Public: Order totals contain no PII (same as on the Factions side).
router.get("/tournaments/:id/factions/order-totals", async (req, res) => {
  res.json(await factions.orderTotals(intParam(req.params.id)));
});

module.exports = router;

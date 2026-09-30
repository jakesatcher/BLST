const crypto = require("crypto");
const db = require("../db");
const { bus } = require("../lib/bus");

// Outbound webhooks: every domain event (game.final, game.event.created,
// roster.moved, ...) is POSTed as JSON to each active subscriber whose
// `events` list matches. Receivers verify X-BLST-Signature, an HMAC-SHA256
// of "<timestamp>.<raw body>" keyed by the webhook's secret.

const settings = { retryDelaysMs: [5000, 30000], timeoutMs: 10000 };

function sign(secret, timestamp, body) {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function matches(hook, event) {
  return hook.events.some((pattern) => {
    if (pattern === "*" || pattern === event) return true;
    return pattern.endsWith(".*") && event.startsWith(pattern.slice(0, -1));
  });
}

async function dispatch(message) {
  const hooks = await db.many("SELECT * FROM webhooks WHERE active");
  const targets = hooks.filter((h) => matches(h, message.event));
  await Promise.all(targets.map((hook) => enqueue(hook, message)));
}

async function enqueue(hook, message) {
  const delivery = await db.one(
    "INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, $2, $3) RETURNING id",
    [hook.id, message.event, JSON.stringify(message)],
  );
  const body = JSON.stringify({ id: delivery.id, ...message });
  // Fire and forget: webhook latency must never slow down the scorekeeper.
  attempt(hook, delivery.id, message.event, body, 0).catch((err) => console.error("webhook delivery crashed", err));
  return delivery.id;
}

async function attempt(hook, deliveryId, event, body, n) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  let code = null;
  let error = null;
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "BLST-Webhooks/1.0",
        "x-blst-event": event,
        "x-blst-delivery": String(deliveryId),
        "x-blst-timestamp": timestamp,
        "x-blst-signature": sign(hook.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    code = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err.message;
  }
  const done = !error || n >= settings.retryDelaysMs.length;
  await db.query(
    `UPDATE webhook_deliveries SET attempts = $2, response_code = $3, error = $4,
            status = $5, delivered_at = CASE WHEN $4::text IS NULL THEN now() ELSE delivered_at END
      WHERE id = $1`,
    [deliveryId, n + 1, code, error, !error ? "success" : done ? "failed" : "pending"],
  );
  if (!done) {
    const t = setTimeout(() => attempt(hook, deliveryId, event, body, n + 1).catch(() => {}), settings.retryDelaysMs[n]);
    t.unref();
  }
}

/** Sends a signed "ping" straight away (used by the admin "test" button). */
async function ping(hook) {
  return enqueue(hook, { event: "ping", data: { webhook_id: hook.id, name: hook.name }, created_at: new Date().toISOString() });
}

let listening = false;
function start() {
  if (listening) return;
  listening = true;
  bus.on("domain", (message) => dispatch(message).catch((err) => console.error("webhook dispatch failed", err)));
}

module.exports = { start, sign, matches, ping, settings };

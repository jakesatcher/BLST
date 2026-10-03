const http = require("http");
const crypto = require("crypto");
const express = require("express");

// Point everything at the test database before any src module loads config.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://blst:blst@localhost:5432/blst_test";
process.env.ADMIN_TOKEN = "test-admin-token";
// Tests talk to 127.0.0.1: serve the first league there.
process.env.DEFAULT_ORG = process.env.DEFAULT_ORG ?? "blpa";
process.env.PUBLIC_EXPORTS = "true";
// Test webhook receivers listen on 127.0.0.1.
process.env.ALLOW_PRIVATE_NETWORK_URLS = "true";

const ADMIN = process.env.ADMIN_TOKEN;

async function resetDb() {
  const db = require("../src/db");
  require("../src/lib/context").setFallbackOrg("*");
  await db.query("DROP SCHEMA IF EXISTS factions CASCADE; DROP SCHEMA IF EXISTS legacy CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;");
  await db.migrate({ log: () => {} });
  return db;
}

/** Owner connection for test setup that needs schema rights (DDL). */
let ownerPool;
function ownerQuery(sql, params) {
  const { Pool } = require("pg");
  if (!ownerPool) ownerPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  return ownerPool.query(sql, params);
}
async function closeOwner() {
  if (ownerPool) await ownerPool.end();
  ownerPool = undefined;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * Fresh database and app. By default every query then runs as the
 * least-privilege role, so row-level security (organization isolation) is
 * really enforced in tests; direct test queries act as organization 1.
 */
async function startApp({ asAppRole = true } = {}) {
  const db = await resetDb();
  if (asAppRole) {
    process.env.DATABASE_APP_ROLE = process.env.DATABASE_APP_ROLE || "blst_app_ci";
    await require("../src/db/create-app-role").ensureRuntimeRole({ log: () => {} });
  }
  require("../src/lib/context").setFallbackOrg(1);
  void db;
  const { createApp } = require("../src/app");
  require("../src/services/webhooks").start();
  const { server, base } = await listen(createApp());
  async function api(method, path, body, token = ADMIN) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
  // A league's data is only for its people: tests that read as a fan use a
  // view-only key (a member viewer, a player, or a display link).
  const viewer = (await api("POST", "/admin/api-keys", { name: "test viewer", role: "readonly" })).body.key;
  return { server, base, api, viewer };
}

async function startWebhookReceiver() {
  const received = [];
  const app = express();
  app.use(express.text({ type: "*/*" }));
  app.post("/hook", (req, res) => {
    received.push({ headers: req.headers, raw: req.body, body: JSON.parse(req.body) });
    res.status(204).end();
  });
  const { server, base } = await listen(app);
  return { server, url: `${base}/hook`, received };
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

module.exports = { ADMIN, startApp, startWebhookReceiver, waitFor, ownerQuery, closeOwner };

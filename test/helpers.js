const http = require("http");
const crypto = require("crypto");
const express = require("express");

// Point everything at the test database before any src module loads config.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://blst:blst@localhost:5432/blst_test";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.PUBLIC_EXPORTS = "true";
// Test webhook receivers listen on 127.0.0.1.
process.env.ALLOW_PRIVATE_NETWORK_URLS = "true";

const ADMIN = process.env.ADMIN_TOKEN;

async function resetDb() {
  const db = require("../src/db");
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.migrate({ log: () => {} });
  return db;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function startApp() {
  await resetDb();
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
  return { server, base, api };
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

module.exports = { ADMIN, startApp, startWebhookReceiver, waitFor };

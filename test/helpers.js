const http = require("http");
const crypto = require("crypto");
const express = require("express");

// Point everything at the test database before any src module loads config.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://blst:blst@localhost:5432/blst_test";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.PUBLIC_EXPORTS = "true";
// Test receivers (webhooks, mock Factions) listen on 127.0.0.1.
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

/**
 * In-memory stand-in for the BLPA Factions API, implementing the routes
 * BLST calls with the same shapes and semantics (email-derived player id,
 * participation upsert, achievement upsert, x-admin-token auth).
 */
async function startMockFactions(token = "factions-token") {
  const ORDERS = ["varghona", "tuskarium", "aetherwing", "serikon", "thalkara", "ursonne"];
  const state = { players: new Map(), events: new Map(), participation: new Map(), achievements: new Map(), requests: [] };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    state.requests.push(`${req.method} ${req.path}`);
    next();
  });
  const auth = (req, res, next) => (req.header("x-admin-token") === token ? next() : res.status(401).json({ error: "missing or invalid x-admin-token header" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.post("/players", auth, (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email.includes("@")) return res.status(400).json({ error: "invalid email" });
    const id = Buffer.from(email).toString("base64url");
    const orderSlug = ORDERS[crypto.createHash("sha256").update(email).digest().readUInt32BE(0) % 6];
    const player = { id, email, displayName: req.body.displayName, orderSlug };
    state.players.set(id, player);
    res.status(201).json(player);
  });
  app.post("/events", auth, (req, res) => {
    const id = `evt_${state.events.size + 1}`;
    state.events.set(id, { id, ...req.body });
    res.status(201).json(state.events.get(id));
  });
  app.post("/events/:eventId/participation", auth, (req, res) => {
    if (!state.events.has(req.params.eventId)) return res.status(500).json({ error: "internal server error" });
    if (!state.players.has(req.body.playerId)) return res.status(500).json({ error: "internal server error" });
    const key = `${req.params.eventId}:${req.body.playerId}`;
    state.participation.set(key, { eventId: req.params.eventId, ...req.body });
    res.status(201).json(state.participation.get(key));
  });
  app.post("/players/:playerId/achievements", auth, (req, res) => {
    const key = `${req.params.playerId}:${req.body.code}`;
    if (!state.achievements.has(key)) state.achievements.set(key, { playerId: req.params.playerId, ...req.body });
    res.status(201).json(state.achievements.get(key));
  });
  app.get("/events/:eventId/order-totals", (req, res) => {
    const totals = Object.fromEntries(ORDERS.map((o) => [o, { slug: o, totalPoints: 0, playerCount: 0 }]));
    for (const p of state.participation.values()) {
      if (p.eventId !== req.params.eventId) continue;
      const slug = state.players.get(p.playerId).orderSlug;
      totals[slug].totalPoints += p.pointsEarned;
      totals[slug].playerCount += 1;
    }
    res.json(Object.values(totals));
  });
  const { server, base } = await listen(app);
  return { server, base, state, token };
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

module.exports = { ADMIN, startApp, startMockFactions, startWebhookReceiver, waitFor };

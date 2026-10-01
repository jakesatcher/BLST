const { Router } = require("express");
const { bus } = require("../lib/bus");
const { optInt, HttpError } = require("../lib/http");
const config = require("../config");

// Each viewer holds one connection open; cap them so one client (or a flood)
// can't exhaust the server.
const open = { total: 0, byIp: new Map() };
const data = require("../services/data");

const router = Router();

function summary(msg) {
  const s = msg.snapshot;
  return {
    game_id: msg.gameId,
    tournament_id: msg.tournamentId,
    reason: msg.reason,
    server_now: s.server_now,
    status: s.game.status,
    period: s.game.period,
    period_label: s.game.period_label,
    clock_running: s.game.clock_running,
    clock_remaining_ms: s.game.clock_remaining_ms,
    decision: s.game.decision,
    home: { id: s.home.id, name: s.home.name, score: s.home.score, shots: s.home.shots },
    away: { id: s.away.id, name: s.away.name, score: s.away.score, shots: s.away.shots },
  };
}

/**
 * Server-Sent Events feed for viewers.
 *   ?game_id=N        full game snapshot on connect and after every change
 *   ?tournament_id=N  compact score/clock summaries for every game in it,
 *                     plus "tournament.changed" when rosters/schedule change
 *   (neither)         summaries for every game
 */
router.get("/stream", async (req, res) => {
  const ipCount = open.byIp.get(req.ip) || 0;
  if (ipCount >= config.rateLimits.streamsPerIp || open.total >= config.rateLimits.streamsTotal) {
    throw new HttpError(429, "too many live connections; close some tabs and try again");
  }
  const gameId = optInt(req.query.game_id, "game_id", { min: 1 });
  const tournamentId = optInt(req.query.tournament_id, "tournament_id", { min: 1 });
  const initial = gameId ? await data.gameSnapshot(gameId) : null;
  // Events from every organization pass through the bus: only this
  // organization's reach this viewer.
  const myOrg = require("../lib/context").currentOrg();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  res.write("retry: 3000\n\n");
  if (initial) send("snapshot", initial);
  else send("hello", { server_now: Date.now() });

  const onGame = (msg) => {
    if (msg.orgId !== myOrg) return;
    if (gameId) {
      if (msg.gameId === gameId) send("snapshot", msg.snapshot);
      return;
    }
    if (!tournamentId || msg.tournamentId === tournamentId) send("game.summary", summary(msg));
  };
  const onDomain = (msg) => {
    if (msg.orgId !== myOrg) return;
    if (gameId || !msg.event.match(/^(roster|team|tournament|schedule|game\.created|game\.deleted|player)/)) return;
    if (tournamentId && msg.data.tournament_id !== undefined && msg.data.tournament_id !== tournamentId) return;
    send("tournament.changed", { event: msg.event, tournament_id: msg.data.tournament_id ?? null });
  };
  bus.on("game", onGame);
  bus.on("domain", onDomain);
  open.total += 1;
  open.byIp.set(req.ip, (open.byIp.get(req.ip) || 0) + 1);
  // Heroku drops idle connections after 55s.
  const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 20000);
  req.on("close", () => {
    open.total -= 1;
    const n = (open.byIp.get(req.ip) || 1) - 1;
    if (n <= 0) open.byIp.delete(req.ip);
    else open.byIp.set(req.ip, n);
    clearInterval(heartbeat);
    bus.off("game", onGame);
    bus.off("domain", onDomain);
  });
});

module.exports = router;

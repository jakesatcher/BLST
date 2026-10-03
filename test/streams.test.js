const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startApp } = require("./helpers");
const streams = require("../src/lib/streams");

let ctx;
let api;
const S = {};

test.before(async () => {
  ctx = await startApp();
  api = ctx.api;
  const t = await api("POST", "/tournaments", { name: "Stream Cup", num_teams: 2 });
  S.tid = t.body.id;
  const teams = (await api("GET", `/tournaments/${S.tid}`)).body.teams;
  const g = await api("POST", `/tournaments/${S.tid}/games`, { home_team_id: teams[0].id, away_team_id: teams[1].id, venue: "Rink A" });
  S.gid = g.body.id;
});

test.after(async () => {
  ctx.server.close();
  await require("../src/db").close();
});

test("rink stream defaults flow into the game snapshot and game lists", async () => {
  let snap = (await api("GET", `/games/${S.gid}`)).body;
  assert.equal(snap.stream, null);
  const unset = (await api("GET", `/tournaments/${S.tid}/streams`)).body;
  assert.deepEqual(unset.unconfigured_venues, ["Rink A"]);

  assert.equal((await api("PUT", `/tournaments/${S.tid}/streams`, { venue: "rink a" })).status, 400, "needs a link");
  const saved = await api("PUT", `/tournaments/${S.tid}/streams`, { venue: "rink a", livebarn_url: "https://livebarn.com/en/video/1234/surface/5678" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.delay_sec, 20, "LiveBarn-only rinks default to a 20s delay");

  snap = (await api("GET", `/games/${S.gid}`, undefined, ctx.viewer)).body;
  assert.equal(snap.stream.livebarn_url, "https://livebarn.com/en/video/1234/surface/5678");
  assert.equal(snap.stream.embed_url, null);
  assert.equal(snap.stream.delay_sec, 20);
  const games = (await api("GET", `/tournaments/${S.tid}/games`)).body;
  assert.equal(games[0].has_stream, true);

  // Same rink saved again (different case) updates rather than duplicates.
  await api("PUT", `/tournaments/${S.tid}/streams`, { venue: "Rink A", livebarn_url: "https://livebarn.com/x", embed_url: "https://youtu.be/dQw4w9WgXcQ", delay_sec: 12 });
  const list = (await api("GET", `/tournaments/${S.tid}/streams`)).body;
  assert.equal(list.streams.length, 1);
  assert.equal(list.streams[0].embed_url, "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1&playsinline=1");
  assert.equal(list.streams[0].kind, "iframe");
});

test("per-game overrides win over the rink default", async () => {
  const r = await api("PATCH", `/games/${S.gid}`, { stream_embed_url: "https://cdn.example.com/live/game.m3u8", stream_delay_sec: 4 });
  assert.equal(r.status, 200);
  assert.equal(r.body.stream.embed_url, "https://cdn.example.com/live/game.m3u8");
  assert.equal(r.body.stream.kind, "hls");
  assert.equal(r.body.stream.delay_sec, 4);
  assert.equal(r.body.stream.livebarn_url, "https://livebarn.com/x", "falls back to the rink's LiveBarn link");

  assert.equal((await api("PATCH", `/games/${S.gid}`, { stream_embed_url: "http://insecure.example.com/x" })).status, 400);
  assert.equal((await api("PATCH", `/games/${S.gid}`, { livebarn_url: "javascript:alert(1)" })).status, 400);
  assert.equal((await api("PATCH", `/games/${S.gid}`, { stream_embed_url: null, stream_delay_sec: null })).body.stream.delay_sec, 12);
  assert.equal((await api("PUT", `/tournaments/${S.tid}/streams`, { venue: "Rink A", livebarn_url: "https://livebarn.com/x" }, null)).status, 401);
});

test("embed check reads frame headers", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/deny") res.setHeader("x-frame-options", "DENY");
    if (req.url === "/self") res.setHeader("content-security-policy", "frame-ancestors 'self'");
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await streams.checkEmbeddable(`${base}/deny`)).embeddable, false);
  assert.equal((await streams.checkEmbeddable(`${base}/self`)).embeddable, false);
  assert.equal((await streams.checkEmbeddable(`${base}/open`)).embeddable, true);
  assert.equal((await streams.checkEmbeddable("https://cdn.example.com/a.m3u8")).embeddable, true);
  server.close();
  assert.equal((await api("POST", "/streams/check", { url: "http://example.com" })).status, 400, "embeds must be https");
});

test("watch and overlay pages are served with a CSP that allows players", async () => {
  for (const page of ["/watch.html?game=1", "/overlay.html?game=1"]) {
    const res = await fetch(`${ctx.base}${page}`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /frame-src 'self' https:/);
    assert.match(csp, /media-src 'self' https: blob:/);
  }
});

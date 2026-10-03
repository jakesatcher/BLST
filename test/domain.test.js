// beerleaguestats.hockey is built in: even without APP_DOMAIN the main
// address is the landing site, never a league, and old league links move
// to blpa.beerleaguestats.hockey.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startApp } = require("./helpers");

let ctx;
let port;

test.before(async () => {
  delete process.env.APP_DOMAIN;
  ctx = await startApp();
  port = new URL(ctx.base).port;
});

test.after(async () => {
  ctx.server.close();
  await require("../src/db").close();
});

const get = (host, path) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
  }).on("error", reject);
});

test("the main address is the landing site, not BLPA, without any configuration", async () => {
  assert.equal(require("../src/config").appDomain, "beerleaguestats.hockey");
  for (const host of ["beerleaguestats.hockey", "www.beerleaguestats.hockey"]) {
    const home = await get(host, "/");
    assert.equal(home.status, 200, host);
    assert.match(home.body, /platform\.js/, `${host} serves the landing page`);
    const stats = await get(host, "/stats");
    assert.equal(stats.status, 301);
    assert.equal(stats.location, "https://blpa.beerleaguestats.hockey/stats");
    const org = JSON.parse((await get(host, "/api/v1/org")).body);
    assert.equal(org.org, null, "no league on the main address");
  }
  // Any other address (Railway's own, a forwarder) is the landing site too.
  const config = require("../src/config");
  const saved = config.defaultOrg;
  config.defaultOrg = "";
  try {
    assert.equal(JSON.parse((await get("blst-production.up.railway.app", "/api/v1/org")).body).org, null);
  } finally {
    config.defaultOrg = saved;
  }
  const blpa = JSON.parse((await get("blpa.beerleaguestats.hockey", "/api/v1/org")).body);
  assert.equal(blpa.org.slug, "blpa");
  const stats = await get("blpa.beerleaguestats.hockey", "/api/v1/tournaments");
  assert.equal(stats.status, 401, "and its stats need signing in");
});

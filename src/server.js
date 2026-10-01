const config = require("./config");
const db = require("./db");
const { createApp } = require("./app");
const control = require("./services/gameControl");
const webhooks = require("./services/webhooks");
const factions = require("./services/factions");
const leagueapps = require("./services/leagueapps");
const { MIN_ADMIN_TOKEN_LENGTH } = require("./middleware/auth");

// Same rule as the BLPA Factions app: never boot a deployed instance with
// its write APIs wide open.
if (config.deployed && !config.adminToken) {
  throw new Error("ADMIN_TOKEN must be set before deploying (heroku config:set ADMIN_TOKEN=...)");
}
if (config.deployed && config.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
  throw new Error(`ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters (use: openssl rand -hex 24)`);
}

async function main() {
  await db.migrate();
  webhooks.start();
  factions.start();
  leagueapps.startSchedule();
  const rearmed = await control.rearmAll();
  // Keep the audit trail for 180 days.
  const prune = () => db.query("DELETE FROM audit_log WHERE at < now() - interval '180 days'").catch(() => {});
  prune();
  setInterval(prune, 12 * 3600e3).unref();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`BLST listening on port ${config.port}${rearmed ? ` (${rearmed} running clock(s) restored)` : ""}`);
    if (!config.adminToken && config.allowOpenDev) console.warn("ADMIN_TOKEN is not set and ALLOW_OPEN_DEV=true: all write APIs are open (local development only)");
    else if (!config.adminToken) console.warn("ADMIN_TOKEN is not set: admin and scorekeeper features are locked. Set ADMIN_TOKEN (or ALLOW_OPEN_DEV=true for local development).");
    else if (config.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) console.warn(`ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters; deployed instances refuse to start with it.`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

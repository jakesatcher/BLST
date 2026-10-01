const config = require("./config");
const db = require("./db");
const { createApp } = require("./app");
const control = require("./services/gameControl");
const webhooks = require("./services/webhooks");
const factions = require("./services/factions");
const leagueapps = require("./services/leagueapps");
const { MIN_ADMIN_TOKEN_LENGTH } = require("./middleware/auth");

// Never boot a deployed instance with its write APIs wide open. ADMIN_TOKEN
// is needed until the first admin account exists (it's the setup key); see
// main() for that check.
if (config.deployed && config.adminToken && config.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
  throw new Error(`ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters (use: openssl rand -hex 24)`);
}

async function main() {
  await db.migrate();
  // Earlier side-by-side deploys kept Factions in this database's "factions" schema.
  await require("./services/factionsImport").autoImportSharedSchema().catch((err) => console.error("Factions auto-import failed:", err.message));
  const accounts = require("./services/accounts");
  if (config.deployed && !config.adminToken && (await accounts.setupStatus()).needed) {
    throw new Error("ADMIN_TOKEN must be set before deploying, to create the first admin account (Heroku: heroku config:set ADMIN_TOKEN=...; Railway: railway variable set ADMIN_TOKEN=...)");
  }
  if (config.deployed && !process.env.AUTH_SECRET) console.warn("AUTH_SECRET is not set: sign-in codes in progress are lost on restart. Set it with: openssl rand -hex 32");
  if (config.deployed && config.auth.logCodes) console.warn("AUTH_LOG_CODES=true on a deployed server: sign-in codes are written to the log.");
  const pruneAuth = () => accounts.prune().catch(() => {});
  setInterval(pruneAuth, 3600e3).unref();
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
    else if (!config.adminToken) console.warn("ADMIN_TOKEN is not set: sign in with an admin account (or set ALLOW_OPEN_DEV=true for local development).");
    else if (config.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) console.warn(`ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters; deployed instances refuse to start with it.`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

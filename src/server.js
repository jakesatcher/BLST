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
  const bootstrap = require("./services/bootstrap");
  // Nothing secret has to be configured: what isn't set is generated here.
  await bootstrap.ensureAuthSecret();
  await bootstrap.ensureSetupKey();
  // Least privilege: requests run as a role that can't change the schema.
  config.dbMode = await require("./db/create-app-role").ensureRuntimeRole();
  const notify = require("./services/notify");
  if (config.deployed && config.auth.logCodes && (!notify.emailConfigured() || !notify.smsConfigured())) {
    console.warn("Email/SMS aren't fully set up: sign-in codes for those channels are written to this log. Set SMTP_URL and TWILIO_* (see docs/RAILWAY.md).");
  }
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
    else if (config.adminToken && config.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) console.warn(`ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters; deployed instances refuse to start with it.`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

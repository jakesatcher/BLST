const config = require("./config");
const db = require("./db");
const { createApp } = require("./app");
const control = require("./services/gameControl");
const webhooks = require("./services/webhooks");
const factions = require("./services/factions");
const leagueapps = require("./services/leagueapps");
const { withOrg } = require("./lib/context");
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
  console.log(`Email: ${notify.describeEmail()} · Text messages: ${notify.smsConfigured() ? "Twilio" : "not set up (codes go to this log)"}`);
  if (config.deployed && config.auth.logCodes && (!notify.emailConfigured() || !notify.smsConfigured())) {
    console.warn("Email/SMS aren't fully set up: sign-in codes for those channels are written to this log. Set RESEND_API_KEY (or SMTP_URL) and TWILIO_* (see docs/RAILWAY.md).");
  }
  const pruneAuth = () => withOrg("*", () => accounts.prune()).catch(() => {});
  setInterval(pruneAuth, 3600e3).unref();
  webhooks.start();
  factions.start();
  leagueapps.startSchedule();
  const rearmed = await control.rearmAll();
  // Keep the audit trail for 180 days.
  const prune = () => withOrg("*", () => db.query("DELETE FROM audit_log WHERE at < now() - interval '180 days'")).catch(() => {});
  prune();
  setInterval(prune, 12 * 3600e3).unref();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`BLST listening on port ${config.port}${rearmed ? ` (${rearmed} running clock(s) restored)` : ""}`);
    if (!config.adminToken && config.allowOpenDev) console.warn("ADMIN_TOKEN is not set and ALLOW_OPEN_DEV=true: all write APIs are open (local development only)");
    else if (config.adminToken && config.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) console.warn(`ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters; deployed instances refuse to start with it.`);
  });
}

/** Where DATABASE_URL points, for the log (never the password). */
function databaseTarget() {
  try {
    const u = new URL(config.databaseUrl);
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || "5432", db: u.pathname.slice(1) };
  } catch {
    return { host: "", port: "", db: "" };
  }
}
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const NO_DATABASE = `No database is connected, so BLST can't start.

Railway: add a database (New -> Database -> PostgreSQL) to this project, then
in this service's Variables tab add
    DATABASE_URL = \${{Postgres.DATABASE_URL}}
(the variable reference; "Postgres" is the database service's name). The
service redeploys and starts. See docs/RAILWAY.md.

Elsewhere: set DATABASE_URL to a Postgres connection string.`;

/**
 * Deployed without a database (e.g. a GitHub deploy before Postgres is
 * added): instead of crash-looping, serve a page that says what to do and
 * repeat it in the log.
 */
function explainMissingDatabase(why) {
  const text = why ? `${why}\n\n${NO_DATABASE}` : NO_DATABASE;
  console.error(text);
  setInterval(() => console.error(text), 5 * 60e3);
  require("http").createServer((req, res) => {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(`${text}\n`);
  }).listen(config.port, () => console.error(`Serving setup instructions on port ${config.port} until a database is connected.`));
}

const target = databaseTarget();
if (!config.databaseUrl) {
  explainMissingDatabase();
} else if (config.deployed && LOCAL_HOSTS.has(target.host)) {
  // A deployed app's database is never on its own container. This is a
  // local-development value (e.g. added from Railway's suggested variables)
  // or a reference that didn't resolve.
  explainMissingDatabase(`DATABASE_URL points at "${target.host || "(no host)"}", which is this container, not your database. ` +
    "Replace it with the reference ${{Postgres.DATABASE_URL}} (and delete PORT=3000 if it was added with it).");
} else {
  if (config.deployed) console.log(`Database: ${target.host}:${target.port}/${target.db}`);
  main().catch((err) => {
    console.error(err);
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
      console.error(`Can't reach the database (${err.code}). Check DATABASE_URL points at your Postgres service (on Railway: \${{Postgres.DATABASE_URL}}).`);
    }
    process.exit(1);
  });
}

// Least privilege for the database (OWASP database security).
//
// The app's queries run as a role "blst_app" that can read and write rows
// but can't create, alter or drop anything, and isn't a superuser.
//
// Automatic (default): when the configured login may create roles (Railway's
// database login can), the server creates blst_app at boot, runs migrations
// as the owner login and every request as blst_app. Its password is derived
// from the owner's, so nothing extra is stored or configured. Injected SQL
// would run as blst_app; the owner login stays in the process for migrations.
//
// Manual (stronger, keeps the owner login out of the running app):
//   npm run db:app-role            (with DATABASE_URL = the owner login)
// then run the app with DATABASE_URL = the printed blst_app URL and
// DATABASE_MIGRATION_URL = the owner URL. --rotate sets a new password.
const crypto = require("crypto");
const { Pool } = require("pg");
const db = require("./index");
const config = require("../config");

const ROLE = process.env.DATABASE_APP_ROLE || "blst_app";
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ROLE)) throw new Error("DATABASE_APP_ROLE must be a simple lowercase name");

/** Creates the role (or updates its password). Identifiers can't be bind parameters; ROLE is validated above. */
async function setPassword(password, exists) {
  const quoted = (await db.one("SELECT quote_literal($1) AS q", [password])).q;
  await db.query(`${exists ? "ALTER" : "CREATE"} ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted}`);
}

/** Row access only, now and for tables future migrations add. */
async function applyGrants() {
  const { u: owner, d: dbName } = await db.one("SELECT current_user AS u, current_database() AS d");
  const statements = [
    `GRANT CONNECT ON DATABASE "${dbName}" TO ${ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
    `REVOKE CREATE ON SCHEMA public FROM ${ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${ROLE}`,
  ];
  // Read-only access to a standalone Factions schema, for the one-time import.
  if ((await db.one("SELECT to_regnamespace('factions') IS NOT NULL AS ok")).ok) {
    statements.push(`GRANT USAGE ON SCHEMA factions TO ${ROLE}`, `GRANT SELECT ON ALL TABLES IN SCHEMA factions TO ${ROLE}`);
  }
  for (const sql of statements) await db.query(sql);
  return owner;
}

function roleUrl(password) {
  const u = new URL(config.databaseUrl);
  u.username = ROLE;
  u.password = password;
  return u.toString();
}

async function canConnect(url) {
  const p = new Pool({ connectionString: url, ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const r = await p.query("SELECT current_user AS u");
    return r.rows[0].u === ROLE;
  } catch {
    return false;
  } finally {
    await p.end().catch(() => {});
  }
}

/** Manual mode (npm run db:app-role). */
async function grant({ rotate = false, log = console.log } = {}) {
  await db.migrate({ log: () => {} });
  const exists = Boolean(await db.one("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]));
  let password = null;
  if (!exists || rotate) {
    password = crypto.randomBytes(24).toString("base64url");
    await setPassword(password, exists);
  }
  const owner = await applyGrants();
  log(`Role "${ROLE}" can read and write BLST's rows; it can't change the schema. Owner: "${owner}".`);
  if (password) {
    log("\nRun the app with these two settings (keep them secret):");
    log(`  DATABASE_URL=${roleUrl(password)}`);
    log("  DATABASE_MIGRATION_URL=<the owner URL you just used>");
    log(`\nOn Railway, set them on the blst service as references, so they follow the database:`);
    log(`  DATABASE_URL=postgresql://${ROLE}:${password}@\${{Postgres.PGHOST}}:\${{Postgres.PGPORT}}/\${{Postgres.PGDATABASE}}`);
    log("  DATABASE_MIGRATION_URL=${{Postgres.DATABASE_URL}}");
  } else {
    log("The role already existed, so its password is unchanged (use --rotate for a new one).");
  }
  return { role: ROLE, owner, password };
}

/**
 * Automatic mode, at server boot (after migrations, still as the owner):
 * set up blst_app and switch the app's pool to it. Returns the mode used:
 * "manual" (DATABASE_MIGRATION_URL is set), "auto", or "owner" (the login
 * can't create roles, e.g. Heroku's, or DB_AUTO_APP_ROLE=false).
 */
async function ensureRuntimeRole({ log = console.log } = {}) {
  if (config.migrationDatabaseUrl) return "manual";
  if (/^(0|false|no|off)$/i.test(process.env.DB_AUTO_APP_ROLE || "")) return "owner";
  const me = await db.one("SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user");
  if (!me || !(me.rolsuper || me.rolcreaterole)) return "owner";
  const owner = new URL(config.databaseUrl);
  const password = crypto.createHmac("sha256", `${decodeURIComponent(owner.password)}:${owner.username}`)
    .update(`blst-runtime-role:${ROLE}`).digest("base64url");
  const url = roleUrl(password);
  try {
    // Only send a password when the role is new or doesn't match (e.g. the
    // owner's password was rotated); otherwise just refresh the grants.
    if (!(await canConnect(url))) {
      const exists = Boolean(await db.one("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]));
      await setPassword(password, exists);
    }
    await applyGrants();
    if (!(await canConnect(url))) throw new Error(`can't sign in as ${ROLE}`);
  } catch (err) {
    log(`Database: couldn't set up the least-privilege role (${err.message}); queries keep using the owner login.`);
    return "owner";
  }
  await db.useRuntimeUrl(url);
  log(`Database: requests run as "${ROLE}" (rows only, no schema changes); migrations use the owner login.`);
  return "auto";
}

if (require.main === module) {
  grant({ rotate: process.argv.includes("--rotate") })
    .catch((err) => {
      console.error(`Couldn't set up the app role: ${err.message}`);
      if (/permission denied|must be/.test(err.message)) console.error("Run this with the database owner / admin login as DATABASE_URL.");
      process.exitCode = 1;
    })
    .finally(() => db.close());
}

module.exports = { grant, ensureRuntimeRole, ROLE };

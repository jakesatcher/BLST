// Least privilege for the database (OWASP database security):
//   npm run db:app-role            (run with DATABASE_URL = the owner/admin login)
//
// Creates (or re-grants) a login role "blst_app" that can read and write rows
// but can't create, alter or drop anything, and isn't a superuser. Then run
// the app as that role and keep the owner login for migrations only:
//   DATABASE_URL           = the blst_app URL this prints
//   DATABASE_MIGRATION_URL = the owner URL you ran this with
// Safe to re-run; --rotate sets a new password.
const crypto = require("crypto");
const db = require("./index");
const config = require("../config");

const ROLE = process.env.DATABASE_APP_ROLE || "blst_app";
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ROLE)) throw new Error("DATABASE_APP_ROLE must be a simple lowercase name");

async function grant({ rotate = false, log = console.log } = {}) {
  await db.migrate({ log: () => {} });
  const exists = await db.one("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]);
  let password = null;
  if (!exists || rotate) {
    password = crypto.randomBytes(24).toString("base64url");
    // Identifiers and passwords can't be bind parameters here; both are
    // generated or validated above, and the password is quoted by Postgres.
    const quoted = (await db.one("SELECT quote_literal($1) AS q", [password])).q;
    await db.query(`${exists ? "ALTER" : "CREATE"} ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted}`);
  }
  const owner = (await db.one("SELECT current_user AS u, current_database() AS d")).u;
  const dbName = (await db.one("SELECT current_database() AS d")).d;
  const statements = [
    `GRANT CONNECT ON DATABASE "${dbName}" TO ${ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
    `REVOKE CREATE ON SCHEMA public FROM ${ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`,
    // Tables that future migrations create (as the owner) get the same rights.
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${ROLE}`,
  ];
  // Read-only access to a standalone Factions schema, for the one-time import.
  if ((await db.one("SELECT to_regnamespace('factions') IS NOT NULL AS ok")).ok) {
    statements.push(`GRANT USAGE ON SCHEMA factions TO ${ROLE}`, `GRANT SELECT ON ALL TABLES IN SCHEMA factions TO ${ROLE}`);
  }
  for (const sql of statements) await db.query(sql);
  log(`Role "${ROLE}" can read and write BLST's rows; it can't change the schema. Owner: "${owner}".`);
  if (password) {
    const u = new URL(config.databaseUrl);
    u.username = ROLE;
    u.password = password;
    log("\nRun the app with these two settings (keep them secret):");
    log(`  DATABASE_URL=${u.toString()}`);
    log("  DATABASE_MIGRATION_URL=<the owner URL you just used>");
    log(`\nOn Railway, set them on the blst service as references, so they follow the database:`);
    log(`  DATABASE_URL=postgresql://${ROLE}:${password}@\${{Postgres.PGHOST}}:\${{Postgres.PGPORT}}/\${{Postgres.PGDATABASE}}`);
    log("  DATABASE_MIGRATION_URL=${{Postgres.DATABASE_URL}}");
  } else {
    log("The role already existed, so its password is unchanged (use --rotate for a new one).");
  }
  return { role: ROLE, owner, password };
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

module.exports = { grant, ROLE };

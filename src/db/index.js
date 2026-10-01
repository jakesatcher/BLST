const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");
const config = require("../config");

// DATE columns come back as plain "YYYY-MM-DD" strings instead of Dates
// shifted into the server's timezone.
types.setTypeParser(1082, (v) => v);
// COUNT()/SUM() return bigint/numeric; every value here fits in a double.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
      // A runaway query or a stuck transaction can't hold a connection forever.
      statement_timeout: config.dbStatementTimeoutMs,
      idle_in_transaction_session_timeout: 60000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

/** Runs fn(client) inside BEGIN/COMMIT, rolling back on any throw. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies new SQL files from ./migrations, in order, each in a transaction.
 * Runs as DATABASE_MIGRATION_URL when set (the owner role), so the app's
 * everyday role needs no right to change the schema. An advisory lock keeps
 * two instances that boot together (overlapping deploys) from both migrating.
 */
async function migrate({ log = console.log } = {}) {
  const url = config.migrationDatabaseUrl;
  const separate = Boolean(url) && url !== config.databaseUrl;
  const mpool = separate
    ? new Pool({ connectionString: url, ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined, max: 1 })
    : getPool();
  const c = await mpool.connect();
  try {
    await c.query("SET statement_timeout = 0");
    await c.query("SELECT pg_advisory_lock(727274)");
    const exists = (await c.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")).rows[0].ok;
    if (!exists) {
      await c.query("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    }
    const dir = path.join(__dirname, "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const applied = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      try {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      }
      log(`applied migration ${file}`);
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    await c.query("RESET statement_timeout").catch(() => {});
    c.release();
    if (separate) await mpool.end();
  }
}

async function close() {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

module.exports = { getPool, query, one, many, tx, migrate, close };

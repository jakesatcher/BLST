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

async function migrate({ log = console.log } = {}) {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await many("SELECT name FROM schema_migrations")).map((r) => r.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await tx(async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    log(`applied migration ${file}`);
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

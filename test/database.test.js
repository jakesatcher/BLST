// Database security (OWASP database security cheat sheet): least-privilege
// runtime role, migrations under a separate login, timeouts, guarded data.
const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_APP_ROLE = "blst_app_test";
process.env.DB_STATEMENT_TIMEOUT_MS = "2000"; // keeps the timeout test quick
const { startApp } = require("./helpers");
const { Pool } = require("pg");

let ctx;
let db;
let appPool;

test.before(async () => {
  ctx = await startApp({ asAppRole: false });
  db = require("../src/db");
  await db.query("DROP OWNED BY blst_app_test").catch(() => {});
  await db.query("DROP ROLE IF EXISTS blst_app_test");
});

test.after(async () => {
  if (appPool) await appPool.end();
  await db.query("DROP OWNED BY blst_app_test").catch(() => {});
  await db.query("DROP ROLE IF EXISTS blst_app_test").catch(() => {});
  ctx.server.close();
  await db.close();
});

test("the app role can use the data but can't change the schema or escape the database", async () => {
  const { grant } = require("../src/db/create-app-role");
  const r = await grant({ log: () => {} });
  assert.ok(r.password, "a new role gets a password");
  const u = new URL(process.env.DATABASE_URL);
  u.username = "blst_app_test";
  u.password = r.password;
  appPool = new Pool({ connectionString: u.toString(), max: 1 });
  const q = (sql, p) => appPool.query(sql, p);
  // Without an organization the app role sees and may write nothing.
  assert.equal((await q("SELECT count(*)::int AS n FROM tournaments")).rows[0].n, 0);
  await assert.rejects(q("INSERT INTO tournaments (name) VALUES ('No org')"), /row-level security|null value/);
  await q("SELECT set_config('app.org_id', '1', false)");

  const role = (await q("SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user")).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolcreaterole: false, rolcreatedb: false });

  // Everyday work: read and write rows, run the Factions functions.
  const t = (await q("INSERT INTO tournaments (name) VALUES ('Role test') RETURNING id")).rows[0];
  await q("UPDATE tournaments SET season = '2026' WHERE id = $1", [t.id]);
  await q("INSERT INTO players (first_name, last_name, email) VALUES ('Role', 'Test', 'role.test@example.com')");
  assert.ok((await q("SELECT 1 FROM faction_members WHERE email = 'role.test@example.com'")).rowCount, "triggers run");
  await q("DELETE FROM tournaments WHERE id = $1", [t.id]);

  // Not allowed: schema changes, other databases' data, files, programs, roles.
  for (const [sql, why] of [
    ["CREATE TABLE evil (id int)", "create tables"],
    ["DROP TABLE players", "drop tables"],
    ["ALTER TABLE players ADD COLUMN x int", "alter tables"],
    ["TRUNCATE audit_log", "truncate the audit log"],
    ["COPY players TO PROGRAM 'id'", "run programs"],
    ["SELECT pg_read_file('/etc/passwd')", "read server files"],
    ["CREATE ROLE sneaky", "create roles"],
    ["ALTER ROLE blst_app_test SUPERUSER", "make itself superuser"],
  ]) {
    await assert.rejects(q(sql), /permission denied|must be|not allowed|only roles/i, `must not ${why}`);
  }
});

test("migrations run under the owner login while the app runs as the app role", async () => {
  // A later migration creates a table as the owner: the app role gets rights
  // to it automatically (default privileges), without being able to create it.
  await db.query("CREATE TABLE future_table (id serial PRIMARY KEY, v text)");
  await appPool.query("INSERT INTO future_table (v) VALUES ('ok')");
  assert.equal((await appPool.query("SELECT v FROM future_table")).rows[0].v, "ok");
  await db.query("DROP TABLE future_table");

  // migrate() with nothing new to apply needs no schema rights.
  const config = require("../src/config");
  const saved = config.databaseUrl;
  const { Pool: P } = require("pg");
  const u = new URL(saved);
  u.username = "blst_app_test";
  u.password = (await require("../src/db/create-app-role").grant({ rotate: true, log: () => {} })).password;
  const p = new P({ connectionString: u.toString(), max: 1 });
  await assert.rejects(p.query("CREATE TABLE IF NOT EXISTS x2 (id int)"), /permission denied/);
  await p.end();
});

test("queries can't run forever, and the Order guard can't be skipped by the app role's updates", async () => {
  const config = require("../src/config");
  assert.ok(config.dbStatementTimeoutMs > 0 && config.dbStatementTimeoutMs <= 60000);
  const r = await db.query("SHOW statement_timeout");
  assert.notEqual(r.rows[0].statement_timeout, "0");
  await assert.rejects(db.query("SELECT pg_sleep(30)"), /statement timeout|canceling statement/);
  await assert.rejects(
    appPool.query("SELECT set_config('app.org_id', '1', false); UPDATE faction_members SET order_slug = CASE WHEN order_slug = 'ursonne' THEN 'thalkara' ELSE 'ursonne' END WHERE email = 'role.test@example.com'"),
    /permanent/,
  );
});

const { Pool } = require("pg");
const db = require("../db");

// One-time move from a standalone BLPA Factions database (the Prisma app at
// github.com/jakesatcher/blpafactions) into BLST. Safe to run more than once.
//
// The standalone app assigned each Order first, so its Order always wins:
// if BLST already derived an Order for the same email (it uses the same
// formula, so this should never differ) the standalone one replaces it and
// the report lists it. Bonus points are copied (not added), participation
// and achievements are upserted, and event ids are kept, so tournaments
// already linked to a Factions event stay linked.

/** Accepts Prisma-style URLs: ?schema=x becomes the search_path. */
function sourcePool(url, { ssl } = {}) {
  const u = new URL(url);
  const schema = u.searchParams.get("schema") || "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) throw new Error("invalid schema name");
  u.searchParams.delete("schema");
  const sslmode = u.searchParams.get("sslmode");
  return new Pool({
    connectionString: u.toString(),
    ssl: ssl || (sslmode && sslmode !== "disable") ? { rejectUnauthorized: false } : undefined,
    max: 2,
    options: `-c search_path=${schema}`,
  });
}

async function importFrom(url, { log = () => {}, ssl } = {}) {
  const src = sourcePool(url, { ssl });
  let source;
  try {
    const q = async (sql) => (await src.query(sql)).rows;
    source = {
      members: await q(`SELECT p.id, p.email, p."displayName" AS display_name, p."leagueAppsUserId" AS leagueapps_user_id,
                               p."orderSlug" AS order_slug, p."createdAt" AS created_at,
                               COALESCE(op.points, 0) AS bonus_points, COALESCE(op.degree, 1) AS degree
                          FROM players p LEFT JOIN order_progress op ON op."playerId" = p.id ORDER BY p."createdAt"`),
      events: await q(`SELECT id, name, "leagueAppsEventId" AS leagueapps_event_id, "startDate"::date AS start_date,
                              "endDate"::date AS end_date, "createdAt" AS created_at FROM events`),
      participation: await q(`SELECT "playerId" AS member_id, "eventId" AS event_id, "pointsEarned" AS points_earned, placement,
                                     "registeredAt" AS registered_at, metadata FROM event_participation`),
      achievements: await q(`SELECT id, "playerId" AS member_id, code, title, "eventId" AS event_id, "awardedAt" AS awarded_at FROM achievements`),
    };
  } finally {
    await src.end();
  }
  log(`Read ${source.members.length} members, ${source.events.length} events, ${source.participation.length} participation rows, ${source.achievements.length} achievements.`);

  const report = { members: 0, new_members: 0, order_changed: [], events: 0, participation: 0, achievements: 0, skipped: [] };
  await db.tx(async (c) => {
    // Lets this transaction set Orders explicitly (see the guard trigger).
    await c.query("SET LOCAL blst.factions_import = 'on'");
    const known = new Set((await c.query("SELECT slug FROM faction_orders")).rows.map((r) => r.slug));
    for (const m of source.members) {
      if (!known.has(m.order_slug)) {
        report.skipped.push({ member: m.id, reason: `unknown Order "${m.order_slug}"` });
        continue;
      }
      await c.query("SAVEPOINT m");
      try {
        const before = (await c.query("SELECT order_slug FROM faction_members WHERE email = lower(btrim($1))", [m.email])).rows[0];
        await c.query(
          `INSERT INTO faction_members (id, email, display_name, leagueapps_user_id, order_slug, bonus_points, degree, source, created_at)
           VALUES ($1, lower(btrim($2)), $3, $4, $5, $6, $7, 'factions-import', $8)
           ON CONFLICT (email) DO UPDATE SET order_slug = EXCLUDED.order_slug, bonus_points = EXCLUDED.bonus_points, degree = EXCLUDED.degree,
             display_name = COALESCE(EXCLUDED.display_name, faction_members.display_name),
             leagueapps_user_id = COALESCE(faction_members.leagueapps_user_id, EXCLUDED.leagueapps_user_id),
             created_at = LEAST(faction_members.created_at, EXCLUDED.created_at)`,
          [m.id, m.email, m.display_name, m.leagueapps_user_id, m.order_slug, m.bonus_points, m.degree, m.created_at],
        );
        await c.query("RELEASE SAVEPOINT m");
        report.members += 1;
        if (!before) report.new_members += 1;
        else if (before.order_slug !== m.order_slug) report.order_changed.push({ member: m.id, from: before.order_slug, to: m.order_slug });
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT m");
        report.skipped.push({ member: m.id, reason: err.message });
      }
    }
    // Keep BLST players' public Order label in step.
    await c.query(
      `UPDATE players p SET factions_order = m.order_slug FROM faction_members m
        WHERE p.factions_player_id = m.id AND p.factions_order IS DISTINCT FROM m.order_slug`,
    );
    for (const e of source.events) {
      await c.query(
        `INSERT INTO faction_events (id, name, leagueapps_event_id, start_date, end_date, created_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, start_date = COALESCE(EXCLUDED.start_date, faction_events.start_date),
           end_date = COALESCE(EXCLUDED.end_date, faction_events.end_date),
           leagueapps_event_id = COALESCE(faction_events.leagueapps_event_id, EXCLUDED.leagueapps_event_id)`,
        [e.id, e.name, e.leagueapps_event_id, e.start_date, e.end_date, e.created_at],
      );
      report.events += 1;
    }
    const memberIds = new Set((await c.query("SELECT id FROM faction_members")).rows.map((r) => r.id));
    for (const p of source.participation) {
      if (!memberIds.has(p.member_id)) continue;
      await c.query(
        `INSERT INTO faction_participation (member_id, event_id, points_earned, placement, registered_at, metadata) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (member_id, event_id) DO UPDATE SET points_earned = EXCLUDED.points_earned, placement = EXCLUDED.placement`,
        [p.member_id, p.event_id, p.points_earned, p.placement, p.registered_at, p.metadata ? JSON.stringify(p.metadata) : null],
      );
      report.participation += 1;
    }
    for (const a of source.achievements) {
      if (!memberIds.has(a.member_id)) continue;
      await c.query(
        `INSERT INTO faction_achievements (id, member_id, code, title, event_id, awarded_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [a.id, a.member_id, a.code, a.title, a.event_id, a.awarded_at],
      );
      report.achievements += 1;
    }
  });
  return report;
}

/**
 * Zero-touch move for the earlier side-by-side Railway setup, where the
 * standalone app kept its tables in the "factions" schema of this same
 * database: on boot, import them once. Opt out with FACTIONS_AUTO_IMPORT=false.
 */
async function autoImportSharedSchema({ log = console.log } = {}) {
  if (/^(0|false|no|off)$/i.test(process.env.FACTIONS_AUTO_IMPORT || "")) return null;
  const found = await db.one("SELECT to_regclass('factions.players') IS NOT NULL AND to_regclass('factions.order_progress') IS NOT NULL AS ok");
  if (!found.ok) return null;
  if (await db.one("SELECT 1 FROM integration_settings WHERE key = 'factions_schema_imported'")) return null;
  const config = require("../config");
  const u = new URL(config.databaseUrl);
  u.searchParams.set("schema", "factions");
  log("Found a standalone BLPA Factions database in the \"factions\" schema: importing it once…");
  const report = await importFrom(u.toString(), { log, ssl: config.databaseSsl });
  await db.query(
    "INSERT INTO integration_settings (key, value) VALUES ('factions_schema_imported', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify({ at: new Date().toISOString(), members: report.members, events: report.events, order_changed: report.order_changed.length })],
  );
  log(`Factions import: ${report.members} members (${report.new_members} new), ${report.events} events, ${report.participation} participation rows, ${report.achievements} achievements.`);
  return report;
}

module.exports = { importFrom, sourcePool, autoImportSharedSchema };

// BLPA Factions, built into BLST: Orders for life, automatic membership,
// points, achievements, bulk upload, events, privacy and the import from a
// standalone Factions database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startApp, waitFor, ownerQuery, closeOwner } = require("./helpers");

let ctx;
let api;
let db;
let factions;

test.before(async () => {
  ctx = await startApp();
  api = ctx.api;
  db = require("../src/db");
  factions = require("../src/services/factions");
  factions.start();
});

test.after(async () => {
  require("../src/services/gameControl").disarmAll();
  ctx.server.close();
  await closeOwner();
  await db.close();
});

test("the database derives the same member id and Order as the standalone app", async () => {
  const emails = ["Jane.Doe+hockey@Gmail.COM", "  sam@example.com", "üser@exämple.de"];
  for (let i = 0; i < 300; i++) emails.push(`${crypto.randomBytes(1 + (i % 20)).toString("hex")}@ex${i % 5}.org`);
  const rows = await db.many("SELECT e, blst_faction_order(1, e) AS o, blst_faction_member_id(e) AS i FROM unnest($1::text[]) e", [emails]);
  for (const r of rows) {
    assert.equal(r.o, factions.assignOrder(r.e), r.e);
    assert.equal(r.i, factions.memberId(r.e), r.e);
  }
  // Known values from the standalone Factions app's formula.
  assert.equal(factions.memberId("Sam@Example.com"), "c2FtQGV4YW1wbGUuY29t");
});

test("an Order is for life: the database refuses to move a member", async () => {
  const { member } = await factions.getOrCreateMember({ email: "lifer@example.com" });
  const other = factions.ORDERS.find((o) => o.slug !== member.order_slug).slug;
  await assert.rejects(db.query("UPDATE faction_members SET order_slug = $2 WHERE id = $1", [member.id, other]), /permanent/);
  await assert.rejects(db.query("UPDATE faction_members SET email = 'x@example.com' WHERE id = $1", [member.id]), /can't change/);
  // Creating "again" (any path) never changes it.
  const again = await factions.getOrCreateMember({ email: " LIFER@example.com ", display_name: "Lifer" });
  assert.equal(again.created, false);
  assert.equal(again.member.order_slug, member.order_slug);
  assert.equal(again.member.display_name, "Lifer");
});

test("players with an email join their Order automatically", async () => {
  const p = await api("POST", "/players", { first_name: "Ava", last_name: "Stone", email: "Ava@Example.com" });
  assert.equal(p.status, 201);
  const full = (await api("GET", `/players/${p.body.id}`)).body;
  assert.equal(full.factions_player_id, factions.memberId("ava@example.com"));
  assert.equal(full.factions_order, factions.assignOrder("ava@example.com"));
  const m = await db.one("SELECT * FROM faction_members WHERE id = $1", [full.factions_player_id]);
  assert.equal(m.display_name, "Ava Stone");
  assert.equal(m.source, "blst");

  // A new email links to that email's member; removing it unlinks.
  await api("PATCH", `/players/${p.body.id}`, { email: "ava.stone@example.com" });
  let row = await db.one("SELECT factions_player_id, factions_order FROM players WHERE id = $1", [p.body.id]);
  assert.equal(row.factions_player_id, factions.memberId("ava.stone@example.com"));
  assert.ok(await db.one("SELECT 1 FROM faction_members WHERE email = 'ava@example.com'"), "the old member stays");
  await api("PATCH", `/players/${p.body.id}`, { email: null });
  row = await db.one("SELECT factions_player_id, factions_order FROM players WHERE id = $1", [p.body.id]);
  assert.equal(row.factions_player_id, null);
  assert.equal(row.factions_order, null);

  // Without an email there's no member, and nothing breaks.
  assert.equal((await api("POST", "/players", { first_name: "No", last_name: "Email" })).status, 201);
});

test("admins find, create, award points and achievements", async () => {
  const c = await api("POST", "/factions/members", { email: "Kim@Example.com", display_name: "Kim Lee" });
  assert.equal(c.status, 201);
  assert.equal(c.body.created, true);
  assert.equal(c.body.order.slug, factions.assignOrder("kim@example.com"));
  const id = c.body.id;
  const again = await api("POST", "/factions/members", { email: "kim@example.com" });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);

  assert.equal((await api("POST", "/factions/members/find", { email: "KIM@example.com" })).body.id, id);
  assert.equal((await api("POST", "/factions/members/find", { email: "nobody@example.com" })).status, 404);
  const list = (await api("GET", "/factions/members?q=kim")).body;
  assert.equal(list.total, 1);
  assert.equal(list.members[0].email, "kim@example.com");

  let m = (await api("POST", `/factions/members/${id}/points`, { points: 5 })).body;
  assert.equal(m.bonus_points, 5);
  m = (await api("POST", `/factions/members/${id}/points`, { points: -2 })).body;
  assert.equal(m.total_points, 3);
  assert.equal((await api("POST", `/factions/members/${id}/points`, { points: 0 })).status, 400);

  const a1 = await api("POST", `/factions/members/${id}/achievements`, { code: "first_event", title: "Played First Event" });
  assert.equal(a1.status, 201);
  const a2 = await api("POST", `/factions/members/${id}/achievements`, { code: "first_event", title: "Played First Event" });
  assert.equal(a2.status, 200, "same code again is a no-op");
  assert.equal((await api("GET", `/factions/members/${id}`)).body.achievements.length, 1);
  assert.equal((await api("POST", `/factions/members/${id}/achievements`, { code: "bad code!", title: "x" })).status, 400);
});

test("bulk upload: preview, import, re-upload changes nothing", async () => {
  const csv = "Email;Display Name\nnew1@example.com;New One\nkim@example.com;Kim\nnot-an-email;Bad\nnew1@example.com;Dup\n;Empty\n";
  const dry = await api("POST", "/factions/members/import", { csv, dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.new_members, 1);
  assert.equal(dry.body.existing_members, 2, "kim exists; second new1 is a duplicate");
  assert.equal(dry.body.invalid, 2);
  assert.ok(!(await db.one("SELECT 1 FROM faction_members WHERE email = 'new1@example.com'")), "dry run writes nothing");

  const real = await api("POST", "/factions/members/import", { csv });
  assert.equal(real.status, 201);
  assert.equal(real.body.new_members, 1);
  const row = await db.one("SELECT * FROM faction_members WHERE email = 'new1@example.com'");
  assert.equal(row.order_slug, factions.assignOrder("new1@example.com"));
  assert.equal(row.source, "upload");
  const before = (await db.one("SELECT count(*) AS n FROM faction_members")).n;
  const again = await api("POST", "/factions/members/import", { csv });
  assert.equal(again.body.new_members, 0);
  assert.equal((await db.one("SELECT count(*) AS n FROM faction_members")).n, before);

  // Raw text/csv works too.
  const res = await fetch(`${ctx.base}/api/v1/factions/members/import?dry_run=true`, {
    method: "POST", headers: { authorization: "Bearer test-admin-token", "content-type": "text/csv" }, body: "email\nraw@example.com\n",
  });
  assert.equal((await res.json()).new_members, 1);
  assert.equal((await api("POST", "/factions/members/import", { csv: "name\nNo email column\n" })).status, 400);
});

test("events: participation, per-event and all-time Order standings", async () => {
  const e = await api("POST", "/factions/events", { name: "Summer Slam", start_date: "2026-07-01" });
  assert.equal(e.status, 201);
  const kim = (await api("POST", "/factions/members/find", { email: "kim@example.com" })).body;
  assert.equal((await api("POST", `/factions/events/${e.body.id}/participation`, { member_id: kim.id, points_earned: 7, placement: 2 })).status, 201);
  // By email: creates the member if needed.
  await api("POST", `/factions/events/${e.body.id}/participation`, { email: "walkup@example.com", points_earned: 4 });
  // Upsert: recording again replaces.
  await api("POST", `/factions/events/${e.body.id}/participation`, { member_id: kim.id, points_earned: 8 });

  const ev = (await api("GET", `/factions/events/${e.body.id}`)).body;
  assert.equal(ev.participation.length, 2);
  const totals = (await api("GET", `/factions/events/${e.body.id}/totals`, undefined, null)).body;
  assert.equal(totals.reduce((s, o) => s + o.total_points, 0), 12);
  assert.equal(totals[0].rank, 1);

  const all = (await api("GET", "/factions/orders", undefined, null)).body;
  const kimOrder = all.find((o) => o.slug === kim.order_slug);
  assert.ok(kimOrder.event_points >= 8);
  assert.equal(kimOrder.total_points, kimOrder.bonus_points + kimOrder.event_points);
  const m = (await api("GET", `/factions/members/${kim.id}`)).body;
  assert.equal(m.total_points, 3 + 8, "bonus 3 + event 8");
});

test("privacy: public Factions data has names and totals, never emails or member ids", async () => {
  const pub = await api("GET", "/factions", undefined, null);
  assert.equal(pub.status, 200);
  const text = JSON.stringify(pub.body);
  assert.ok(!text.includes("@"));
  assert.ok(!text.includes(factions.memberId("kim@example.com")));
  for (const path of ["/factions/members", "/factions/status", `/factions/members/${factions.memberId("kim@example.com")}`]) {
    assert.equal((await api("GET", path, undefined, null)).status, 401, path);
  }
  const scorekeeper = (await api("POST", "/admin/api-keys", { name: "sk", role: "scorekeeper" })).body.key;
  assert.equal((await api("GET", "/factions/members", undefined, scorekeeper)).status, 403);

  // Member ids (reversible emails) never reach the audit log.
  const id = factions.memberId("kim@example.com");
  await api("POST", `/factions/members/${id}/points`, { points: 1 });
  await waitFor(async () => (await db.one("SELECT 1 FROM audit_log WHERE path = '/api/v1/factions/members/:id/points'")) || null);
  assert.ok(!(await db.one("SELECT 1 FROM audit_log WHERE path LIKE $1", [`%${id}%`])));
});

test("points update automatically when a game in a linked tournament goes final", async () => {
  const t = (await api("POST", "/tournaments", { name: "Auto Cup", num_teams: 2, start_date: "2026-11-01" })).body;
  const teams = (await api("GET", `/tournaments/${t.id}`)).body.teams;
  const csv = `team,number,first_name,last_name,position,email\n${teams[0].name},9,Auto,Scorer,C,auto.scorer@example.com\n${teams[1].name},30,Other,Goalie,G,\n`;
  assert.equal((await api("POST", `/import/roster/${t.id}`, { csv })).status, 200);
  assert.equal((await api("POST", `/tournaments/${t.id}/factions/link`, {})).status, 200);
  const g = (await api("POST", `/tournaments/${t.id}/games`, { home_team_id: teams[0].id, away_team_id: teams[1].id })).body;
  await api("POST", `/games/${g.id}/start`, {});
  const scorer = await db.one("SELECT id FROM players WHERE email = 'auto.scorer@example.com'");
  await api("POST", `/games/${g.id}/events`, { type: "goal", player_id: scorer.id });
  await api("POST", `/games/${g.id}/period/next`);
  await api("POST", `/games/${g.id}/period/next`);
  assert.equal((await api("POST", `/games/${g.id}/end`, {})).status, 200);

  const id = factions.memberId("auto.scorer@example.com");
  const m = await waitFor(async () => {
    await factions.settled();
    const r = (await api("GET", `/factions/members/${id}`)).body;
    return r.event_points > 0 ? r : null;
  });
  // 1 GP + 1 goal*2 + 1 win, and the standings rank makes them champion (+5)
  assert.equal(m.event_points, 1 + 2 + 1 + 5);
});

test("import from a standalone Factions database keeps its Orders and data", async () => {
  // The standalone app's tables (Prisma schema), in their own schema here.
  await ownerQuery(`DROP SCHEMA IF EXISTS legacy CASCADE; CREATE SCHEMA legacy;
    CREATE TABLE legacy.orders (slug TEXT PRIMARY KEY, name TEXT NOT NULL, animal TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE legacy.players (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, "displayName" TEXT, "leagueAppsUserId" TEXT UNIQUE,
      "orderSlug" TEXT NOT NULL REFERENCES legacy.orders(slug), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);
    CREATE TABLE legacy.order_progress ("playerId" TEXT PRIMARY KEY REFERENCES legacy.players(id), "orderSlug" TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0, degree INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL);
    CREATE TABLE legacy.events (id TEXT PRIMARY KEY, "leagueAppsEventId" TEXT UNIQUE, name TEXT NOT NULL, "startDate" TIMESTAMP(3), "endDate" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);
    CREATE TABLE legacy.achievements (id TEXT PRIMARY KEY, "playerId" TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, "eventId" TEXT,
      "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE legacy.event_participation (id TEXT PRIMARY KEY, "playerId" TEXT NOT NULL, "eventId" TEXT NOT NULL, "pointsEarned" INTEGER NOT NULL DEFAULT 0,
      placement INTEGER, "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, metadata JSONB);`);
  await ownerQuery(`INSERT INTO legacy.orders (slug, name, animal) SELECT slug, name, 'x' FROM factions WHERE org_id = 1`);
  const kimId = factions.memberId("kim@example.com");
  const oldId = factions.memberId("veteran@example.com");
  // Kim exists in both; pretend the standalone app had put Kim elsewhere.
  const kimNow = (await db.one("SELECT order_slug FROM faction_members WHERE id = $1", [kimId])).order_slug;
  const kimThen = factions.ORDERS.find((o) => o.slug !== kimNow).slug;
  await ownerQuery(`INSERT INTO legacy.players (id, email, "displayName", "orderSlug", "updatedAt") VALUES
    ($1, 'veteran@example.com', 'Vera Veteran', 'ursonne', now()), ($2, 'kim@example.com', 'Kim Lee', $3, now())`, [oldId, kimId, kimThen]);
  await ownerQuery(`INSERT INTO legacy.order_progress ("playerId", "orderSlug", points, "updatedAt") VALUES ($1, 'ursonne', 40, now())`, [oldId]);
  await ownerQuery(`INSERT INTO legacy.events (id, name, "startDate", "updatedAt") VALUES ('ckoldevent1', 'Spring Fling 2026', '2026-04-01', now())`);
  await ownerQuery(`INSERT INTO legacy.event_participation (id, "playerId", "eventId", "pointsEarned", placement) VALUES ('p1', $1, 'ckoldevent1', 15, 1)`, [oldId]);
  await ownerQuery(`INSERT INTO legacy.achievements (id, "playerId", code, title, "eventId") VALUES ('a1', $1, 'founder', 'Founding member', 'ckoldevent1')`, [oldId]);

  const { importFrom } = require("../src/services/factionsImport");
  const url = `${process.env.DATABASE_URL}?schema=legacy`;
  const r = await importFrom(url);
  assert.equal(r.members, 2);
  assert.equal(r.new_members, 1);
  assert.deepEqual(r.order_changed, [{ member: kimId, from: kimNow, to: kimThen }]);
  const vera = (await api("GET", `/factions/members/${oldId}`)).body;
  assert.equal(vera.order_slug, "ursonne", "the standalone Order is kept even if the formula would differ");
  assert.equal(vera.bonus_points, 40);
  assert.equal(vera.event_points, 15);
  assert.equal(vera.achievements[0].code, "founder");
  assert.equal((await api("GET", "/factions/events/ckoldevent1")).body.name, "Spring Fling 2026");
  // BLST players linked to Kim show the standalone Order.
  // Re-running changes nothing.
  const again = await importFrom(url);
  assert.equal(again.new_members, 0);
  assert.equal(again.order_changed.length, 0);
  assert.equal((await api("GET", `/factions/members/${oldId}`)).body.total_points, 55);

  // Earlier side-by-side deploys kept the standalone app in this database's
  // "factions" schema: BLST imports that by itself, exactly once.
  await ownerQuery("ALTER SCHEMA legacy RENAME TO factions");
  const { autoImportSharedSchema } = require("../src/services/factionsImport");
  const first = await autoImportSharedSchema({ log: () => {} });
  assert.equal(first.members, 2);
  assert.equal(await autoImportSharedSchema({ log: () => {} }), null, "only once");
  await ownerQuery("DROP SCHEMA factions CASCADE");
});

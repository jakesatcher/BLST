// Moves a standalone BLPA Factions database into BLST (safe to re-run):
//   npm run factions:import -- "postgresql://...factions database URL..."
// or set FACTIONS_DATABASE_URL. A Prisma-style ?schema=factions is understood.
const db = require("./index");
const { importFrom } = require("../services/factionsImport");

const url = process.argv.slice(2).find((a) => !a.startsWith("-")) || process.env.FACTIONS_DATABASE_URL;
if (!url) {
  console.error('Usage: npm run factions:import -- "postgresql://user:pass@host:5432/db[?schema=factions]"');
  process.exit(2);
}

(async () => {
  await db.migrate({ log: () => {} });
  const r = await importFrom(url, { log: console.log });
  console.log(`Imported ${r.members} members (${r.new_members} new), ${r.events} events, ${r.participation} participation rows, ${r.achievements} achievements.`);
  if (r.order_changed.length) console.log(`Orders taken from the standalone app for ${r.order_changed.length} member(s):`, r.order_changed);
  if (r.skipped.length) console.log(`Skipped ${r.skipped.length}:`, r.skipped.slice(0, 20));
})()
  .catch((err) => {
    console.error(`Factions import failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());

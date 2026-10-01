// Moves a standalone BLPA Factions database into BLST (safe to re-run):
//   npm run factions:import -- "postgresql://...factions database URL..."
// or set FACTIONS_DATABASE_URL. A Prisma-style ?schema=factions is understood.
const db = require("./index");
const { importFrom } = require("../services/factionsImport");

const { withOrg } = require("../lib/context");

// --org <slug> picks the organization to import into (default: blpa).
const args = process.argv.slice(2);
const orgFlag = args.indexOf("--org");
const orgSlug = orgFlag >= 0 ? args[orgFlag + 1] : "blpa";
const url = args.find((a, i) => !a.startsWith("-") && i !== orgFlag + 1) || process.env.FACTIONS_DATABASE_URL;
if (!url) {
  console.error('Usage: npm run factions:import -- "postgresql://user:pass@host:5432/db[?schema=factions]"');
  process.exit(2);
}

(async () => {
  await db.migrate({ log: () => {} });
  const org = await withOrg("*", () => db.one("SELECT id FROM organizations WHERE slug = $1", [orgSlug]));
  if (!org) throw new Error(`no organization "${orgSlug}"`);
  const r = await withOrg(org.id, () => importFrom(url, { log: console.log }));
  console.log(`Imported ${r.members} members (${r.new_members} new), ${r.events} events, ${r.participation} participation rows, ${r.achievements} achievements.`);
  if (r.order_changed.length) console.log(`Orders taken from the standalone app for ${r.order_changed.length} member(s):`, r.order_changed);
  if (r.skipped.length) console.log(`Skipped ${r.skipped.length}:`, r.skipped.slice(0, 20));
})()
  .catch((err) => {
    console.error(`Factions import failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());

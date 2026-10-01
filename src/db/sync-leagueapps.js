// One LeagueApps sync, for Heroku Scheduler / a Railway cron:
//   npm run sync:leagueapps   (add --from-scratch to re-read everything)
// Registrations first, then members (so every member gets their Factions Order).
const db = require("./index");
const leagueapps = require("../services/leagueapps");

const { withOrg } = require("../lib/context");

withOrg(Number(process.env.LEAGUEAPPS_ORG_ID || 1), async () => {
  const fromScratch = process.argv.includes("--from-scratch");
  const s = await leagueapps.sync({ fromScratch });
  console.log(`LeagueApps registrations: ${s.seen} records, ${s.created} new, ${s.updated} updated, ${s.returning} returning, ${s.needs_review} to review, ${s.skipped_unlinked} from unlinked programs, ${s.errors.length} errors`);
  const m = await leagueapps.syncMembers({ fromScratch });
  console.log(`LeagueApps members: ${m.seen} records, ${m.new_members} new Factions members, ${m.existing_members} existing, ${m.errors.length} errors`);
})
  .catch((err) => {
    console.error(`LeagueApps sync failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());

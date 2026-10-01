// One LeagueApps registration sync, for Heroku Scheduler:
//   npm run sync:leagueapps   (add --from-scratch to re-read everything)
const db = require("./index");
const leagueapps = require("../services/leagueapps");

leagueapps
  .sync({ fromScratch: process.argv.includes("--from-scratch") })
  .then((s) => console.log(`LeagueApps: ${s.seen} records, ${s.created} new, ${s.updated} updated, ${s.returning} returning, ${s.needs_review} to review, ${s.skipped_unlinked} from unlinked programs, ${s.errors.length} errors`))
  .catch((err) => {
    console.error(`LeagueApps sync failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());

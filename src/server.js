const config = require("./config");
const db = require("./db");
const { createApp } = require("./app");
const control = require("./services/gameControl");
const webhooks = require("./services/webhooks");
const factions = require("./services/factions");

// Same rule as the BLPA Factions app: never boot a deployed instance with
// its write APIs wide open.
if (config.deployed && !config.adminToken) {
  throw new Error("ADMIN_TOKEN must be set before deploying (heroku config:set ADMIN_TOKEN=...)");
}

async function main() {
  await db.migrate();
  webhooks.start();
  factions.start();
  const rearmed = await control.rearmAll();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`BLST listening on port ${config.port}${rearmed ? ` (${rearmed} running clock(s) restored)` : ""}`);
    if (!config.adminToken) console.warn("ADMIN_TOKEN is not set: all write APIs are open (local development only)");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

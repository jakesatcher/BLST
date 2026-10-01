# Deploying to Railway

BLST, with BLPA Factions built in, runs as one Railway service with one
Postgres database. The same script and this same guide are in the BLST and
blpafactions repos.

## Deploy

1. On railway.com, let Railway's GitHub app read **jakesatcher/BLST**:
   Account → Integrations → GitHub.
2. From either repo, run:
   ```bash
   npm run railway
   ```
   You'll be asked to log in to Railway if you aren't already. You don't have
   to install anything: the script uses the Railway CLI if you have it, or
   runs it through `npx`.
3. When it finishes, it prints the **setup key**. Open the address it prints →
   **Admin & setup** → **Set up the admin account**, and enter the key.

That's it. The first boot:
- creates the tables;
- loads a demo tournament that counts for Factions, so the Factions page has
  standings straight away.

## Already running the two-app setup?

If you deployed with the earlier version of this script (separate `blst` and
`factions` services), upgrade like this:

1. Redeploy `blst` from the updated branch.
   - It finds the Factions data in the shared database (`factions` schema) and
     imports it once: members keep their Orders, points and achievements.
   - Look for `Factions import:` in `railway logs --service blst`.
2. In the `blst` service's Variables tab, delete `FACTIONS_BASE_URL`,
   `FACTIONS_ADMIN_TOKEN` and `FACTIONS_AUTO_SYNC`.
3. Delete the `factions` service.

## After deploying

Sign-in codes go to the logs until email and text messages are set up. To send
real codes, then stop logging them:

```bash
railway variable set --service blst SMTP_URL='smtps://USER:PASS@smtp.example.com:465' EMAIL_FROM='BLST <no-reply@example.org>'
railway variable set --service blst TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+15551234567
railway variable set --service blst AUTH_LOG_CODES=false
```

Without the CLI installed, write `npx @railway/cli` instead of `railway`, or
set the variables in the service's **Variables** tab on railway.com.

**Recommended:** run the app with a least-privilege database login. Railway's
database login is a superuser.
1. Create the restricted login:
   ```bash
   railway ssh --service blst npm run db:app-role
   ```
2. In the `blst` service's Variables tab, set the two values it prints:
   - `DATABASE_URL`: the `blst_app` login, which can only read and write rows;
   - `DATABASE_MIGRATION_URL`: `${{Postgres.DATABASE_URL}}`, the owner login,
     used for migrations only.
3. Admin → Security should now show ✓ for the database login.

Optional:
- LeagueApps variables (see the README), which also import every LeagueApps
  member into their Factions Order;
- a custom domain under Settings → Networking.

## Good to know

- **Branch:** the script deploys `claude/great-bardeen-wfd39q`. After merging,
  run `BLST_BRANCH=main npm run railway`, or change the branch in the service's
  Settings.
- **No build settings to fill in:** `railpack.json` tells Railway's builder how
  to start the app; database updates run on boot. Railway's older
  `railway.json` file is deprecated, so it isn't used.
- **Fails closed:** BLST refuses to start on Railway without `ADMIN_TOKEN`
  until an admin account exists (Railway is detected through
  `RAILWAY_ENVIRONMENT_ID`).
- **Keep `blst` at one replica:** live scores are shared in memory.

## Without the script (dashboard)

1. **New Project → Deploy PostgreSQL.**
2. **+ Create → GitHub Repo → jakesatcher/BLST**. Name the service `blst` and
   set these variables:
   ```
   PORT=8080
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ADMIN_TOKEN=<random, e.g. openssl rand -hex 24>
   AUTH_SECRET=<random, e.g. openssl rand -hex 32>
   AUTH_LOG_CODES=true
   SEED_DEMO=true
   ```
3. **Settings → Networking → Generate Domain** (port 8080).

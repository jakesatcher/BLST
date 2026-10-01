# Deploying to Railway

BLST and BLPA Factions deploy together into one Railway project. The same
script and this same guide are in both repos, so you can start from either one.

## Deploy

1. On railway.com, let Railway's GitHub app read both repos: Account →
   Integrations → GitHub → allow **jakesatcher/BLST** and **jakesatcher/blpafactions**.
2. From either repo, run:
   ```bash
   npm run railway
   ```
   You'll be asked to log in to Railway if you aren't already. You don't have
   to install anything: the script uses the Railway CLI if you have it, or
   runs it through `npx`.
3. When it finishes, it prints BLST's **setup key** and the **Factions admin
   token**. Open the `blst` address it prints → **Admin & setup** → **Set up
   the admin account**, and enter the setup key.

That's it. Railway builds both apps (a few minutes); the first boot creates the
database tables, adds the six Factions Orders and loads a demo tournament.

## What you get

| Service | Code | Notes |
|---|---|---|
| `blst` | jakesatcher/BLST | Public address; uses the `public` schema |
| `factions` | jakesatcher/blpafactions | Public address; uses the `factions` schema |
| `Postgres` | Railway Postgres | One database shared by both apps |

BLST reaches Factions over Railway's private network
(`factions.railway.internal`), which is encrypted and never leaves Railway.

## After deploying

Sign-in codes go to the `blst` logs until email and text messages are set
up. To send real codes, then stop logging them:

```bash
railway variable set --service blst SMTP_URL='smtps://USER:PASS@smtp.example.com:465' EMAIL_FROM='BLST <no-reply@example.org>'
railway variable set --service blst TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+15551234567
railway variable set --service blst AUTH_LOG_CODES=false
```

(Without the CLI installed, write `npx @railway/cli` instead of `railway`, or
set the variables in each service's **Variables** tab on railway.com.)

Optional:
- `FACTIONS_AUTO_SYNC=true` on `blst`;
- LeagueApps variables on either app (see each README);
- a custom domain under Settings → Networking.

## Good to know

- **Branches:** the script deploys the `claude/great-bardeen-wfd39q` branch of
  both repos. After merging, run `BLST_BRANCH=main FACTIONS_BRANCH=main npm run railway`,
  or change the branch in each service's Settings.
- **No build settings to fill in:** each repo's `railpack.json` tells Railway's
  builder how to start the app, including database updates. Railway's older
  `railway.json` file is deprecated, so it isn't used.
- **Fails closed:** both apps refuse to start on Railway without `ADMIN_TOKEN`
  (detected through `RAILWAY_ENVIRONMENT_ID`), so neither can come up with its
  admin routes open.
- **Separate databases:** to give Factions its own database, add a second
  Postgres and point Factions' `DATABASE_URL` at it.
- **Keep `blst` at one replica:** live scores are shared in memory.

## Without the script (dashboard)

1. **New Project → Deploy PostgreSQL.**
2. **+ Create → GitHub Repo → jakesatcher/blpafactions**. Name the service
   `factions` and set these variables:
   ```
   PORT=8080
   ADMIN_TOKEN=<random, e.g. openssl rand -hex 24>
   DATABASE_URL=${{Postgres.DATABASE_URL}}?schema=factions
   ```
3. **+ Create → GitHub Repo → jakesatcher/BLST**. Name the service `blst` and
   set these variables:
   ```
   PORT=8080
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ADMIN_TOKEN=<random>
   AUTH_SECRET=<random, e.g. openssl rand -hex 32>
   AUTH_LOG_CODES=true
   SEED_DEMO=true
   FACTIONS_BASE_URL=http://${{factions.RAILWAY_PRIVATE_DOMAIN}}:${{factions.PORT}}
   FACTIONS_ADMIN_TOKEN=${{factions.ADMIN_TOKEN}}
   ```
4. On each service: **Settings → Networking → Generate Domain** (port 8080).

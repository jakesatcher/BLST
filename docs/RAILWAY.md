# Deploying to Railway (BLST + BLPA Factions side by side)

One Railway project runs both apps:

| Service | Repo | Database |
|---|---|---|
| `blst` | jakesatcher/BLST | `Postgres`, schema `public` |
| `factions` | jakesatcher/blpafactions | `Postgres`, schema `factions` |
| `Postgres` | Railway Postgres | one database for both (one bill) |

BLST talks to Factions over Railway's **private network**
(`http://factions.railway.internal:8080`), which is encrypted and never leaves
Railway. Both apps also get their own public web address.

## Option A: one command (Railway CLI)

1. Install the CLI: `npm i -g @railway/cli` (or `brew install railway`), then `railway login`.
2. In Railway, allow the GitHub app to read both repos:
   railway.com → Account → Integrations → GitHub.
3. From this repo:

   ```bash
   scripts/railway-setup.sh
   ```

The script:
- creates a project `blpa`;
- adds Postgres plus the `factions` and `blst` services from GitHub;
- generates `ADMIN_TOKEN` (one per app) and `AUTH_SECRET`;
- wires the variables together and creates both public addresses.

At the end it prints BLST's setup key and the Factions admin token.

Builds take a few minutes. Follow them with `railway logs --service blst` or
`railway logs --service factions`.

Settings you can change with environment variables: `PROJECT_NAME`,
`BLST_BRANCH`, `FACTIONS_BRANCH` (both default to the current development
branch; change them to `main` after merging).

## Option B: the Railway dashboard

1. **New Project → Deploy PostgreSQL.**
2. **+ Create → GitHub Repo → jakesatcher/blpafactions.** Rename the service
   `factions` (Settings → Service name) and set the branch. Variables:
   ```
   PORT=8080
   ADMIN_TOKEN=<openssl rand -hex 24>
   DATABASE_URL=${{Postgres.DATABASE_URL}}?schema=factions
   ```
3. **+ Create → GitHub Repo → jakesatcher/BLST.** Rename it `blst`. Variables:
   ```
   PORT=8080
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ADMIN_TOKEN=<openssl rand -hex 24>
   AUTH_SECRET=<openssl rand -hex 32>
   AUTH_LOG_CODES=true
   SEED_DEMO=true
   FACTIONS_BASE_URL=http://${{factions.RAILWAY_PRIVATE_DOMAIN}}:${{factions.PORT}}
   FACTIONS_ADMIN_TOKEN=${{factions.ADMIN_TOKEN}}
   ```
4. On each service: **Settings → Networking → Generate Domain** (port 8080).

You don't need to set any build, start or migration commands. Each repo has a
`railpack.json` that Railway's builder reads:

| App | Start command | What it does |
|---|---|---|
| BLST | `npm run seed -- --if-enabled --once; npm start` | Loads the demo once if `SEED_DEMO=true`; migrations run when the server boots |
| Factions | `npx prisma migrate deploy && npm run seed && npm start` | Migrates, upserts the six Orders (idempotent), starts. Also installs `openssl` for Prisma |

## After the first deploy

1. Open the `blst` address → **Admin & setup** → **Set up the admin account**.
   Use BLST's `ADMIN_TOKEN` as the setup key. Until email and SMS are set up,
   sign-in codes appear in `railway logs --service blst`.
2. Set up real email and texts, then stop logging codes:
   ```bash
   railway variable set --service blst SMTP_URL='smtps://USER:PASS@smtp.example.com:465' EMAIL_FROM='BLST <no-reply@example.org>'
   railway variable set --service blst TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+15551234567
   railway variable set --service blst AUTH_LOG_CODES=false
   ```
3. Optional: `FACTIONS_AUTO_SYNC=true` on `blst`, LeagueApps variables on
   either app (see each README), and a custom domain under Settings → Networking.

## How the apps know they're on Railway

Both apps treat `RAILWAY_ENVIRONMENT_ID` (set by Railway on every service) as
"deployed", the same way they treat Heroku's `DYNO`. When deployed:
- both refuse to start without `ADMIN_TOKEN`, so neither can come up with its
  admin routes open;
- BLST redirects HTTP to HTTPS and enables HSTS;
- BLST doesn't log sign-in codes unless `AUTH_LOG_CODES=true`.

The database connection doesn't use TLS on Railway's private network, which is
already encrypted. Set `DATABASE_SSL=true` on BLST only if you point it at
Railway's public database proxy instead.

## Separate databases instead

To give Factions its own database:
1. Add a second Postgres.
2. Point Factions' `DATABASE_URL` at it, e.g. `${{Postgres-xyz.DATABASE_URL}}`.
   You can drop the `?schema=factions` part.

Nothing else changes.

## Notes

- Railway's `railway.json` / `railway.toml` ("Config as Code") is deprecated.
  New services can't use it, and Railway stops reading it on 2026-12-01. That's
  why the settings live in `railpack.json` (read by the builder) and in the
  setup script. To manage the whole project as code later, run
  `railway config pull` to create `.railway/railway.ts`.
- Run one instance (replica) of `blst`: live updates fan out in memory.
- Heroku still works (see the README); the two setups don't interfere.

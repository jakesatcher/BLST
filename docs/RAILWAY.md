# Deploying to Railway

BLST, with BLPA Factions built in, runs as one Railway service plus Postgres.
**Nothing secret needs to be configured.** On first start, BLST:
- creates its database tables;
- generates its own secrets;
- switches its everyday queries to a least-privilege database login;
- prints a one-time **setup key** to its log, for creating the first admin.

The same guide and script are in the BLST and blpafactions repos.

Choose one of three ways to deploy:

## 1. Deploy button (one click)

[![Deploy on Railway](https://railway.com/button.svg)](#make-the-button)

Once you've made the template (below), anyone with the link can deploy a
complete copy in one click: Postgres, BLST and a public address.
1. Click the button.
2. Wait for the deploy to finish.
3. Open the service's **Deploy Logs** and copy the `Setup key: setup-…` line.
4. Open the site → **Admin & setup** → **Set up the admin account**.

### Make the button

You need to do this once, from a Railway account. Either:
- run `npm run railway -- --template` (option 2 below, plus a template), or
- build it in the dashboard:
  1. Go to railway.com → **Workspace → Templates → New Template**.
  2. **Add → Database → PostgreSQL.**
  3. **Add → GitHub Repo →**
     `https://github.com/jakesatcher/BLST/tree/claude/great-bardeen-wfd39q`
     (or `…/BLST` once merged to `main`).
  4. Name the service `blst` and add these **Variables**:
     ```
     DATABASE_URL=${{Postgres.DATABASE_URL}}
     PORT=8080
     SEED_DEMO=true
     ```
     Leave out `SEED_DEMO` if new deploys shouldn't get the demo tournament.
  5. **Settings → Networking → Public Networking → HTTP**, port `8080`.
  6. **Create Template**, then copy its URL (`https://railway.com/new/template/XXXX`).

Then replace `#make-the-button` in the button above, and in the README, with
that URL. The template holds no secrets, so it's safe to share.

## 2. One command

1. On railway.com, let Railway's GitHub app read **jakesatcher/BLST**:
   Account → Integrations → GitHub.
2. From either repo, run:
   ```bash
   npm run railway             # or: npm run railway -- --template
   ```
   - You'll be asked to log in to Railway if you aren't already.
   - You don't have to install anything: the script uses the Railway CLI if you
     have it, or runs it through `npx`.

The script:
1. creates the project, the database and the service;
2. waits for BLST to start;
3. prints the setup key.

Open the address it prints → **Admin & setup** → **Set up the admin account**.

## 3. Dashboard, by hand

1. **New Project → Deploy PostgreSQL.**
2. **+ Create → GitHub Repo → jakesatcher/BLST.** Name the service `blst`.
3. Set the variables `DATABASE_URL=${{Postgres.DATABASE_URL}}` and `PORT=8080`.
4. **Settings → Networking → Generate Domain**, port `8080`.
5. Copy the setup key from the **Deploy Logs**.

## After deploying

Sign-in codes are written to the `blst` logs until email and text messages are
set up. That's what lets you create the first admin before then. To send real
codes:

```bash
railway variable set --service blst SMTP_URL='smtps://USER:PASS@smtp.example.com:465' EMAIL_FROM='BLST <no-reply@example.org>'
railway variable set --service blst TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+15551234567
```

Once those are set, codes are sent and never logged. Without the CLI, write
`npx @railway/cli` instead of `railway`, or use the service's **Variables** tab.

Optional:
- LeagueApps variables (see the README), which also import every LeagueApps
  member into their Factions Order;
- a custom domain under Settings → Networking.

Admin → **Security** shows the live security posture. It should be all ✓ once
email and SMS are set up.

## What BLST sets up by itself

| | Without a config var | To set it yourself |
|---|---|---|
| **Setup key** for the first admin | Printed in the log at each start until the first admin exists (one-time; only its hash is stored) | `ADMIN_TOKEN` |
| **Code-signing secret** | Generated on first start, kept in the database | `AUTH_SECRET` |
| **Least-privilege database login** | Created at start as `blst_app` (rows only, no schema changes). Requests run as it; migrations use the owner login. Its password is derived, never stored | `DATABASE_MIGRATION_URL` plus `npm run db:app-role`, which keeps the owner login out of the running app entirely. Opt out with `DB_AUTO_APP_ROLE=false` |
| **Client address** for rate limits | Read from Railway's `X-Real-IP` | `CLIENT_IP_HEADER` |

## Already running the two-app setup?

If you deployed with an earlier version of this script (separate `blst` and
`factions` services), upgrade like this:

1. Redeploy `blst` from the updated branch. It imports the Factions data from
   the shared database once. Look for `Factions import:` in the logs.
2. Delete the `factions` service.
3. In `blst`'s Variables tab, delete `FACTIONS_BASE_URL`, `FACTIONS_ADMIN_TOKEN`
   and `FACTIONS_AUTO_SYNC`.

Your existing `ADMIN_TOKEN` and `AUTH_SECRET` keep working, so leave them.

## Good to know

- **Branch:** the script and button deploy `claude/great-bardeen-wfd39q`. After
  merging, use `BLST_BRANCH=main npm run railway`, or change the branch in the
  service's Settings.
- **Build settings:** none to fill in. `railpack.json` tells Railway's builder
  how to start the app. Railway's older `railway.json` is deprecated, so it
  isn't used.
- **Nothing is ever open by default:** with nothing configured, every change
  needs an admin, and the only way to create the first admin is the setup key
  from the log plus email and text codes.
- **Keep `blst` at one replica:** live scores are shared in memory.

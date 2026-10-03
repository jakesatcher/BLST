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

### Deployed from GitHub and it crashed?

Deploying the repo from GitHub creates only the app, with no database. The
logs then say **No database is connected** (older versions crashed with
`ECONNREFUSED ... 127.0.0.1:5432`). To fix it:

1. In the project, **+ Create → Database → PostgreSQL**.
2. In the app service's **Variables** tab, add
   `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (type it exactly; Railway
   fills in the real value. If your database service isn't called `Postgres`,
   use its name).
3. Railway redeploys. Look for the setup key in the **Deploy Logs**.

Make sure the app and the database are in the same project and environment.

**Still `ECONNREFUSED 127.0.0.1:5432`, or "DATABASE_URL points at localhost"?**
`DATABASE_URL` holds a local-development value, often because Railway's
**Suggested Variables** (read from `.env.example`) were added. In the app
service's **Variables** tab:
- set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}` (not
  `postgresql://blst:blst@localhost...`);
- delete `PORT` if it says `3000` (Railway sets the port itself);
- check the Postgres service is really named `Postgres`; otherwise use its name
  in the reference.

The deploy log prints `Database: <host>:5432/railway` when it's right; the host
ends in `.railway.internal`.

## After deploying

**Sign-in codes are written to the Deploy Logs** until email is set up, so you can create the first admin straight away. In the
service's **Deploy Logs**, look for lines like:

```
[dev email to you@example.com] 123456 is your BLST code
```

Each code works for 10 minutes; asking again sends a new one.

### Real email

**Email: Resend** (recommended on Railway: it sends over HTTPS, and Railway
allows outbound SMTP only on Pro plans and above).
1. Sign up at resend.com and add your domain (e.g. `beerleaguestats.hockey`);
   add the DNS records it shows and wait for it to verify.
2. Create an API key (sending access).
3. Set `RESEND_API_KEY=re_...` and `EMAIL_FROM='Beer League Stats <no-reply@beerleaguestats.hockey>'`
   (the address must be on the verified domain).

On a Pro plan any SMTP service also works: `SMTP_URL='smtps://USER:PASS@smtp.example.com:465'`.

**Second factor:** admins and scorekeepers use an authenticator app or a
passkey, set up in the app the first time they sign in. Nothing to configure.

```bash
railway variable set --service blst RESEND_API_KEY=re_... EMAIL_FROM='Beer League Stats <no-reply@beerleaguestats.hockey>'
```

Without the CLI, write `npx @railway/cli` instead of `railway`, or use the
service's **Variables** tab. Variable changes made in the dashboard are
*staged*: click **Deploy** on the banner at the top of the canvas to apply them.

**Checking it:** each start logs `Email: Resend API, from …` (or `SMTP host:465`)
and every email logs `email sent via … to j•••@…`. If you see neither, the
variables haven't reached the running deployment. A sign-in for an email with no
account sends nothing (on purpose); the log says so with
`[auth] sign-in for …: no account with that email`. On a new install use
**Set up admin**, not **Sign in**. Once email is set up, codes are sent and never
logged. If sending fails, the reason is in the Deploy Logs
(`email send failed: …`). When it works, set `AUTH_LOG_CODES=false`.

Optional:
- LeagueApps variables (see the README), which also import every LeagueApps
  member into their faction (they belong to one organization:
  `LEAGUEAPPS_ORG_ID`, default the first);
- your own domain, with an address per organization (next section).

## Organizations on their own addresses

One `blst` service serves every organization. The bare domain is the platform
(sign up, ask for an organization, approvals) and each organization lives at
`<org>.<domain>`, with `/stats`, `/factions` and `/admin` pages.

1. In the service's **Settings → Networking → Custom Domain**, add
   `beerleaguestats.hockey`, `www.beerleaguestats.hockey` **and**
   `*.beerleaguestats.hockey`.
2. At your DNS provider, add exactly the records Railway shows for each: a
   CNAME for the bare domain (or ALIAS/ANAME/flattened CNAME, which most DNS
   providers offer at the root), a CNAME for `*`, the `_acme-challenge` CNAME
   that lets Railway issue the wildcard certificate, and the TXT verification
   records. If you use Cloudflare, set the records to **DNS only** (grey
   cloud) until the certificates are issued.
3. Set the variable:
   ```bash
   railway variable set --service blst APP_DOMAIN=beerleaguestats.hockey
   ```

Then:
- `https://beerleaguestats.hockey` and `https://www.beerleaguestats.hockey`
  are the landing site: what Beer League Stats is, every live league with a
  link to its address, a "find your league" box, and sign-in to ask for a new
  league. It isn't tied to any league.
- Old links to league pages on the main address
  (`beerleaguestats.hockey/stats`, `/tournament?id=…`) redirect to the same
  page at `blpa.beerleaguestats.hockey`. `LEGACY_ORG` picks a different
  league; an empty value turns the redirect off.
- `https://beerleaguestats.hockey` is also the platform. Sign in there with the
  admin account you set up and open **Platform admin** to approve organizations.
- Your first organization is `blpa`: `https://blpa.beerleaguestats.hockey/stats`.
  Rename it or change its address under Platform admin.
- New organizations ask at the platform; you get an email for each one.
- Railway's own `*.up.railway.app` address shows the platform. Set
  `DEFAULT_ORG=blpa` to make it show an organization instead.

Leave `APP_DOMAIN` unset to run a single league on any address.

Admin → **Security** shows the live security posture. It should be all ✓ once
email is set up and every admin and scorekeeper has an authenticator or passkey.

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
  from the log plus the emailed code, then an authenticator app or passkey.
- **Keep `blst` at one replica:** live scores are shared in memory.
- **Sign-in is per address:** browsers keep the sign-in for each organization's
  address separately, so people sign in on each one they use.

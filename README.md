# BLST: BLPA Live Scoring & Stats

BLST handles live scoring and stat tracking for BLPA hockey tournaments. Scorekeepers run the clock and log events from a rinkside screen. Anyone with the URL can watch scores, standings and stats update in real time. Stats can be exported to other apps, and results can be pushed to the **BLPA Factions (ODS)** app.

- **Stack:** Node 22, Express 5 and Postgres, with a plain HTML/JS front end and no build step. It deploys to Heroku the same way BLPA Factions does.
- **Real time:** viewers receive updates over Server-Sent Events. The clock ticks locally in each browser from the server's state, so the server doesn't push anything every second.
- **Stats are never stored as totals.** Every number is recomputed from the game's event log. Editing or voiding an event corrects every box score, standing, leaderboard and export on the next read.

## Pages

| Page | Who | What |
|---|---|---|
| `/` | Public | Live and upcoming games, list of tournaments |
| `/factions.html` | Public | BLPA Factions: Order standings, standings by event, top members |
| `/tournament.html?id=N` | Public | Scores, standings, leaders, skater and goalie stats, rosters, Factions standings when the tournament counts for Factions |
| `/game.html?id=N` | Public | Live scoreboard (clock, score, shots on goal, power play, penalty-box countdowns), scoring summary, box score, lineups, play-by-play |
| `/player.html?id=N` | Public | Career stats: imported history plus every BLST tournament |
| `/account.html` | Anyone | Create an account or sign in (emailed code + texted code), change mobile number, sign out everywhere, delete account. First visit: set up the global admin |
| `/scorekeeper.html` | Scorekeeper account or key | Clock and periods (Space starts/stops the clock), tap-a-number event entry, goalie pulls, lineup changes, edit/void/restore events |
| `/admin.html` | Admin account | Accounts and access, BLPA Factions (members, points, achievements, events, bulk upload), tournaments and team count, teams, rosters and jersey numbers, moving players between teams, schedule and round-robin generator, roster and historical imports, API keys, webhooks |
| `/api.html` | Anyone | API reference |

## What's tracked

**Skaters:** GP, G, A, PTS, +/-, PIM, PPG, PPA, SHG, SHA, GWG, ENG, SOG, S%, missed shots, hits, blocks, faceoffs won/lost and FO%, giveaways, takeaways, penalties drawn.

**Goalies:** GP, TOI, SA, GA, SV, SV%, GAA (per 60 minutes), W/L/OTL/T, SO, PIM.

**Teams:** W/L/OTL/T, PTS, GF/GA/DIFF, PIM, streak, PP goals and opportunities.

How the stats are decided:
- **Strength** (EV/PP/SH) is worked out automatically by replaying penalties. That replay caps a team at two skaters short and queues a third penalty until one ends. A power-play goal releases a minor early, or ends the current half of a double minor. Coincidental penalties don't change strength. The scorekeeper can override the strength on any goal.
- **Game-winning goal and goalie decisions** follow NHL rules. The win and loss go to the goalies in net when the deciding goal was scored. Shootout wins have no GWG.
- **Empty-net goals** don't count against a goalie. Goalie TOI comes from goalie-change events, so pulling the goalie and putting them back in works as expected.
- **+/-** is counted only when the scorekeeper records who was on the ice (optional on each goal). Power-play goals and penalty shots don't count toward it.
- **Moving a player** between teams is logged. Games already played keep their own lineup snapshot, so earlier stats stay with the old team, and the player's line shows a split by team.

## Running locally

```bash
npm install
cp .env.example .env          # set DATABASE_URL (and ADMIN_TOKEN if you want auth locally)
npm run migrate
npm run seed                  # optional demo tournament: 4 teams, 2 final games, 1 live
npm run dev                   # http://localhost:3000
```

Without email and SMS providers, a local server prints sign-in codes in its log (`[dev email to …]`, `[dev sms to …]`), so you can create accounts without sending anything.

If `ADMIN_TOKEN` is unset and no admin account exists, BLST **fails closed**: nothing can be changed. For quick local experiments, set `ALLOW_OPEN_DEV=true` to allow changes without a key. That flag is ignored when deployed, and a deployed server refuses to start without a strong `ADMIN_TOKEN` (16 or more characters).

### Tests

```bash
createdb blst_test            # once; override with TEST_DATABASE_URL
npm test
```

The suite covers the stat engine (penalty replay, PP/SH, GWG, goalie decisions, OT and shootout, standings) and a full API run-through. That run-through covers auth, the team-count selector, roster import, a live game, roster moves, historical import, exports, signed webhooks, SSE and Factions points. `test/factions.test.js` covers Order assignment (checked against the standalone formula), permanence, membership, awards, bulk upload, privacy and the import from a standalone Factions database.

## Deploying to Railway

One command creates Postgres and the app, with BLPA Factions built in. You can
run it from this repo or the blpafactions repo:

```bash
npm run railway
```

Let Railway's GitHub app read this repo first. **[docs/RAILWAY.md](docs/RAILWAY.md)**
has the details, including the upgrade from the earlier two-app setup.

## Deploying to Heroku (for testing)

### One click

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://www.heroku.com/deploy?template=https://github.com/jakesatcher/BLST/tree/claude/great-bardeen-wfd39q)

The button reads [`app.json`](app.json) and:
- creates the app with a Heroku Postgres database (`essential-0`, about $5/month);
- generates a random **setup key** (`ADMIN_TOKEN`) and `AUTH_SECRET`;
- runs database migrations in the release phase;
- loads a **demo tournament** on first deploy (`SEED_DEMO=true`) so there's something to click around in. Delete it any time from Admin → Settings.

The button uses this branch. After the branch is merged, change the URL's `tree/...` part to `tree/main`.

**First sign-in after deploy:** open the app → **Admin & setup**. It asks you to **set up the admin account**:
1. Enter the setup key: Heroku dashboard → your app → **Settings → Reveal Config Vars** → `ADMIN_TOKEN` (or `heroku config:get ADMIN_TOKEN -a <app>`), plus your email and mobile number.
2. Enter the code that was emailed to you, then the code texted to your phone.

That makes you the **global admin**. From then on `ADMIN_TOKEN` no longer works as a password: every admin signs in with an emailed code **and** a texted code.

**Email and text messages.** Set `SMTP_URL` and `EMAIL_FROM` (any SMTP service: Postmark, SendGrid, Mailgun, Amazon SES) and the Twilio vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`). Until they're set, the Deploy button's `AUTH_LOG_CODES=true` prints codes in the Heroku log (`heroku logs --tail`) so you can test. Set `AUTH_LOG_CODES=false` once real sending works.

### From the command line

```bash
heroku create blst-test
heroku addons:create heroku-postgresql:essential-0
heroku config:set ADMIN_TOKEN="$(openssl rand -hex 24)" AUTH_SECRET="$(openssl rand -hex 32)"
heroku config:set SMTP_URL="smtps://USER:PASS@smtp.example.com:465" EMAIL_FROM="BLST <no-reply@example.org>"
heroku config:set TWILIO_ACCOUNT_SID="AC..." TWILIO_AUTH_TOKEN="..." TWILIO_FROM_NUMBER="+15551234567"
git push heroku claude/great-bardeen-wfd39q:main
heroku run npm run seed          # optional demo tournament
heroku open
```

The `Procfile` runs migrations in the release phase. TLS to Heroku Postgres is turned on automatically, and the app refuses to boot on Heroku without `ADMIN_TOKEN` until an admin account exists. Run **one web dyno**: live updates fan out in memory. Before scaling out, move the event bus in `src/lib/bus.js` to Postgres LISTEN/NOTIFY.

## Accounts and sign-in

Everyone signs in the same way, with **two one-time codes**: one emailed to them, then one texted to their phone. There are no passwords. BLST stores only each account's **email address and mobile number** (plus its access level).

- **Standard users** create their own account at `/account.html` (**Create account**). A standard account has no staff access.
- **Admins** give people access under **Admin → Accounts**: *Scorekeeper* (optionally limited to one tournament) or *Global admin*. Changing someone's access signs them out everywhere so it applies immediately. You can also disable, sign out or delete accounts. The last admin can't be removed.
- **Sessions:** admins stay signed in for 12 hours, scorekeepers 24 hours, standard users 30 days. Anyone can **sign out everywhere** or **delete their account** from `/account.html`.
- **Lost phone (admin):** another admin can update access, or the account holder can sign in and change their number (that needs the emailed code and a code to the new number). If the only admin loses their phone, set `ADMIN_TOKEN_BREAK_GLASS=true`, sign in with `ADMIN_TOKEN` under Admin → *Use an API key instead*, fix things, then remove the flag.
- **API keys** are still there for machines and shared rink iPads (Admin → API keys).

## Team logos

Admin → Tournaments → **Teams & rosters**. Tap the logo box on a team's card, then choose an image from Photos or Files. You can also drag a file onto the box on a computer.
- **Formats:** PNG, JPG, SVG or WebP. Square images look best. Big photos are shrunk to 512px on the device before upload.
- **Where logos appear:** live scoreboards, game cards, standings, rosters, the scorekeeper screen and the draft preview.
- **Tournament logo:** set it under **Settings**. It appears on the home page and the tournament page.
- **Storage:** logos are kept in the database, so they survive Heroku restarts.
- **Other apps:** can embed them via `logo_url` in the export API.

## Uploading rosters after the draft

Admin → Tournaments → **Draft / roster upload**:
1. **Download template.** The template already has your team names: one blank line per team. **Download current rosters** gives the same format with everyone already on a team, ready to edit.
2. **Fill it in** in Google Sheets, Excel or Numbers. Use one line per player: `team, number, first_name, last_name, position, role (C/A), email, round, pick`. Then export as CSV.
   - Your own draft sheet works too. Headers like `Drafted By`, `Player`, `Jersey #`, `Pos`, `Captain`, `Round`, `Pick` are recognized.
   - Semicolon- or tab-separated files are fine.
   - See [`examples/draft-results-example.csv`](examples/draft-results-example.csv).
3. **Choose the CSV file** (on iPad this opens Files).
   - BLST checks the file and shows a **preview, team by team**. It flags new players, players changing teams, and players coming off a roster, and lists any problems with line numbers (for example two players given #9 on the same team). Nothing is saved yet.
   - Tick **Replace current rosters with this file** for the final draft results. Anyone not in the file comes off their team. If the file has any problems, nobody is removed.
4. Press **Import**.
   - Swapped numbers are fine: one player can take another's old number in the same upload.
   - Players whose team changed are logged under **Moves**.
   - Games already played keep their original lineups.

## Registrations and LeagueApps

Every player who registers for a tournament gets a **registration code** for that tournament, such as `FC26-0042`. The prefix comes from the tournament's initials and year and can be changed. Every person also has one permanent **player code** (`BLP-000123`) that follows them across tournaments.

**Returning players are recognized automatically.** Each new registration is checked against existing players in this order:
1. **LeagueApps user ID.**
2. **Email**, but only when the first name also matches. Parents often register several kids under one email, so siblings are never merged on email alone.
3. **Name + birth date.**
4. **Name only:** linked, but flagged for review. If several players share the name, a new player is created and flagged, with the possible duplicates listed.

A matched registration links to the player's existing record, so their imported history and earlier tournaments carry over to career stats. The registration list marks them **Returning** (other events, imported games played). Duplicates are fixed with **Merge…**, which moves rosters, stats, history and registrations onto one record and keeps the registration codes.

**Admin & setup → Tournaments → Registrations** has:
- **LeagueApps:** run **Sync now**, then tick which LeagueApps program(s) feed this tournament. Programs appear after the first sync. Registrations from other programs are skipped, and cancellations come through as *cancelled*. **Check field mapping** shows the real field names in your LeagueApps data, and lets you override one if needed.
- **Walk-up registration** and **CSV import** of the LeagueApps Registrations Report, for when API keys aren't set up yet. Both use the same codes and matching.
- **Look up a code:** registration or player code → the person, their tournaments, teams and imported history. Scorekeepers get the same lookup as **Check-in** on the scorekeeper screen, without email or birth date.
- **Download draft sheet:** the draft template pre-filled with every registered, undrafted player and their code. A `registration_code` column on the roster upload is the most reliable way to identify a player, and players left without a team are listed instead of failing the upload.

**LeagueApps setup.** Get a **Private API key** in LeagueApps: Admin Dashboard → Connect → API Settings. Convert the `.p12` file it gives you:
```bash
openssl pkcs12 -nodes -legacy -in <client-id>.p12 -out <client-id>.pem
```
Then set `LEAGUEAPPS_SITE_ID`, `LEAGUEAPPS_CLIENT_ID` and `LEAGUEAPPS_PRIVATE_KEY` (the PEM contents). It's the same key setup as BLPA Factions. To sync on a schedule, either:
- set `LEAGUEAPPS_SYNC_INTERVAL_MIN`, or
- add Heroku Scheduler running `npm run sync:leagueapps`.

The sync is incremental and safe to repeat.

> The sign-in and export calls follow LeagueApps' official sample (`registrations-2`, `last-updated`/`last-id` paging, JWT sign-in). LeagueApps doesn't publish the registration record's field names, so use **Check field mapping** once with your real account before the first tournament.

## Live video with a score overlay (LiveBarn)

Every game has a **▶ Watch** page (`/watch.html?game=N`) that shows the video with a broadcast-style score overlay drawn on top.
- **What the overlay shows:** team logos and score, period and clock, a power-play countdown, empty net, and shots.
- **Animated banners** for goals (scorer and assists), penalties and the final score.

Set it up under **Admin & setup → Tournaments → Streams**:
- **LiveBarn link** for each rink's camera. LiveBarn has no public API or embeddable player, and its video needs each viewer's own subscription. So for LiveBarn rinks the Watch page offers:
  - **Watch on LiveBarn**, which opens the rink in LiveBarn;
  - **Pop out scorebug**, a small always-on-top live score window. It floats above other windows in Chrome/Edge and opens as a normal popup in other browsers;
  - on **iPad**, the LiveBarn app full screen with the BLST scorebug in Split View or Slide Over (`/overlay.html?game=N&pos=fill&bg=dark`).
- **Video embed (optional).** If you have a player link that can be embedded, paste it here and the video plays right on BLST with the overlay on top. That could be a LiveBarn partner/embed link for the tournament, YouTube Live from your own camera, or an `.m3u8`/`.mp4` stream. **Check** tells you whether the site allows embedding. Normal LiveBarn pages don't.
- **Stream delay.** Video runs behind live scoring, about 15–30s on LiveBarn. The overlay holds every update back by this many seconds so it never spoils a goal. Viewers fine-tune it with ±1s/±5s, or tap **⚡ Sync to last goal** at the moment they see the goal on the video.
- **Per-game overrides** (a different stream for one game) are under **Schedule → Edit**.

**Broadcast overlay:** `/overlay.html?game=N` is a transparent 1920×1080 page for OBS or other streaming software (Browser Source). You can add these to the link:

| Add to the link | Options |
|---|---|
| `&pos=` | `bl`, `br`, `tl`, `tr`, `top`, `bottom` |
| `&size=` | `s`, `m`, `l` |
| `&delay=` | seconds |
| `&bg=green` | chroma-key background |
| `&shots=0`, `&pens=0`, `&anim=0` | turn off shots, penalty banners, animations |

Re-broadcasting LiveBarn video needs LiveBarn's permission. The overlay is meant for your own camera or a licensed feed.

## Using it on an iPad

1. Open the app in Safari. Tap **Share → Add to Home Screen**. BLST then opens full-screen like an app, with its own icon.
2. **Admin:** sign in with the admin password, then follow the **Getting started** checklist. It walks you through naming teams, adding players (or importing a roster CSV), scheduling games and creating scorekeeper keys.
3. **Scorekeeper:** on the rink iPad, sign in with a *scorekeeper* key and tap a game.
   - The score and clock bar stays pinned at the top while you scroll.
   - Tap **▶ Start clock / ■ Stop clock**.
   - For a goal, tap **Goal**, then tap the scorer → first assist → second assist by jersey number. Time is captured when you tap and can be edited.
   - **↶ Undo last** voids the most recent entry. Restore it from the event log if needed.
4. Works in portrait and landscape.
   - The screen stays awake while a game is open.
   - A **● Live / Reconnecting…** indicator shows whether the rink Wi-Fi connection is up.
   - Every confirmation and edit opens a touch-sized sheet, not a browser pop-up.
5. Phones get the same public pages with a compact scoreboard. Share the game or tournament link with parents and fans.

## Game-day workflow

1. **Admin → New tournament.** Pick the number of teams (you can change it later), period and OT lengths, and points per result.
2. **Teams & rosters.** Rename teams, set colors, and add players with jersey numbers. Or use **Roster import** with a CSV of `first_name,last_name,number,position,team,email`.
3. **Schedule.** Add games one at a time or generate a round robin.
4. **Scorekeepers.** Have each scorekeeper create an account, then give them *Scorekeeper* access under **Admin → Accounts**. For a shared rink iPad, create a *scorekeeper* API key limited to the tournament instead.
5. **Scorekeeper.** Pick the game and press **Start game**, which snapshots the lineups and sets the starting goalies. Press Space to start and stop the clock. Tap **Goal**, then tap scorer → A1 → A2 by jersey number. Time is captured when you tap and can be edited.
6. **Factions.** On the tournament's **Factions** tab, choose **Count this tournament for Factions**. Points update as games go final. After playoffs, set each team's **Final place** so the title bonus applies.

## Security

BLST follows the OWASP Top 10 (2021) and OWASP API Security Top 10 (2023). See **[SECURITY.md](SECURITY.md)** for the control-by-control mapping, the operator checklist and residual risks. In short:
- **Accounts:** MFA for every sign-in (emailed code + texted code); short admin sessions; only email and phone stored.
- **Keys:** scoped, expiring API keys; brute-force lockout.
- **Limits:** rate and size limits.
- **Network:** SSRF protection for webhooks and link checks.
- **Browser:** strict security headers and CSP, with no third-party scripts.
- **Audit log:** every change and every denied request, viewable under **Admin → Security**.

CI runs the full test suite (including `test/security.test.js`) and `npm audit` on every push.

## API

Base path `/api/v1`. Reads are public, and writes need `Authorization: Bearer <key>` (an API key, or the session token from signing in). The full reference is at [`/api.html`](public/api.html). Main groups:

- **Live data:** `/tournaments/:id/{games,standings,leaders,stats/skaters,stats/goalies,teams}`, `/games/:id` (full live snapshot), `/stream?game_id=` or `?tournament_id=` (SSE).
- **Export API:** `/export/tournaments/:id`, `/export/tournaments/:id/{skaters,goalies,standings,games}`, `/export/games/:id`, `/export/players/:id`, `/export/players`. JSON by default; add `?format=csv` for CSV. Every payload carries a `schema_version`.
- **Webhooks:** signed JSON POSTs for `game.final`, `game.event.created`, `roster.moved` and other events. See `/api.html#webhooks`.
- **Import:** `/import/historical`, `/import/roster/:tournamentId`. CSV or JSON, with `dry_run` and per-row errors.

Emails and Factions player IDs (a reversible encoding of the email) are only ever returned to admins. They never appear in public pages, exports or webhooks.

## BLPA Factions

BLPA Factions (the Original Draft Society) is built in; it used to be a separate app.
- **Membership:** every player with an email belongs to one of six Orders for
  life, assigned from their email.
- **Points:** tournaments that count for Factions earn points for each player's
  Order automatically as games go final.
- **Admin:** admins award bonus points and achievements, record other events,
  and bulk-upload members.
- **Public:** fans follow the standings on the **Factions** page, the home
  page, tournament pages and player pages.

See **[docs/FACTIONS.md](docs/FACTIONS.md)** for the rules, the API and moving
data over from the standalone app (automatic for the earlier Railway setup).

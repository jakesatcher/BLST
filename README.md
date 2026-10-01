# BLST: BLPA Live Scoring & Stats

BLST handles live scoring and stat tracking for BLPA hockey tournaments. Scorekeepers run the clock and log events from a rinkside screen. Anyone with the URL can watch scores, standings and stats update in real time. Stats can be exported to other apps, and results can be pushed to the **BLPA Factions (ODS)** app.

- **Stack:** Node 22, Express 5 and Postgres, with a plain HTML/JS front end and no build step. It deploys to Heroku the same way BLPA Factions does.
- **Real time:** viewers receive updates over Server-Sent Events. The clock ticks locally in each browser from the server's state, so the server doesn't push anything every second.
- **Stats are never stored as totals.** Every number is recomputed from the game's event log. Editing or voiding an event corrects every box score, standing, leaderboard and export on the next read.

## Pages

| Page | Who | What |
|---|---|---|
| `/` | Public | Live and upcoming games, list of tournaments |
| `/tournament.html?id=N` | Public | Scores, standings, leaders, skater and goalie stats, rosters, Order standings when linked to Factions |
| `/game.html?id=N` | Public | Live scoreboard (clock, score, shots on goal, power play, penalty-box countdowns), scoring summary, box score, lineups, play-by-play |
| `/player.html?id=N` | Public | Career stats: imported history plus every BLST tournament |
| `/scorekeeper.html` | Scorekeeper key | Clock and periods (Space starts/stops the clock), tap-a-number event entry, goalie pulls, lineup changes, edit/void/restore events |
| `/admin.html` | Admin | Tournaments and team count, teams, rosters and jersey numbers, moving players between teams, schedule and round-robin generator, roster and historical imports, API keys, webhooks, Factions sync |
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

If `ADMIN_TOKEN` is unset, every write is open. That's for local development only, and the server refuses to boot on Heroku that way (same rule as BLPA Factions).

### Tests

```bash
createdb blst_test            # once; override with TEST_DATABASE_URL
npm test
```

The suite covers the stat engine (penalty replay, PP/SH, GWG, goalie decisions, OT and shootout, standings) and a full API run-through. That run-through covers auth, the team-count selector, roster import, a live game, roster moves, historical import, exports, signed webhooks, SSE, and Factions sync against a mock that matches the real Factions endpoints.

## Deploying to Heroku (for testing)

### One click

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://www.heroku.com/deploy?template=https://github.com/jakesatcher/BLST/tree/claude/great-bardeen-wfd39q)

The button reads [`app.json`](app.json) and:
- creates the app with a Heroku Postgres database (`essential-0`, about $5/month);
- generates a random **admin password** (`ADMIN_TOKEN`);
- runs database migrations in the release phase;
- loads a **demo tournament** on first deploy (`SEED_DEMO=true`) so there's something to click around in. Delete it any time from Admin → Settings.

The button uses this branch. After the branch is merged, change the URL's `tree/...` part to `tree/main`.

**Signing in after deploy:** open the app → **Admin**. For the password, go to the Heroku dashboard → your app → **Settings → Reveal Config Vars** and copy `ADMIN_TOKEN`. Or run `heroku config:get ADMIN_TOKEN -a <app>`.

### From the command line

```bash
heroku create blst-test
heroku addons:create heroku-postgresql:essential-0
heroku config:set ADMIN_TOKEN="$(openssl rand -hex 24)"
# optional BLPA Factions link, see docs/FACTIONS.md
heroku config:set FACTIONS_BASE_URL="https://your-factions-app.herokuapp.com" FACTIONS_ADMIN_TOKEN="..." FACTIONS_AUTO_SYNC=true
git push heroku claude/great-bardeen-wfd39q:main
heroku run npm run seed          # optional demo tournament
heroku open
```

The `Procfile` runs migrations in the release phase. TLS to Heroku Postgres is turned on automatically, and the app refuses to boot on Heroku without `ADMIN_TOKEN`. Run **one web dyno**: live updates fan out in memory. Before scaling out, move the event bus in `src/lib/bus.js` to Postgres LISTEN/NOTIFY.

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
4. **API keys.** Create a *scorekeeper* key for each rink device.
5. **Scorekeeper.** Pick the game and press **Start game**, which snapshots the lineups and sets the starting goalies. Press Space to start and stop the clock. Tap **Goal**, then tap scorer → A1 → A2 by jersey number. Time is captured when you tap and can be edited.
6. **After playoffs.** Set each team's **Final place**, then use **Factions sync → Push**, or turn on auto-push.

## API

Base path `/api/v1`. Reads are public, and writes need `Authorization: Bearer <key>`. The full reference is at [`/api.html`](public/api.html). Main groups:

- **Live data:** `/tournaments/:id/{games,standings,leaders,stats/skaters,stats/goalies,teams}`, `/games/:id` (full live snapshot), `/stream?game_id=` or `?tournament_id=` (SSE).
- **Export API:** `/export/tournaments/:id`, `/export/tournaments/:id/{skaters,goalies,standings,games}`, `/export/games/:id`, `/export/players/:id`, `/export/players`. JSON by default; add `?format=csv` for CSV. Every payload carries a `schema_version`.
- **Webhooks:** signed JSON POSTs for `game.final`, `game.event.created`, `roster.moved` and other events. See `/api.html#webhooks`.
- **Import:** `/import/historical`, `/import/roster/:tournamentId`. CSV or JSON, with `dry_run` and per-row errors.

Emails and Factions player IDs (a reversible encoding of the email) are only ever returned to admins. They never appear in public pages, exports or webhooks.

## BLPA Factions

See [docs/FACTIONS.md](docs/FACTIONS.md). In short: a tournament becomes a Factions **Event**, players are registered by **email**, and each player's tournament result becomes an idempotent **EventParticipation** (`pointsEarned` from a points formula you can configure, `placement` from the final standings). Hat tricks, shutouts and championships are sent as **Achievements**.

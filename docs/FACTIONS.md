# Factions

Factions is an optional feature of Beer League Stats. Each organization turns
it on or off and designs its own factions; when it's on, its players compete
for their faction as well as their team. It started as BLPA Factions (the
Original Draft Society), a separate app (github.com/jakesatcher/blpafactions);
see "Moving from the standalone app" below.

## Turning it on

**Admin → Organization → Factions**:
- tick **On** (off hides the Factions page, menu item, badges and points for
  everyone; nothing is deleted);
- add factions (name, emoji, colour, up to 24), or start from a ready-made set:
  **BLPA Orders** (the six below) or **Four colours**;
- rename and recolour them any time. Once people are in factions they can't
  be removed, because everyone's faction is permanent.

Players with an email join a faction as soon as factions exist and it's on.

## The rules

- **BLPA's six Orders:** Varghona 🐺, Tuskarium 🐘, Aetherwing 🦅, Serikon 🐍, Thalkara 🦑 and Ursonne 🐻. Other organizations have their own.
- **Membership is automatic.** Anyone with an email is a member, and their
  Order is assigned the first time BLST sees that email. That happens through
  any of these:
  - a roster upload or registration;
  - the LeagueApps sync;
  - adding a player with an email;
  - an admin adding the person by hand;
  - a bulk upload.
- **An Order is for life.** It's computed from the email:
  1. take the SHA-256 of the trimmed, lowercased email;
  2. read the first 4 bytes as an unsigned big-endian integer;
  3. take that mod the number of factions;
  4. use the result as a position in the organization's list.

  It is never recalculated, and the database itself refuses any change to a
  member's Order or email.
- **Member id:** the base64url of the email, so it can be turned back into
  the email. It's treated like the email: admins only, and never logged.
- The formulas match the standalone app exactly, so ids and Orders carry over.

## Points

An Order's total is the sum of its members' points. Each member's total is:
- **Event points:** one entry per event. Tournaments that count for Factions
  create these automatically.
- **Bonus points:** manual awards, which can be negative.

**Tournament points** are per player, using the tournament's point values (the
defaults are shown; change them per tournament):

| | |
|---|---|
| game played | 1 |
| goal | 2 |
| assist | 1 |
| win | 1 |
| shutout | 3 |
| hat trick | 2 |
| champion | 5 |
| runner-up | 3 |

Hat tricks, shutouts and titles also become **achievements**. A title comes from
a team's final place, or from the standings until final places are set.

Points update by themselves **every time a game goes final** in a tournament
that counts. To turn that off, set `FACTIONS_AUTO_AWARD=false`, then use
**Recalculate & award now** instead.

Awarding is idempotent. Re-running it after a stat correction replaces that
tournament's points and withdraws achievements that are no longer earned, so
nothing is counted twice.

## Where things are

**Public:**
- **Factions** page (`/factions`): faction standings, standings by event,
  and top members.
Factions is kept apart from stats: scores, standings, rosters and player pages show no faction data.

Public pages show names and totals only, never emails.

**Admin:**
- **Admin → Organization:** on/off and the faction designer.
- **Admin → Factions:**
  - **Overview:** standings, plus the LeagueApps member import;
  - **Members:** search, add, bonus points, achievements;
  - **Events:** events that aren't tournaments, and recording participation by hand;
  - **Bulk upload:** a CSV with an email column and optional name; preview first.
- **Admin → Factions → Points from games** (pick a tournament or league division):
  - *Count this tournament for Factions*;
  - point values;
  - a preview of points per player;
  - *Recalculate & award now*.

## API

Every Factions route answers 404 while the organization has Factions off.

**Public:**
- `GET /factions/definitions`: the organization's factions (slug, name, emoji, colour).
- `GET /api/v1/factions`: faction totals, events and leaders in one call.
- `GET /factions/orders`, `GET /factions/events`, `GET /factions/events/:id/totals`, `GET /factions/leaders?order=`.
- `GET /tournaments/:id/factions/order-totals`.

**Admin:**
- Setup: `GET /factions-setup`; `PUT /factions-setup {enabled}`; `POST /factions-setup/factions {name, emoji, color}` or `{preset: "orders" | "colors"}`; `PATCH`/`DELETE /factions-setup/factions/:slug`.
- Members: `GET /factions/members?q=&order=`; `POST /factions/members {email, display_name}` (find or create); `POST /factions/members/find {email}`; `GET /factions/members/:id`; `POST /factions/members/:id/points {points}`; `POST /factions/members/:id/achievements {code, title, event_id?}`.
- Bulk upload: `POST /factions/members/import {csv, dry_run}` (or a `text/csv` body).
- Events: `POST /factions/events`; `GET /factions/events/:id`; `POST /factions/events/:id/participation {member_id | email, points_earned, placement}`.
- Tournaments: `POST`/`DELETE /tournaments/:id/factions/link`; `GET /tournaments/:id/factions/preview`; `POST /tournaments/:id/factions/award`.
- LeagueApps: `POST /integrations/leagueapps/members/sync` (also runs with the scheduled sync and `npm run sync:leagueapps`).

## Moving from the standalone app

The import copies:
- members, with their original Orders;
- bonus points;
- events, keeping their ids, so tournaments already linked stay linked;
- participation and achievements.

It's safe to run again. If BLST had already given someone an Order, the
standalone app's Order wins and the report lists any such cases. There should be
none, since both apps use the same formula.

**Deployed with BLST's earlier side-by-side Railway setup?** Nothing to do. The
standalone app kept its tables in the `factions` schema of the shared database,
and BLST imports them by itself, once, the first time it starts after this
update (look for `Factions import:` in the logs). Set `FACTIONS_AUTO_IMPORT=false`
to skip that.

**Anywhere else:** run the import with the old database's URL, from any machine
that can reach it:

```bash
npm run factions:import -- "postgresql://user:pass@host:5432/db?sslmode=require"
```

`DATABASE_URL` must point at BLST's database.

**Afterwards:**
1. Delete the old `factions` service or app.
2. Delete BLST's `FACTIONS_BASE_URL`, `FACTIONS_ADMIN_TOKEN` and `FACTIONS_AUTO_SYNC`
   variables. They aren't used any more.

One deliberate difference: the standalone app's all-time Order totals counted
only manual points. Here, event points count too, so tournaments show up in the
all-time standings.

# BLPA Factions integration

BLST talks to the BLPA Factions (Original Draft Society) API using only endpoints that exist in `jakesatcher/blpafactions`. No changes to Factions are required.

## Setup

| Env var | Value |
|---|---|
| `FACTIONS_BASE_URL` | Your deployed Factions app, e.g. `https://blpa-ods.herokuapp.com` |
| `FACTIONS_ADMIN_TOKEN` | The Factions app's `ADMIN_TOKEN`, sent as `x-admin-token` |
| `FACTIONS_AUTO_SYNC` | `true` to push results automatically whenever a game in a linked tournament goes final or is reopened |

Admin → **BLPA Factions** shows whether Factions is configured and reachable, plus recent sync activity.

## Mapping

| BLST | Factions call | Notes |
|---|---|---|
| Tournament | `POST /events {name, startDate, endDate}` | You can also link an existing event ID. The ID is stored in `tournaments.factions_event_id`. |
| Player (with email) | `POST /players {email, displayName}` | Factions derives the player ID and Order from the email. BLST stores the returned `id` (private) and `orderSlug` (shown publicly). Players with no email are skipped. |
| Player's tournament | `POST /events/:eventId/participation {playerId, pointsEarned, placement}` | An **upsert**, so pushing again after a stat correction replaces the old value rather than adding to it. |
| Hat trick / shutout / champion | `POST /players/:playerId/achievements {code, title, eventId}` | Codes are stable (`blst:t<tid>:g<gid>:hat-trick`, `blst:t<tid>:g<gid>:shutout`, `blst:t<tid>:champion`), so re-sending is a no-op. |
| Order standings tab | `GET /events/:eventId/order-totals` | Proxied at the public `GET /api/v1/tournaments/:id/factions/order-totals`. |

BLST never calls `POST /players/:id/points`. That endpoint increments a running total, so a retried or corrected push would double count. Tournament points go through the participation upsert instead.

## Points formula

Each player's `pointsEarned` is:

```
game_played × GP + goal × G + assist × A + win × (wins while dressed)
+ shutout × SO + hat_trick × (hat tricks) + champion (if placement 1) or runner_up (if placement 2)
```

The defaults are `1 / 2 / 1 / 1 / 3 / 2 / 5 / 3`. You can change them per tournament under Tournaments → Factions sync, or with `PATCH /tournaments/:id {"factions_points": {...}}`. **Placement** is the team's *Final place* when you've set it (after playoffs). Otherwise it's the team's rank in the standings.

Only final games count toward points. **Preview** shows every player's computed line before anything is sent.

## Workflow

1. Link the tournament (Create event in Factions, or Link existing).
2. Sync players. Make sure the roster has emails; roster import accepts an `email` column.
3. Play games. With auto-sync on, results push after every final. Otherwise use **Push to Factions** whenever you like, as often as you like.

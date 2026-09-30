const { absSec } = require("./clock");

const DURATION_SEC = {
  minor: 120,
  bench_minor: 120,
  double_minor: 240,
  major: 300,
  match: 300,
  misconduct: 600,
  game_misconduct: 0,
};

// Penalties that put a team shorthanded. Misconducts remove the player but
// not a skater from the ice.
const STRENGTH_AFFECTING = new Set(["minor", "bench_minor", "double_minor", "major", "match"]);
const RELEASABLE = new Set(["minor", "bench_minor", "double_minor"]);
const MAX_SHORTHANDED = 2;

function penaltyDurationSec(e) {
  if (e.penalty_severity && DURATION_SEC[e.penalty_severity] !== undefined) return DURATION_SEC[e.penalty_severity];
  return (e.penalty_minutes || 0) * 60;
}

function byTime(a, b) {
  return a.at - b.at || a.e.id - b.e.id;
}

/**
 * Replays penalties and goals in game-time order to work out when each
 * penalty actually started and ended. Handles:
 *   - a team never being more than two skaters short (a third penalty
 *     queues and starts when the first one ends),
 *   - a power-play goal releasing the opponent's earliest-expiring minor
 *     (or ending the current half of a double minor),
 *   - coincidental penalties and misconducts, which run on the penalty
 *     clock but don't change strength.
 *
 * Returns effective start/end per penalty, the strength each goal was
 * scored at, and the penalties still running at `untilAbs`.
 */
function simulatePenalties(t, homeId, awayId, events, untilAbs = Infinity) {
  const other = { [homeId]: awayId, [awayId]: homeId };
  const teams = { [homeId]: { running: [], queued: [] }, [awayId]: { running: [], queued: [] } };
  const all = [];
  const goalStrength = {};

  const items = events
    .filter((e) => !e.voided && (e.type === "penalty" || e.type === "goal"))
    .map((e) => ({ e, at: absSec(t, e.period, e.elapsed_sec) }))
    .filter((i) => i.at <= untilAbs)
    .sort(byTime);

  function startQueued(teamId, at) {
    const team = teams[teamId];
    while (team.running.length < MAX_SHORTHANDED && team.queued.length) {
      const p = team.queued.shift();
      p.start = at;
      p.end = at + p.duration;
      p.queued = false;
      team.running.push(p);
    }
  }

  function expire(teamId, p, at) {
    p.end = at;
    teams[teamId].running = teams[teamId].running.filter((x) => x !== p);
    startQueued(teamId, at);
  }

  function advance(to) {
    for (;;) {
      let next = null;
      let nextTeam = null;
      for (const teamId of [homeId, awayId]) {
        for (const p of teams[teamId].running) {
          if (p.end <= to && (!next || p.end < next.end)) {
            next = p;
            nextTeam = teamId;
          }
        }
      }
      if (!next) return;
      expire(nextTeam, next, next.end);
    }
  }

  for (const { e, at } of items) {
    advance(at);
    if (e.type === "penalty") {
      if (!teams[e.team_id]) continue;
      const duration = penaltyDurationSec(e);
      const p = {
        event_id: e.id,
        team_id: e.team_id,
        player_id: e.player_id,
        severity: e.penalty_severity,
        infraction: e.infraction,
        minutes: e.penalty_minutes,
        duration,
        start: at,
        end: at + duration,
        queued: false,
        affects_strength: STRENGTH_AFFECTING.has(e.penalty_severity) && !e.coincidental,
      };
      all.push(p);
      if (!p.affects_strength) continue;
      if (teams[e.team_id].running.length < MAX_SHORTHANDED) teams[e.team_id].running.push(p);
      else {
        p.queued = true;
        teams[e.team_id].queued.push(p);
      }
      continue;
    }

    // goal
    const scoring = e.team_id;
    const conceding = other[scoring];
    if (!teams[scoring]) continue;
    const ours = teams[scoring].running.length;
    const theirs = teams[conceding].running.length;
    const computed = theirs > ours ? "PP" : ours > theirs ? "SH" : "EV";
    goalStrength[e.id] = computed;
    const effective = e.strength || computed;
    if (effective !== "PP") continue;
    const release = teams[conceding].running
      .filter((p) => RELEASABLE.has(p.severity))
      .sort((a, b) => a.end - b.end)[0];
    if (!release) continue;
    if (release.severity === "double_minor" && release.end - at > 120) release.end = at + 120;
    else expire(conceding, release, at);
  }
  advance(untilAbs);

  const active = all
    .filter((p) => p.queued || (p.start <= untilAbs && p.end > untilAbs))
    .map((p) => ({ ...p, remaining_sec: p.queued ? p.duration : p.end - untilAbs }));

  const shorthanded = (teamId) => Math.min(MAX_SHORTHANDED, teams[teamId].running.length);
  return {
    penalties: all,
    goalStrength,
    active,
    skaters: {
      [homeId]: t.skaters_per_side - shorthanded(homeId),
      [awayId]: t.skaters_per_side - shorthanded(awayId),
    },
  };
}

module.exports = { simulatePenalties, penaltyDurationSec, DURATION_SEC, STRENGTH_AFFECTING };

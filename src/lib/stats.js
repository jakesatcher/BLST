const { absSec, gameAbsNow } = require("./clock");
const { simulatePenalties, STRENGTH_AFFECTING } = require("./penalties");

// Every stat is derived from the event log here — nothing is kept as a
// running total — so editing or voiding an event is always reflected
// everywhere on the next read.

const SKATER_FIELDS = [
  "gp", "goals", "assists", "points", "plus_minus", "pim", "ppg", "ppa", "shg", "sha", "gwg", "eng",
  "shots", "missed_shots", "hits", "blocks", "fow", "fol", "giveaways", "takeaways", "penalties_drawn",
];
const GOALIE_FIELDS = [
  "gp", "toi_sec", "shots_against", "goals_against", "saves", "wins", "losses", "ot_losses", "ties", "shutouts", "pim",
];
const TEAM_FIELDS = [
  "goals", "shots", "pim", "ppg", "pp_opportunities", "shg", "fow", "hits", "blocks", "giveaways", "takeaways",
];

const zeroed = (fields) => Object.fromEntries(fields.map((f) => [f, 0]));

function eventOrder(t) {
  return (a, b) => absSec(t, a.period, a.elapsed_sec) - absSec(t, b.period, b.elapsed_sec) || a.id - b.id;
}

/**
 * Computes the full box score for one game.
 *
 * @param {object} input
 * @param {object} input.tournament  period/OT lengths, skaters_per_side, allow_ties
 * @param {object} input.game        games row
 * @param {object[]} input.roster    game_rosters rows (player_id, team_id, position, dressed)
 * @param {object[]} input.events    game_events rows
 * @param {number} [input.now]       epoch ms, for goalie TOI while the game is live
 */
function computeGameStats({ tournament: t, game, roster, events, now = Date.now() }) {
  const home = game.home_team_id;
  const away = game.away_team_id;
  const opp = { [home]: away, [away]: home };
  const live = events.filter((e) => !e.voided).sort(eventOrder(t));
  const started = game.status !== "scheduled";
  const endAbs = gameAbsNow(t, game, now);

  const skaters = new Map();
  const goalies = new Map();
  const teamOf = new Map();
  for (const r of roster) {
    teamOf.set(r.player_id, r.team_id);
    if (!r.dressed) continue;
    if (r.position === "G") goalies.set(r.player_id, { player_id: r.player_id, team_id: r.team_id, ...zeroed(GOALIE_FIELDS) });
    else skaters.set(r.player_id, { player_id: r.player_id, team_id: r.team_id, ...zeroed(SKATER_FIELDS), gp: started ? 1 : 0 });
  }
  // Events can reference players missing from the game roster (late
  // additions, a skater who dressed as goalie); give them a line anyway.
  const skater = (id, teamId) => {
    if (id == null) return null;
    if (!skaters.has(id)) {
      skaters.set(id, { player_id: id, team_id: teamOf.get(id) ?? teamId, ...zeroed(SKATER_FIELDS), gp: 1 });
    }
    return skaters.get(id);
  };
  const goalie = (id, teamId) => {
    if (id == null) return null;
    if (!goalies.has(id)) goalies.set(id, { player_id: id, team_id: teamOf.get(id) ?? teamId, ...zeroed(GOALIE_FIELDS) });
    return goalies.get(id);
  };

  const teams = { [home]: zeroed(TEAM_FIELDS), [away]: zeroed(TEAM_FIELDS) };
  const shootout = { [home]: 0, [away]: 0 };
  const sim = simulatePenalties(t, home, away, live, endAbs);
  const goalStrength = {};
  const goals = [];

  // Goalie time on ice: each goalie_change opens a new stint for that team.
  const stints = { [home]: [], [away]: [] };
  const goalieAt = (teamId, at) => {
    let current = null;
    for (const s of stints[teamId]) if (s.from <= at) current = s.goalie_id;
    return current;
  };

  for (const e of live) {
    const at = absSec(t, e.period, e.elapsed_sec);
    const team = teams[e.team_id];
    switch (e.type) {
      case "goal":
      case "penalty_shot": {
        if (!team) break;
        const scored = e.type === "goal" || e.result === "goal";
        // A penalty shot that misses the net isn't a shot on goal.
        if (e.type === "penalty_shot" && e.result === "miss") break;
        const strength = e.type === "penalty_shot" ? "PS" : e.strength || sim.goalStrength[e.id] || "EV";
        const shooter = skater(e.player_id, e.team_id);
        if (shooter) shooter.shots += 1;
        team.shots += 1;
        const g = e.empty_net ? null : goalie(e.goalie_id, opp[e.team_id]);
        if (g) g.shots_against += 1;
        if (!scored) {
          if (g) g.saves += 1;
          break;
        }
        goalStrength[e.id] = strength;
        team.goals += 1;
        if (strength === "PP") team.ppg += 1;
        if (strength === "SH") team.shg += 1;
        if (g) g.goals_against += 1;
        if (shooter) {
          shooter.goals += 1;
          if (strength === "PP") shooter.ppg += 1;
          if (strength === "SH") shooter.shg += 1;
          if (e.empty_net) shooter.eng += 1;
        }
        for (const aid of [e.assist1_id, e.assist2_id]) {
          const a = skater(aid, e.team_id);
          if (!a) continue;
          a.assists += 1;
          if (strength === "PP") a.ppa += 1;
          if (strength === "SH") a.sha += 1;
        }
        // Plus/minus: even-strength, shorthanded and empty-net goals count;
        // power-play goals and penalty shots don't. Only recorded when the
        // scorekeeper captured who was on the ice.
        if (strength !== "PP" && strength !== "PS") {
          const onIce = (teamId) => (teamId === home ? e.on_ice_home : e.on_ice_away) || [];
          for (const pid of onIce(e.team_id)) if (!goalies.has(pid)) skater(pid, e.team_id).plus_minus += 1;
          for (const pid of onIce(opp[e.team_id])) if (!goalies.has(pid)) skater(pid, opp[e.team_id]).plus_minus -= 1;
        }
        goals.push({ event: e, team_id: e.team_id, at, ordinal: team.goals });
        break;
      }
      case "shot": {
        if (!team) break;
        const s = skater(e.player_id, e.team_id);
        if (s) s.shots += 1;
        team.shots += 1;
        const g = goalie(e.goalie_id, opp[e.team_id]);
        if (g) {
          g.shots_against += 1;
          g.saves += 1;
        }
        break;
      }
      case "missed_shot": {
        const s = skater(e.player_id, e.team_id);
        if (s) s.missed_shots += 1;
        break;
      }
      case "blocked_shot": {
        const s = skater(e.player_id, e.team_id);
        if (s) s.blocks += 1;
        if (team) team.blocks += 1;
        break;
      }
      case "penalty": {
        const minutes = e.penalty_minutes || 0;
        const offender = goalies.has(e.player_id) ? goalies.get(e.player_id) : skater(e.player_id, e.team_id);
        if (offender) offender.pim += minutes;
        if (team) team.pim += minutes;
        const drew = skater(e.secondary_player_id, opp[e.team_id]);
        if (drew) drew.penalties_drawn += 1;
        if (opp[e.team_id] && STRENGTH_AFFECTING.has(e.penalty_severity) && !e.coincidental) {
          teams[opp[e.team_id]].pp_opportunities += 1;
        }
        break;
      }
      case "faceoff": {
        const w = skater(e.player_id, e.team_id);
        if (w) w.fow += 1;
        const l = skater(e.secondary_player_id, opp[e.team_id]);
        if (l) l.fol += 1;
        if (team) team.fow += 1;
        break;
      }
      case "hit": {
        const s = skater(e.player_id, e.team_id);
        if (s) s.hits += 1;
        if (team) team.hits += 1;
        break;
      }
      case "giveaway":
      case "takeaway": {
        const s = skater(e.player_id, e.team_id);
        const key = e.type === "giveaway" ? "giveaways" : "takeaways";
        if (s) s[key] += 1;
        if (team) team[key] += 1;
        break;
      }
      case "goalie_change": {
        if (!stints[e.team_id]) break;
        stints[e.team_id].push({ goalie_id: e.goalie_id, from: at });
        if (e.goalie_id != null) goalie(e.goalie_id, e.team_id);
        break;
      }
      case "shootout_attempt": {
        if (e.result === "goal" && shootout[e.team_id] !== undefined) shootout[e.team_id] += 1;
        break;
      }
      default:
        break;
    }
  }

  // Goalie TOI from stints.
  for (const teamId of [home, away]) {
    const list = stints[teamId];
    list.forEach((s, i) => {
      if (s.goalie_id == null) return;
      const to = i + 1 < list.length ? list[i + 1].from : endAbs;
      goalie(s.goalie_id, teamId).toi_sec += Math.max(0, Math.min(to, endAbs) - s.from);
    });
  }
  for (const g of goalies.values()) g.gp = g.toi_sec > 0 || g.shots_against > 0 ? 1 : 0;

  // A result from another system (no play-by-play): its stored score.
  if (game.result_only) {
    teams[home].goals = Number(game.home_score) || 0;
    teams[away].goals = Number(game.away_score) || 0;
  }

  // Result.
  const score = { [home]: teams[home].goals, [away]: teams[away].goals };
  let decision = game.decision || null;
  const shootoutTaken = shootout[home] + shootout[away] > 0 || live.some((e) => e.type === "shootout_attempt");
  if (!decision && game.status === "final") {
    if (score[home] === score[away] && shootoutTaken) decision = "SO";
    else if (game.period > t.periods) decision = "OT";
    else decision = "REG";
  }
  const final = { ...score };
  if (decision === "SO" && score[home] === score[away] && shootout[home] !== shootout[away]) {
    final[shootout[home] > shootout[away] ? home : away] += 1;
  }

  let winner = null;
  let loser = null;
  if (game.status === "final" && final[home] !== final[away]) {
    winner = final[home] > final[away] ? home : away;
    loser = opp[winner];
  }

  if (winner) {
    // Game-winning goal: the winner's goal that put them one past the
    // loser's final regulation/OT total. Shootout wins have no GWG.
    const gwg = decision === "SO" ? null : goals.find((g) => g.team_id === winner && g.ordinal === score[loser] + 1);
    if (gwg && gwg.event.player_id != null) skater(gwg.event.player_id, winner).gwg += 1;

    // Goalie of record: whoever was in net when the deciding goal went in
    // (the last goalie to play, for shootouts or an empty net).
    const decidingAt = gwg ? gwg.at : endAbs;
    const ofRecord = (teamId) => {
      const current = goalieAt(teamId, decidingAt);
      if (current != null) return current;
      const played = stints[teamId].filter((s) => s.goalie_id != null && s.from <= decidingAt);
      return played.length ? played[played.length - 1].goalie_id : null;
    };
    const w = ofRecord(winner);
    const l = ofRecord(loser);
    if (w != null) goalie(w, winner).wins += 1;
    if (l != null) goalie(l, loser)[decision === "REG" ? "losses" : "ot_losses"] += 1;
  } else if (game.status === "final") {
    for (const teamId of [home, away]) {
      const last = stints[teamId].filter((s) => s.goalie_id != null).pop();
      if (last) goalie(last.goalie_id, teamId).ties += 1;
    }
  }

  if (game.status === "final") {
    // Shutout: sole goalie of a team that allowed no goals (shootout excluded).
    for (const teamId of [home, away]) {
      if (score[opp[teamId]] !== 0) continue;
      const played = [...goalies.values()].filter((g) => g.team_id === teamId && g.toi_sec > 0);
      if (played.length === 1) played[0].shutouts += 1;
    }
  }

  for (const s of skaters.values()) s.points = s.goals + s.assists;

  return {
    game_id: game.id,
    status: game.status,
    decision,
    score: final,
    regulation_score: score,
    shootout,
    winner_team_id: winner,
    loser_team_id: loser,
    is_tie: game.status === "final" && !winner,
    teams,
    skaters: [...skaters.values()],
    goalies: [...goalies.values()],
    goal_strength: goalStrength,
    penalties: sim,
  };
}

function withSkaterRates(s) {
  const faceoffs = s.fow + s.fol;
  return {
    ...s,
    shooting_pct: s.shots ? round(s.goals / s.shots, 3) : null,
    faceoff_pct: faceoffs ? round(s.fow / faceoffs, 3) : null,
    points_per_game: s.gp ? round(s.points / s.gp, 2) : null,
  };
}

function withGoalieRates(g) {
  return {
    ...g,
    saves: g.shots_against - g.goals_against,
    save_pct: g.shots_against ? round((g.shots_against - g.goals_against) / g.shots_against, 3) : null,
    // Per 60 minutes, whatever the tournament's period length.
    gaa: g.toi_sec ? round((g.goals_against * 3600) / g.toi_sec, 2) : null,
  };
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function addInto(target, source, fields) {
  for (const f of fields) target[f] = (target[f] || 0) + (source[f] || 0);
}

/**
 * Sums per-game lines into per-player totals. A player who switched teams
 * mid-tournament gets one combined line plus a `by_team` split.
 */
function aggregatePlayerStats(gameStats) {
  const skaters = new Map();
  const goalies = new Map();
  const bump = (map, line, fields) => {
    if (!map.has(line.player_id)) map.set(line.player_id, { player_id: line.player_id, ...zeroed(fields), by_team: {} });
    const total = map.get(line.player_id);
    addInto(total, line, fields);
    total.by_team[line.team_id] = total.by_team[line.team_id] || { team_id: line.team_id, ...zeroed(fields) };
    addInto(total.by_team[line.team_id], line, fields);
  };
  for (const gs of gameStats) {
    for (const s of gs.skaters) bump(skaters, s, SKATER_FIELDS);
    for (const g of gs.goalies) if (g.gp) bump(goalies, g, GOALIE_FIELDS);
  }
  const finish = (map, rate) =>
    [...map.values()].map((line) => ({
      ...rate(line),
      by_team: Object.values(line.by_team).map(rate),
    }));
  return {
    skaters: finish(skaters, withSkaterRates),
    goalies: finish(goalies, withGoalieRates),
  };
}

/** Pool-play standings from final games. */
function computeStandings(t, teams, games, gameStats) {
  const rows = new Map(
    teams.map((team) => [
      team.id,
      { team_id: team.id, name: team.name, short_name: team.short_name, color: team.color, logo_version: team.logo_version ?? null,
        gp: 0, w: 0, l: 0, otl: 0, t: 0, pts: 0, gf: 0, ga: 0, diff: 0, pim: 0,
        reg_wins: 0, streak: "" },
    ]),
  );
  const statsById = new Map(gameStats.map((s) => [s.game_id, s]));
  const results = [];
  for (const game of games) {
    if (game.status !== "final" || game.game_type !== "pool") continue;
    const s = statsById.get(game.id);
    if (!s) continue;
    for (const [teamId, oppId] of [[game.home_team_id, game.away_team_id], [game.away_team_id, game.home_team_id]]) {
      const r = rows.get(teamId);
      if (!r) continue;
      r.gp += 1;
      r.gf += s.score[teamId];
      r.ga += s.score[oppId];
      r.pim += s.teams[teamId].pim;
      let outcome;
      if (s.winner_team_id === teamId) {
        r.w += 1;
        r.pts += t.points_win;
        if (s.decision === "REG") r.reg_wins += 1;
        outcome = "W";
      } else if (s.loser_team_id === teamId) {
        if (s.decision === "REG") r.l += 1;
        else {
          r.otl += 1;
          r.pts += t.points_otl;
        }
        outcome = s.decision === "REG" ? "L" : "OTL";
      } else {
        r.t += 1;
        r.pts += t.points_tie;
        outcome = "T";
      }
      results.push({ team_id: teamId, outcome, at: game.ended_at || game.scheduled_at });
    }
  }
  for (const r of rows.values()) {
    r.diff = r.gf - r.ga;
    const mine = results.filter((x) => x.team_id === r.team_id).sort((a, b) => new Date(a.at) - new Date(b.at));
    if (mine.length) {
      const last = mine[mine.length - 1].outcome;
      let n = 0;
      for (let i = mine.length - 1; i >= 0 && mine[i].outcome === last; i--) n++;
      r.streak = `${last}${n}`;
    }
  }
  // Points, then wins in regulation, then goal differential, then goals for.
  const sorted = [...rows.values()].sort(
    (a, b) => b.pts - a.pts || b.reg_wins - a.reg_wins || b.w - a.w || b.diff - a.diff || b.gf - a.gf || a.name.localeCompare(b.name),
  );
  sorted.forEach((r, i) => (r.rank = i + 1));
  return sorted;
}

module.exports = {
  computeGameStats,
  aggregatePlayerStats,
  computeStandings,
  withSkaterRates,
  withGoalieRates,
  SKATER_FIELDS,
  GOALIE_FIELDS,
  TEAM_FIELDS,
};

// Game clock math. The clock counts down; "elapsed" is time since the
// period started, which is what events are stamped with (like an NHL
// scoresheet). "abs" is seconds since opening faceoff across periods.

function periodLengthSec(t, period) {
  return period <= t.periods ? t.period_length_sec : t.ot_length_sec;
}

function periodLabel(t, period) {
  if (period <= t.periods) return ["1st", "2nd", "3rd", "4th"][period - 1] || `P${period}`;
  const ot = period - t.periods;
  return ot === 1 ? "OT" : `${ot}OT`;
}

function remainingMs(game, now = Date.now()) {
  if (!game.clock_running || !game.clock_started_at) return game.clock_remaining_ms;
  const started = new Date(game.clock_started_at).getTime();
  return Math.max(0, game.clock_remaining_ms - (now - started));
}

function elapsedSec(t, game, now = Date.now()) {
  const lenMs = periodLengthSec(t, game.period) * 1000;
  return Math.max(0, Math.floor((lenMs - remainingMs(game, now)) / 1000));
}

function absSec(t, period, elapsed) {
  let total = 0;
  for (let p = 1; p < period; p++) total += periodLengthSec(t, p);
  return total + elapsed;
}

/** Game time "now" in abs seconds: frozen at the final horn once a game is final. */
function gameAbsNow(t, game, now = Date.now()) {
  if (game.status === "scheduled") return 0;
  if (game.status === "final" && game.final_elapsed_sec != null) return game.final_elapsed_sec;
  return absSec(t, game.period, elapsedSec(t, game, now));
}

function formatClock(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

module.exports = { periodLengthSec, periodLabel, remainingMs, elapsedSec, absSec, gameAbsNow, formatClock };

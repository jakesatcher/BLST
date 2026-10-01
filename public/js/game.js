(async function () {
  const { h, mount, $, param, topbar, stream, table, fmtClock, fmtSec, fmtPct, fmtDate, statusBadge, teamDot, tabs } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  const id = Number(param("id"));
  if (!id) return mount(app, h("p", { class: "notice error" }, "Missing game id"));

  let snap = null;
  let remaining = () => 0;
  const board = h("div", { class: "board" });
  const detail = h("div");
  const tabBar = tabs([["summary", "Summary"], ["box", "Box score"], ["lineups", "Lineups"], ["feed", "Play by play"]], () => renderDetail(), "summary");
  mount(app, h("div", { class: "row between small muted", style: { marginBottom: "8px" } }, h("a", { id: "tlink", href: "/" }, "← Tournament"), h("a", { href: `/api/v1/export/games/${id}` }, "Game JSON")), board, tabBar.el, detail);

  const sideOf = (teamId) => (teamId === snap.home.id ? snap.home : snap.away);
  const absNow = () => snap.game.period_start_abs + (snap.game.period_length_sec - remaining() / 1000);

  function renderBoard() {
    const g = snap.game;
    const clockText = g.status === "scheduled" ? fmtDate(g.scheduled_at, { hour: "numeric", minute: "2-digit" }) : g.status === "final" ? "FINAL" : fmtClock(remaining());
    const team = (s) => {
      const other = s.id === snap.home.id ? snap.away : snap.home;
      const pp = g.status !== "final" && s.skaters_on_ice > other.skaters_on_ice;
      return h("div", { class: "team" },
        h("div", { class: "strip", style: { background: s.color || "#56627a" } }),
        BLST.teamMark(s, "lg"),
        h("div", { class: "name" }, s.name),
        h("div", { class: "score" }, g.status === "scheduled" ? "–" : s.score),
        h("div", { class: "sog" }, `SOG ${s.shots}`, pp ? h("span", { class: "badge pp", style: { marginLeft: "8px" } }, "PP") : ""),
        s.goalie ? h("div", { class: "goalie" }, `G: ${s.goalie.name}`) : g.status === "live" ? h("div", { class: "goalie" }, "Empty net") : "");
    };
    const pbox = (side) =>
      h("div", { class: "side" }, snap.active_penalties.filter((p) => p.team_id === side.id).map((p) => {
        const left = p.queued ? p.end_abs - p.start_abs : Math.max(0, p.end_abs - absNow());
        return h("div", null, h("span", null, p.player ? p.player.name : "Bench", ` · ${p.infraction || p.severity}`), h("span", { class: "t" }, p.queued ? `(${fmtSec(left)})` : fmtSec(left)));
      }));
    mount(board,
      h("div", { class: "teams" }, team(snap.away),
        h("div", { class: "center" },
          h("div", { class: "period" }, g.status === "intermission" ? `${g.period_label} · Intermission` : g.status === "final" ? g.decision && g.decision !== "REG" ? g.decision : "" : g.status === "scheduled" ? "Scheduled" : g.period_label),
          h("div", { class: `clock ${g.clock_running ? "" : "stopped"}` }, clockText),
          g.status === "final" ? "" : h("div", null, statusBadge(g))),
        team(snap.home)),
      snap.active_penalties.length ? h("div", { class: "pbox" }, pbox(snap.away), pbox(snap.home)) : "");
  }

  function describe(e) {
    const team = sideOf(e.team_id);
    const who = e.player ? e.player.name : "";
    switch (e.type) {
      case "goal": {
        const tags = [e.strength && e.strength !== "EV" ? e.strength : null, e.empty_net ? "EN" : null].filter(Boolean);
        return [h("b", null, `GOAL — ${team.short_name || team.name}`), ` ${who}`, e.assists.length ? h("span", { class: "muted" }, ` (${e.assists.map((a) => a.name).join(", ")})`) : h("span", { class: "muted" }, " (unassisted)"), tags.length ? h("span", { class: "badge pp", style: { marginLeft: "6px" } }, tags.join(" ")) : ""];
      }
      case "penalty":
        return [h("b", null, `${team.short_name || team.name} penalty`), ` ${who || "Bench"} — ${e.infraction || e.penalty_severity} (${e.penalty_minutes} min)`];
      case "goalie_change":
        return [h("b", null, `${team.short_name || team.name} goalie`), e.goalie ? ` ${e.goalie.name} in` : " pulled"];
      case "penalty_shot":
        return [h("b", null, "Penalty shot"), ` ${who} — ${e.result}`];
      case "shootout_attempt":
        return [h("b", null, "Shootout"), ` ${who} — ${e.result}`];
      case "shot": return [`Shot — ${who}`, e.goalie ? h("span", { class: "muted" }, ` saved by ${e.goalie.name}`) : ""];
      case "missed_shot": return [`Missed shot — ${who}`];
      case "blocked_shot": return [`Blocked by ${who}`, e.secondary_player ? h("span", { class: "muted" }, ` (shot by ${e.secondary_player.name})`) : ""];
      case "faceoff": return [`Faceoff won by ${who}`, e.secondary_player ? h("span", { class: "muted" }, ` vs ${e.secondary_player.name}`) : ""];
      case "hit": return [`Hit by ${who}`, e.secondary_player ? h("span", { class: "muted" }, ` on ${e.secondary_player.name}`) : ""];
      case "giveaway": return [`Giveaway — ${who}`];
      case "takeaway": return [`Takeaway — ${who}`];
      case "timeout": return [`Timeout — ${team ? team.name : ""}`];
      default: return [e.notes || e.type];
    }
  }

  function feed(events) {
    if (!events.length) return h("p", { class: "empty" }, "No events yet");
    const out = [];
    let lastPeriod = null;
    for (const e of events) {
      if (e.period !== lastPeriod) {
        out.push(h("div", { class: "period-head" }, e.period_label === "OT" || /OT$/.test(e.period_label) ? e.period_label : `${e.period_label} period`));
        lastPeriod = e.period;
      }
      out.push(h("li", null, h("span", { class: "when" }, e.time), h("span", { class: "what" }, ...describe(e))));
    }
    return h("ul", { class: "feed" }, out);
  }

  function renderDetail() {
    if (!snap) return;
    const tab = tabBar.current;
    if (tab === "summary") {
      const scoring = snap.events.filter((e) => e.type === "goal" || (e.type === "penalty_shot" && e.result === "goal"));
      const pens = snap.events.filter((e) => e.type === "penalty");
      const so = snap.events.filter((e) => e.type === "shootout_attempt");
      const stat = (label, a, b) => h("tr", null, h("td", { class: "num" }, a), h("th", { style: { textAlign: "center" } }, label), h("td", null, b));
      return mount(detail, h("div", { class: "grid two" },
        h("div", { class: "card" }, h("h2", null, "Scoring"), feed(scoring), so.length ? [h("h3", { style: { marginTop: "12px" } }, "Shootout"), feed(so)] : ""),
        h("div", null,
          h("div", { class: "card" }, h("h2", null, "Team stats"), h("table", null, h("tbody", null,
            h("tr", null, h("th", { class: "num" }, snap.away.short_name || snap.away.name), h("th"), h("th", null, snap.home.short_name || snap.home.name)),
            stat("Shots", snap.away.shots, snap.home.shots),
            stat("Power play", `${snap.away.ppg}/${snap.away.pp_opportunities}`, `${snap.home.ppg}/${snap.home.pp_opportunities}`),
            stat("PIM", snap.away.pim, snap.home.pim),
            stat("Faceoffs won", snap.away.fow, snap.home.fow),
            stat("Hits", snap.away.hits, snap.home.hits),
            stat("Blocks", snap.away.blocks, snap.home.blocks)))),
          h("div", { class: "card" }, h("h2", null, "Penalties"), feed(pens)))));
    }
    if (tab === "feed") return mount(detail, h("div", { class: "card" }, feed([...snap.events].reverse())));
    if (tab === "lineups") {
      const list = (side, rows) => h("div", { class: "card" }, h("h2", null, BLST.teamMark(side), side.name),
        table([{ key: "number", label: "#", num: true }, { key: "name", label: "Player", fmt: (r) => h("a", { href: `/player.html?id=${r.player_id}` }, r.name) }, { key: "position", label: "Pos" },
          { key: "dressed", label: "", fmt: (r) => (r.dressed ? "" : "scratched") }], rows, { sortKey: "number", sortDir: 1 }));
      return mount(detail, h("div", { class: "grid two" }, list(snap.away, snap.lineups.away), list(snap.home, snap.lineups.home)));
    }
    if (tab === "box") {
      const skaterCols = [
        { key: "name", label: "Player", fmt: (r) => h("a", { href: `/player.html?id=${r.player_id}` }, r.player.name) },
        { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true }, { key: "points", label: "P", num: true },
        { key: "plus_minus", label: "+/-", num: true }, { key: "pim", label: "PIM", num: true }, { key: "shots", label: "SOG", num: true },
        { key: "hits", label: "HIT", num: true }, { key: "blocks", label: "BLK", num: true }, { key: "fow", label: "FOW", num: true }, { key: "fol", label: "FOL", num: true },
      ];
      const goalieCols = [
        { key: "name", label: "Goalie", fmt: (r) => r.player.name },
        { key: "toi_sec", label: "TOI", num: true, fmt: (r) => fmtSec(r.toi_sec) }, { key: "shots_against", label: "SA", num: true },
        { key: "goals_against", label: "GA", num: true }, { key: "saves", label: "SV", num: true },
        { key: "save_pct", label: "SV%", num: true, fmt: (r) => fmtPct(r.save_pct) },
        { key: "dec", label: "DEC", sort: false, fmt: (r) => (r.wins ? "W" : r.losses ? "L" : r.ot_losses ? "OTL" : r.ties ? "T" : "") },
      ];
      const block = (side) => h("div", { class: "card" }, h("h2", null, BLST.teamMark(side), side.name),
        table(skaterCols, snap.box.skaters.filter((s) => s.team_id === side.id), { sortKey: "points" }),
        h("div", { style: { height: "10px" } }),
        table(goalieCols, snap.box.goalies.filter((g) => g.team_id === side.id && (g.gp || g.toi_sec)), { sortKey: "toi_sec" }));
      return mount(detail, block(snap.away), block(snap.home));
    }
  }

  function apply(s) {
    snap = s;
    remaining = BLST.clockFrom(s.game);
    document.title = `${s.away.short_name || s.away.name} ${s.away.score} – ${s.home.score} ${s.home.short_name || s.home.name} · BLST`;
    $("#tlink").href = `/tournament.html?id=${s.game.tournament_id}`;
    $("#tlink").textContent = `← ${s.tournament.name}`;
    renderBoard();
    renderDetail();
  }

  stream({ game_id: id }, { snapshot: apply });
  setInterval(() => snap && (snap.game.clock_running || snap.active_penalties.length) && renderBoard(), 100);
})().catch((err) => BLST.toast(err.message, true));

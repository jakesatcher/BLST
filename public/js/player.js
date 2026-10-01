(async function () {
  const { h, mount, get, $, param, topbar, table, fmtPct, fmtSec, fmtDate, orderBadge } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  await BLST.ready;
  const id = Number(param("id"));
  if (!id) return mount(app, h("p", { class: "notice error" }, "Missing player id"));
  const [c, full] = await Promise.all([get(`/players/${id}/career`), get(`/players/${id}`)]);
  const f = full.factions;
  const p = c.player;
  document.title = `${p.first_name} ${p.last_name} · ${BLST.org ? BLST.org.name : "BLST"}`;
  const isGoalie = p.position === "G" || c.career.goalie.gp > 0;

  const skaterRows = [
    ...c.history.filter((x) => x.gp > 0).map((x) => ({ ...x, event: x.event_name || "", team: x.team_name || "", src: "Imported", points: x.goals + x.assists })),
    ...c.tournaments.filter((l) => l.skater).map((l) => ({ ...l.skater, season: l.season, event: l.tournament, team: l.skater.teams.join(" / "), src: "BLST", tid: l.tournament_id })),
  ];
  const goalieRows = [
    ...c.history.filter((x) => x.goalie_gp > 0).map((x) => ({ ...x, gp: x.goalie_gp, event: x.event_name || "", team: x.team_name || "", src: "Imported",
      save_pct: x.shots_against ? (x.shots_against - x.goals_against) / x.shots_against : null, gaa: x.toi_sec ? (x.goals_against * 3600) / x.toi_sec : null })),
    ...c.tournaments.filter((l) => l.goalie).map((l) => ({ ...l.goalie, season: l.season, event: l.tournament, team: l.goalie.teams.join(" / "), src: "BLST", tid: l.tournament_id })),
  ];
  const eventCell = (r) => (r.tid ? h("a", { href: `/tournament?id=${r.tid}` }, r.event) : r.event);

  const sk = c.career.skater;
  const gl = c.career.goalie;
  mount(app,
    h("div", { class: "row", style: { gap: "12px" } }, h("h1", { style: { margin: 0 } }, `${p.first_name} ${p.last_name}`), p.factions_order ? orderBadge(p.factions_order, { big: true }) : ""),
    h("p", { class: "muted" }, [p.position, p.shoots ? `Shoots ${p.shoots}` : null].filter(Boolean).join(" · ")),
    f ? h("div", { class: "card", style: { borderTop: `6px solid ${BLST.ORDER[f.order_slug]?.color || "var(--border)"}` } },
      h("div", { class: "row between" },
        h("h3", { style: { margin: 0 } }, "Factions"),
        h("strong", { style: { fontSize: "1.4rem" } }, `${f.total_points.toLocaleString()} pts`)),
      h("p", { class: "muted small" }, `For ${BLST.ORDER[f.order_slug]?.name || f.order_slug}: ${f.event_points} from events${f.bonus_points ? `, ${f.bonus_points} bonus` : ""}.`),
      f.events.length ? h("ul", { class: "stack", style: { paddingLeft: "18px" } }, f.events.map((e) =>
        h("li", null, e.tournament_id ? h("a", { href: `/tournament?id=${e.tournament_id}` }, e.event) : e.event,
          `: ${e.points} pts${e.placement ? ` · placed ${e.placement}` : ""}`))) : "",
      f.achievements.length ? [h("h4", null, "Achievements"), h("div", { class: "row" }, f.achievements.map((a) =>
        h("span", { class: "badge good", title: `${a.event ? `${a.event} · ` : ""}${fmtDate(a.awarded_at, { month: "short", day: "numeric", year: "numeric" })}` }, `🏅 ${a.title}`)))] : "") : "",
    h("div", { class: "grid three" },
      h("div", { class: "card" }, h("h3", null, "Career (skater)"), h("dl", { class: "kv" },
        h("dt", null, "GP"), h("dd", null, sk.gp), h("dt", null, "Goals"), h("dd", null, sk.goals), h("dt", null, "Assists"), h("dd", null, sk.assists),
        h("dt", null, "Points"), h("dd", null, sk.points), h("dt", null, "PIM"), h("dd", null, sk.pim), h("dt", null, "+/-"), h("dd", null, sk.plus_minus))),
      isGoalie ? h("div", { class: "card" }, h("h3", null, "Career (goalie)"), h("dl", { class: "kv" },
        h("dt", null, "GP"), h("dd", null, gl.gp), h("dt", null, "Record"), h("dd", null, `${gl.wins}-${gl.losses}-${gl.ot_losses}`),
        h("dt", null, "SV%"), h("dd", null, fmtPct(gl.save_pct)), h("dt", null, "GAA"), h("dd", null, gl.gaa == null ? "—" : gl.gaa.toFixed(2)),
        h("dt", null, "Shutouts"), h("dd", null, gl.shutouts))) : ""),
    h("div", { class: "card" }, h("h2", null, "Skater stats by event"), table([
      { key: "season", label: "Season" }, { key: "event", label: "Event", fmt: eventCell }, { key: "team", label: "Team" }, { key: "src", label: "Source" },
      { key: "gp", label: "GP", num: true }, { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true }, { key: "points", label: "P", num: true },
      { key: "plus_minus", label: "+/-", num: true }, { key: "pim", label: "PIM", num: true }, { key: "ppg", label: "PPG", num: true }, { key: "shots", label: "SOG", num: true },
    ], skaterRows)),
    isGoalie ? h("div", { class: "card" }, h("h2", null, "Goalie stats by event"), table([
      { key: "season", label: "Season" }, { key: "event", label: "Event", fmt: eventCell }, { key: "team", label: "Team" }, { key: "src", label: "Source" },
      { key: "gp", label: "GP", num: true }, { key: "wins", label: "W", num: true }, { key: "losses", label: "L", num: true }, { key: "ot_losses", label: "OTL", num: true },
      { key: "shots_against", label: "SA", num: true }, { key: "goals_against", label: "GA", num: true },
      { key: "save_pct", label: "SV%", num: true, fmt: (r) => fmtPct(r.save_pct) }, { key: "gaa", label: "GAA", num: true, fmt: (r) => (r.gaa == null ? "—" : r.gaa.toFixed(2)) },
      { key: "shutouts", label: "SO", num: true }, { key: "toi_sec", label: "TOI", num: true, fmt: (r) => fmtSec(r.toi_sec) },
    ], goalieRows)) : "",
    h("p", null, h("a", { href: `/api/v1/export/players/${id}?format=csv` }, "Download career CSV")));
})().catch((err) => BLST.toast(err.message, true));

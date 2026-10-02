/* One team across tournaments: its record each time and its players' stats
   while on the team (including imported seasons). */
(async function () {
  const { h, mount, get, $, param, topbar, table, fmtPct } = BLST;
  $("#top").replaceWith(topbar("history"));
  const app = $("#app");
  await BLST.ready;
  const id = Number(param("id"));
  if (!id) return mount(app, h("p", { class: "notice error" }, "Missing team id"));
  const d = await get(`/clubs/${id}`);
  document.title = `${d.club.name} · ${BLST.org ? BLST.org.name : "History"}`;
  const ord = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
  const tours = d.seasons.filter((s) => s.kind === "tournament");
  const total = tours.reduce((a, s) => {
    if (s.standing) for (const k of ["gp", "w", "l", "otl", "t", "gf", "ga"]) a[k] += s.standing[k];
    return a;
  }, { gp: 0, w: 0, l: 0, otl: 0, t: 0, gf: 0, ga: 0 });
  const skaters = d.players.filter((p) => p.skater.gp > 0 || p.skater.points > 0);
  const goalies = d.players.filter((p) => p.goalie.gp > 0);
  mount(app,
    h("p", { class: "small" }, h("a", { href: "/history#teams" }, "← All teams")),
    h("h1", { style: { marginBottom: "2px" } }, d.club.name),
    h("p", { class: "muted", style: { marginTop: 0 } },
      `${tours.length} tournament${tours.length === 1 ? "" : "s"}`,
      total.gp ? ` · ${total.w}-${total.l}-${total.otl}${total.t ? `-${total.t}` : ""} · GF ${total.gf} · GA ${total.ga}` : ""),
    h("div", { class: "card" }, h("h2", null, "Season by season"),
      table([
        { key: "season", label: "Season", fmt: (s) => s.season || "—" },
        { key: "event", label: "Event", fmt: (s) => (s.kind === "tournament" ? h("span", null, h("a", { href: `/tournament?id=${s.tournament_id}` }, s.tournament), s.imported ? h("span", { class: "muted small" }, " · imported") : "") : h("span", null, s.event || "Imported", h("span", { class: "muted small" }, " · imported"))) },
        { key: "record", label: "Record", sort: false, fmt: (s) => (s.standing ? `${s.standing.w}-${s.standing.l}-${s.standing.otl}${s.standing.t ? `-${s.standing.t}` : ""}` : "—") },
        { key: "finish", label: "Finish", sort: false, fmt: (s) => (s.final_placement ? (s.final_placement === 1 ? "🏆 Champions" : ord(s.final_placement)) : s.rank ? `${ord(s.rank)} of ${s.teams}` : "—") },
      ], d.seasons, { sortKey: null })),
    h("div", { class: "card" }, h("h2", null, "Players"),
      skaters.length ? table([
        { key: "name", label: "Player", fmt: (p) => h("a", { href: `/player?id=${p.player_id}` }, p.name) },
        { key: "events", label: "Seasons", num: true },
        { key: "gp", label: "GP", num: true }, { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true },
        { key: "points", label: "PTS", num: true }, { key: "pim", label: "PIM", num: true },
      ], skaters.map((p) => ({ ...p.skater, name: p.name, player_id: p.player_id, events: p.events })), { sortKey: "points" }) : h("p", { class: "muted" }, "No player stats yet.")),
    goalies.length ? h("div", { class: "card" }, h("h2", null, "Goalies"),
      table([
        { key: "name", label: "Goalie", fmt: (p) => h("a", { href: `/player?id=${p.player_id}` }, p.name) },
        { key: "gp", label: "GP", num: true }, { key: "wins", label: "W", num: true },
        { key: "save_pct", label: "SV%", num: true, fmt: (p) => fmtPct(p.save_pct) }, { key: "shutouts", label: "SO", num: true },
      ], goalies.map((p) => ({ ...p.goalie, name: p.name, player_id: p.player_id })), { sortKey: "gp" })) : "");
})();

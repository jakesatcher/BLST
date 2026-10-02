/* History: every player's all-time stats (whatever teams they played for)
   and the teams that carry over between tournaments. */
(async function () {
  const { h, mount, get, $, topbar, tabs, table, debounce, fmtPct } = BLST;
  $("#top").replaceWith(topbar("history"));
  const app = $("#app");
  await BLST.ready;
  const org = BLST.org ? BLST.org.name : "";
  const view = h("div");
  const initial = location.hash === "#teams" ? "teams" : "players";
  const bar = tabs([["players", "Players"], ["teams", "Teams"]], (id) => {
    history.replaceState(null, "", `#${id}`);
    (id === "teams" ? teamsView : playersView)();
  }, initial, { size: "medium" });
  mount(app,
    h("h1", { style: { marginBottom: "2px" } }, org ? `${org} history` : "History"),
    h("p", { class: "muted", style: { marginTop: 0 } }, "All-time stats from every tournament and imported season. Players' stats follow them from team to team."),
    bar.el, view);

  const SORTS = [["points", "Points"], ["goals", "Goals"], ["assists", "Assists"], ["gp", "Games"], ["pim", "PIM"], ["events", "Events"], ["wins", "Goalie wins"], ["shutouts", "Shutouts"], ["name", "Name"]];
  let q = "";
  let sort = "points";
  const results = h("div");

  async function load() {
    mount(results, h("p", { class: "muted" }, "Loading…"));
    const rows = await get(`/history/players?sort=${sort}&limit=${q ? 200 : 100}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const goalieSort = sort === "wins" || sort === "shutouts";
    // Without a search, only people who have played.
    const played = q ? rows : rows.filter((r) => r.events > 0 && r.skater.gp + r.goalie.gp > 0);
    const list = goalieSort ? played.filter((r) => r.goalie.gp > 0) : played;
    mount(results, list.length
      ? table(goalieSort
        ? [
          { key: "rank", label: "#", num: true, sort: false },
          { key: "name", label: "Goalie", fmt: (r) => h("a", { href: `/player?id=${r.player_id}` }, r.name) },
          { key: "gp", label: "GP", num: true }, { key: "wins", label: "W", num: true },
          { key: "save_pct", label: "SV%", num: true, fmt: (r) => fmtPct(r.save_pct) }, { key: "gaa", label: "GAA", num: true, fmt: (r) => (r.gaa ?? "—") },
          { key: "shutouts", label: "SO", num: true },
        ]
        : [
          { key: "rank", label: "#", num: true, sort: false },
          { key: "name", label: "Player", fmt: (r) => h("a", { href: `/player?id=${r.player_id}` }, r.name) },
          { key: "gp", label: "GP", num: true },
          { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true }, { key: "points", label: "PTS", num: true },
          { key: "pim", label: "PIM", num: true }, { key: "events", label: "Events", num: true },
        ],
      list.map((r, i) => ({ ...r, rank: i + 1, ...(goalieSort ? r.goalie : r.skater), name: r.name, events: r.events })),
      { sortKey: null })
      : h("p", { class: "muted" }, q ? "No players match." : "No stats yet."));
  }

  function playersView() {
    const search = h("input", { type: "search", placeholder: "Find a player", value: q, "aria-label": "Find a player", oninput: debounce((e) => { q = e.target.value.trim(); load(); }, 250) });
    const sortSel = h("select", { "aria-label": "Sort by", onchange: (e) => { sort = e.target.value; load(); } },
      SORTS.map(([v, l]) => h("option", { value: v, selected: v === sort }, l)));
    mount(view, h("div", { class: "card" },
      h("div", { class: "row between", style: { marginBottom: "10px" } }, search, h("label", { class: "inline" }, "Sort ", sortSel)),
      results));
    load();
  }

  async function teamsView() {
    mount(view, h("p", { class: "muted" }, "Loading…"));
    const clubs = (await get("/clubs")).filter((c) => c.tournaments > 0 || c.history_lines > 0);
    mount(view, clubs.length
      ? h("div", { class: "grid three" }, clubs.map((c) => h("a", { class: "card game-card", href: `/club?id=${c.id}` },
        h("div", { class: "row between" }, h("strong", null, c.name), c.record.titles ? h("span", { class: "badge good" }, `🏆 ${c.record.titles}`) : ""),
        h("div", { class: "muted small" }, `${c.tournaments} tournament${c.tournaments === 1 ? "" : "s"}${c.history_lines ? " · imported seasons" : ""}`),
        c.record.gp ? h("div", { class: "small" }, `${c.record.w}-${c.record.l}-${c.record.otl}${c.record.t ? `-${c.record.t}` : ""} · GF ${c.record.gf} · GA ${c.record.ga}`) : "")))
      : h("p", { class: "muted" }, "Team history appears here for tournaments where the same teams play each time (draft tournaments reshuffle teams, so their stats follow players instead)."));
  }

  (initial === "teams" ? teamsView : playersView)();
})();

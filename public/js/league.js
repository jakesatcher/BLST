/* A league: standings by division, stats by season and division (players'
   stats follow them across teams and divisions), and player ratings. */
(async function () {
  const { h, mount, get, $, param, topbar, tabs, table, fmtPct } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  await BLST.ready;
  const id = Number(param("id"));
  if (!id) return mount(app, h("p", { class: "notice error" }, "Missing league id"));
  const L = await get(`/leagues/${id}`);
  document.title = `${L.name} · ${BLST.org ? BLST.org.name : "League"}`;

  const state = { season: L.seasons[0] ? String(L.seasons[0].id) : "", division: "", tab: location.hash.slice(1) || "standings" };
  const seasonSel = h("select", { "aria-label": "Season", onchange: (e) => { state.season = e.target.value; show(); } },
    h("option", { value: "" }, "All seasons"), L.seasons.map((s) => h("option", { value: s.id, selected: String(s.id) === state.season }, s.name)));
  const divSel = h("select", { "aria-label": "Division", onchange: (e) => { state.division = e.target.value; show(); } },
    h("option", { value: "" }, "All divisions"), L.divisions.map((d) => h("option", { value: d.id }, `${d.name} division`)));
  const view = h("div");
  const bar = tabs([["standings", "Standings"], ["skaters", "Skaters"], ["goalies", "Goalies"], ["ratings", "Player ratings"]],
    (t) => { state.tab = t; history.replaceState(null, "", `?id=${id}#${t}`); show(); }, state.tab, { size: "medium" });
  mount(app,
    h("h1", { style: { marginBottom: "2px" } }, L.name),
    h("p", { class: "muted", style: { marginTop: 0 } }, `${L.divisions.map((d) => d.name).join(" · ")} divisions · ${L.seasons.length} season${L.seasons.length === 1 ? "" : "s"}`),
    h("div", { class: "row", style: { marginBottom: "10px" } }, seasonSel, divSel),
    bar.el, view);

  const qs = () => [state.season && `season_id=${state.season}`, state.division && `division_id=${state.division}`].filter(Boolean).join("&");
  const playerLink = (r) => h("a", { href: `/player?id=${r.player_id}` }, r.name);

  async function show() {
    mount(view, h("p", { class: "muted" }, "Loading…"));
    try {
      await ({ standings, skaters, goalies, ratings })[state.tab]();
    } catch (e) {
      mount(view, h("p", { class: "notice error" }, e.message));
    }
  }

  async function standings() {
    const season = L.seasons.find((s) => String(s.id) === state.season) || L.seasons[0];
    if (!season) return mount(view, h("p", { class: "muted" }, "No seasons yet."));
    const list = (await get(`/leagues/${id}/standings?season_id=${season.id}`)).filter((d) => !state.division || String(d.division_id) === state.division);
    mount(view, list.length ? list.map((d) => h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, `${d.division} division · ${season.name}`), h("a", { href: `/tournament?id=${d.competition_id}` }, "Scores & schedule →")),
      table([
        { key: "name", label: "Team" }, { key: "gp", label: "GP", num: true }, { key: "w", label: "W", num: true }, { key: "l", label: "L", num: true },
        { key: "otl", label: "OTL", num: true }, { key: "pts", label: "PTS", num: true }, { key: "gf", label: "GF", num: true }, { key: "ga", label: "GA", num: true },
      ], d.standings, { sortKey: null })))
      : h("p", { class: "muted" }, "No divisions in this season yet."));
  }

  async function skaters() {
    const s = await get(`/leagues/${id}/stats?${qs()}`);
    mount(view, h("div", { class: "card" }, s.skaters.length ? table([
      { key: "name", label: "Player", fmt: playerLink },
      { key: "teams", label: "Teams", sort: false, fmt: (r) => h("span", { class: "small" }, r.teams.join(", ")) },
      { key: "divisions", label: "Div", sort: false, fmt: (r) => r.divisions.join(", ") },
      { key: "gp", label: "GP", num: true }, { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true },
      { key: "points", label: "PTS", num: true }, { key: "pim", label: "PIM", num: true },
    ], s.skaters, { sortKey: "points" }) : h("p", { class: "muted" }, "No stats yet.")));
  }

  async function goalies() {
    const s = await get(`/leagues/${id}/stats?${qs()}`);
    mount(view, h("div", { class: "card" }, s.goalies.length ? table([
      { key: "name", label: "Goalie", fmt: playerLink },
      { key: "teams", label: "Teams", sort: false, fmt: (r) => h("span", { class: "small" }, r.teams.join(", ")) },
      { key: "gp", label: "GP", num: true }, { key: "wins", label: "W", num: true },
      { key: "save_pct", label: "SV%", num: true, fmt: (r) => fmtPct(r.save_pct) }, { key: "gaa", label: "GAA", num: true, fmt: (r) => r.gaa ?? "—" },
      { key: "shutouts", label: "SO", num: true },
    ], s.goalies, { sortKey: "gp" }) : h("p", { class: "muted" }, "No goalie stats yet.")));
  }

  async function ratings() {
    const r = await get(`/leagues/${id}/ratings?${qs()}`);
    const why = (row) => h("details", { class: "rating-why" }, h("summary", null, "How"),
      h("ul", { class: "small" }, row.breakdown.map((b) => h("li", null,
        `${b.season} ${b.division}${b.teams && b.teams.length ? ` (${b.teams.join(", ")})` : ""}: ${b.gp} GP, `,
        b.adjusted_per_game != null ? `${b.production_per_game} per game × ${b.strength} division = ${b.adjusted_per_game}` : `SV% ${fmtPct(b.save_pct)}, ${b.goals_against_per_game} GA/game (division ${b.strength})`,
        b.recency !== 1 ? ` · older season counts ${b.recency}×` : ""))));
    const meter = (n) => h("span", { class: "rating-pill", style: { "--r": `${n}%` } }, n);
    mount(view,
      h("p", { class: "muted small" }, `Ratings (0–100) compare each player's production with everyone in the league: goals, assists and special-teams scoring per game, worth more in stronger divisions, with recent seasons counting most and a few games' worth of league average blended in so small samples don't jump to the top. 80 means more production than 80% of the league's skaters. Goalies are rated on save % and goals against. Players need ${r.settings.min_games} games to be rated.`),
      h("div", { class: "card" }, h("h2", null, "Skaters"), r.skaters.length ? table([
        { key: "rating", label: "Rating", num: true, fmt: (x) => meter(x.rating) },
        { key: "name", label: "Player", fmt: playerLink },
        { key: "latest_division", label: "Div" }, { key: "gp", label: "GP", num: true },
        { key: "production", label: "Prod/G", num: true }, { key: "confidence", label: "Sample" },
        { key: "why", label: "", sort: false, fmt: why },
      ], r.skaters, { sortKey: "rating" }) : h("p", { class: "muted" }, "No skater ratings yet.")),
      h("div", { class: "card" }, h("h2", null, "Goalies"), r.goalies.length ? table([
        { key: "rating", label: "Rating", num: true, fmt: (x) => meter(x.rating) },
        { key: "name", label: "Goalie", fmt: playerLink },
        { key: "latest_division", label: "Div" }, { key: "gp", label: "GP", num: true }, { key: "confidence", label: "Sample" },
        { key: "why", label: "", sort: false, fmt: why },
      ], r.goalies, { sortKey: "rating" }) : h("p", { class: "muted" }, "No goalie ratings yet.")));
  }

  show();
})();

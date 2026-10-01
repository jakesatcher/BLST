(async function () {
  const { h, mount, get, $, param, topbar, tabs, table, gameCards, stream, debounce, fmtPct, fmtDay, fmtSec, teamDot } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  const id = Number(param("id"));
  if (!id) return mount(app, h("p", { class: "notice error" }, "Missing tournament id"));

  let t = await get(`/tournaments/${id}`);
  document.title = `${t.name} · BLST`;
  const view = h("div");
  const names = [["scores", "Scores"], ["standings", "Standings"], ["leaders", "Leaders"], ["skaters", "Skaters"], ["goalies", "Goalies"], ["teams", "Teams"]];
  if (t.factions_event_id) names.push(["orders", "Orders"]);
  const tabBar = tabs(names, (tab) => { history.replaceState(null, "", `?id=${id}#${tab}`); show(tab); }, location.hash.slice(1) || "scores");

  mount(
    app,
    h("div", { class: "row between" },
      h("div", { class: "title-row" }, t.logo_version ? h("img", { class: "logo lg", src: BLST.logoUrl("tournaments", t.id, t.logo_version), alt: "" }) : "",
        h("div", null, h("h1", null, t.name), h("div", { class: "muted" }, [t.season, t.location, `${t.teams.length} teams`].filter(Boolean).join(" · ")))),
      h("div", { class: "row" },
        h("a", { class: "btn", href: `/api/v1/export/tournaments/${id}/skaters?format=csv` }, "Skaters CSV"),
        h("a", { class: "btn", href: `/api/v1/export/tournaments/${id}` }, "JSON"))),
    h("div", { style: { height: "12px" } }),
    tabBar.el,
    view,
  );

  let cards = null;

  const draftLabel = (r) => [r.draft_round != null ? `Rd ${r.draft_round}` : null, r.draft_pick != null ? `#${r.draft_pick}` : null].filter(Boolean).join(" · ");

  async function show(tab) {
    if (cards) cards.stop();
    cards = null;
    if (tab === "scores") {
      const games = await get(`/tournaments/${id}/games`);
      const byDay = new Map();
      for (const g of games) {
        const key = g.scheduled_at ? new Date(g.scheduled_at).toDateString() : "Unscheduled";
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(g);
      }
      const sets = [...byDay.values()].map((list) => ({ list, cards: gameCards(list) }));
      const sections = sets.map(({ list, cards: c }) => h("section", null, h("h3", { class: "period-head" }, fmtDay(list[0].scheduled_at)), c.el));
      cards = { update: (s) => sets.some(({ cards: c }) => c.update(s)), stop: () => sets.forEach(({ cards: c }) => c.stop()) };
      return mount(view, games.length ? sections : h("p", { class: "empty" }, "No games scheduled yet"));
    }
    if (tab === "standings") {
      const rows = await get(`/tournaments/${id}/standings`);
      return mount(view, h("div", { class: "card" }, table(
        [
          { key: "rank", label: "#", num: true },
          { key: "name", label: "Team", fmt: (r) => h("span", null, BLST.teamMark({ id: r.team_id, logo_version: r.logo_version, color: r.color }), r.name) },
          { key: "gp", label: "GP", num: true }, { key: "w", label: "W", num: true }, { key: "l", label: "L", num: true },
          { key: "otl", label: "OTL", num: true }, ...(t.allow_ties ? [{ key: "t", label: "T", num: true }] : []),
          { key: "pts", label: "PTS", num: true }, { key: "gf", label: "GF", num: true }, { key: "ga", label: "GA", num: true },
          { key: "diff", label: "DIFF", num: true, fmt: (r) => (r.diff > 0 ? `+${r.diff}` : r.diff) },
          { key: "pim", label: "PIM", num: true }, { key: "streak", label: "STRK", sort: false },
        ],
        rows,
      ), h("p", { class: "muted small" }, `Pool games only. ${t.points_win} pts for a win, ${t.points_otl} for an OT/SO loss. Ties broken by regulation wins, wins, goal differential, goals for.`)));
    }
    if (tab === "leaders") {
      const l = await get(`/tournaments/${id}/leaders?limit=5`);
      const card = (title, list, fmt = (v) => v) =>
        h("div", { class: "card leader-card" }, h("h3", null, title),
          list.length ? h("ol", null, list.map((p) => h("li", null, h("a", { href: `/player.html?id=${p.player_id}` }, p.name), h("span", { class: "muted small" }, ` ${p.team || ""}`), h("span", { class: "v" }, fmt(p.value)))))
            : h("div", { class: "empty" }, "—"));
      return mount(view, h("div", { class: "grid three" },
        card("Points", l.points), card("Goals", l.goals), card("Assists", l.assists), card("Plus/minus", l.plus_minus, (v) => (v > 0 ? `+${v}` : v)),
        card("Penalty minutes", l.pim), card("Save %", l.save_pct, (v) => fmtPct(v)), card("Goals against avg", l.gaa, (v) => v.toFixed(2)),
        card("Wins", l.wins), card("Shutouts", l.shutouts)));
    }
    if (tab === "skaters") {
      const rows = await get(`/tournaments/${id}/stats/skaters`);
      return mount(view, h("div", { class: "card" }, table(
        [
          { key: "name", label: "Player", fmt: (r) => h("a", { href: `/player.html?id=${r.player_id}` }, r.name) },
          { key: "jersey_number", label: "#", num: true }, { key: "team", label: "Team", fmt: (r) => r.teams.join(" / ") }, { key: "position", label: "Pos" },
          { key: "gp", label: "GP", num: true }, { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true },
          { key: "points", label: "PTS", num: true }, { key: "plus_minus", label: "+/-", num: true }, { key: "pim", label: "PIM", num: true },
          { key: "ppg", label: "PPG", num: true }, { key: "shg", label: "SHG", num: true }, { key: "gwg", label: "GWG", num: true },
          { key: "shots", label: "SOG", num: true }, { key: "shooting_pct", label: "S%", num: true, fmt: (r) => fmtPct(r.shooting_pct, 1) },
          { key: "hits", label: "HIT", num: true }, { key: "blocks", label: "BLK", num: true },
          { key: "faceoff_pct", label: "FO%", num: true, fmt: (r) => fmtPct(r.faceoff_pct, 1) },
        ],
        rows,
        { sortKey: "points" },
      )));
    }
    if (tab === "goalies") {
      const rows = await get(`/tournaments/${id}/stats/goalies`);
      return mount(view, h("div", { class: "card" }, table(
        [
          { key: "name", label: "Goalie", fmt: (r) => h("a", { href: `/player.html?id=${r.player_id}` }, r.name) },
          { key: "team", label: "Team", fmt: (r) => r.teams.join(" / ") },
          { key: "gp", label: "GP", num: true }, { key: "wins", label: "W", num: true }, { key: "losses", label: "L", num: true },
          { key: "ot_losses", label: "OTL", num: true }, { key: "shots_against", label: "SA", num: true }, { key: "goals_against", label: "GA", num: true },
          { key: "saves", label: "SV", num: true }, { key: "save_pct", label: "SV%", num: true, fmt: (r) => fmtPct(r.save_pct) },
          { key: "gaa", label: "GAA", num: true, fmt: (r) => (r.gaa == null ? "—" : r.gaa.toFixed(2)) },
          { key: "shutouts", label: "SO", num: true }, { key: "toi_sec", label: "TOI", num: true, fmt: (r) => fmtSec(r.toi_sec) },
        ],
        rows,
        { sortKey: "save_pct" },
      )));
    }
    if (tab === "teams") {
      const teams = await get(`/tournaments/${id}/teams`);
      return mount(view, h("div", { class: "grid two" }, teams.map((team) =>
        h("div", { class: "card" },
          h("h2", { class: "title-row" }, BLST.teamMark(team, "md") || teamDot(team.color), team.name, team.short_name ? h("span", { class: "muted small" }, ` (${team.short_name})`) : ""),
          table(
            [
              { key: "jersey_number", label: "#", num: true },
              { key: "last_name", label: "Player", fmt: (r) => h("a", { href: `/player.html?id=${r.id}` }, `${r.first_name} ${r.last_name}`, r.role ? ` (${r.role})` : "") },
              { key: "position", label: "Pos" },
              ...(t.factions_event_id ? [{ key: "factions_order", label: "Order" }] : []),
              ...(team.roster.some((r) => r.draft_round != null || r.draft_pick != null)
                ? [{ key: "draft_pick", label: "Drafted", num: true, fmt: (r) => draftLabel(r) }] : []),
            ],
            team.roster,
            { sortKey: "jersey_number", sortDir: 1 },
          )))));
    }
    if (tab === "orders") {
      try {
        const totals = await get(`/tournaments/${id}/factions/order-totals`);
        return mount(view, h("div", { class: "card" }, h("h2", null, "BLPA Order standings for this event"), table(
          [{ key: "name", label: "Order", fmt: (r) => r.name || r.slug }, { key: "animal", label: "" }, { key: "totalPoints", label: "Points", num: true }, { key: "playerCount", label: "Players", num: true }],
          totals, { sortKey: "totalPoints" })));
      } catch (err) {
        return mount(view, h("p", { class: "notice error" }, `Order standings unavailable: ${err.message}`));
      }
    }
  }
  show(tabBar.current);

  const refresh = debounce(() => {
    if (tabBar.current !== "scores") show(tabBar.current);
  }, 1500);
  stream({ tournament_id: id }, {
    "game.summary": (s) => {
      if (cards && !cards.update(s) && tabBar.current === "scores") show("scores");
      if (s.reason.startsWith("event") || s.reason === "game.final") refresh();
    },
    "tournament.changed": debounce(async () => {
      t = await get(`/tournaments/${id}`);
      show(tabBar.current);
    }, 1000),
  });
})().catch((err) => BLST.toast(err.message, true));

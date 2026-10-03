(async function () {
  const { h, mount, get, $, topbar, gameCards, stream, fmtDate, fmtPct } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  await BLST.ready;

  const [games, allTournaments, leagues, awards] = await Promise.all([get("/games"), get("/tournaments"), get("/leagues").catch(() => []), get("/awards").catch(() => [])]);
  // League divisions are shown under their league; the grid is for tournaments.
  const tournaments = allTournaments.filter((t) => t.kind !== "league");
  const cards = gameCards(games, { showTournament: true });

  // ---- Stat leaders: all-time, or one tournament / league season-division.
  const leadersBox = h("div");
  const played = allTournaments.filter((t) => t.status !== "upcoming" || t.imported);
  const scope = h("select", { "aria-label": "Leaders for", onchange: () => drawLeaders() },
    h("option", { value: "" }, "All-time"),
    played.some((t) => t.kind === "league") ? h("optgroup", { label: "League seasons" }, played.filter((t) => t.kind === "league").map((t) => h("option", { value: t.id }, t.name))) : "",
    played.some((t) => t.kind !== "league") ? h("optgroup", { label: "Tournaments" }, played.filter((t) => t.kind !== "league").map((t) => h("option", { value: t.id }, `${t.name}${t.season ? ` (${t.season})` : ""}`))) : "");
  const panel = (title, list, fmt = (v) => v) => h("div", { class: "card leader-card" }, h("h3", null, title),
    list && list.length
      ? h("ol", null, list.map((p) => h("li", null, h("a", { href: `/player?id=${p.player_id}` }, p.name),
        p.team ? h("span", { class: "muted small" }, ` ${p.team}`) : h("span", { class: "muted small" }, ` ${p.gp} GP`), h("span", { class: "v" }, fmt(p.value)))))
      : h("div", { class: "empty muted" }, "No stats yet"));
  async function drawLeaders() {
    let l;
    try {
      l = await get(scope.value ? `/tournaments/${scope.value}/leaders?limit=5` : "/leaders?limit=5");
    } catch (err) {
      return mount(leadersBox, h("p", { class: "notice error" }, err.message));
    }
    mount(leadersBox,
      h("h3", { class: "leaders-group" }, "Skaters"),
      h("div", { class: "grid three" }, panel("Goals", l.goals), panel("Assists", l.assists), panel("Penalty minutes", l.pim)),
      h("h3", { class: "leaders-group" }, "Goalies"),
      h("div", { class: "grid three" }, panel("Save %", l.save_pct, (v) => fmtPct(v)), panel("Goals against avg", l.gaa, (v) => Number(v).toFixed(2)), panel("Wins", l.wins)),
      l.goalie_min_gp > 1 ? h("p", { class: "muted small" }, `Save % and GAA: goalies with at least ${l.goalie_min_gp} games.`) : "");
  }

  mount(
    app,
    awards.length ? h("div", { class: "awards" }, awards.map((a) => h("div", { class: "card award-card" },
      h("div", { class: "award-title" }, a.title),
      h("div", { class: "award-name" }, a.player_id ? h("a", { href: `/player?id=${a.player_id}` }, a.name) : a.name),
      a.note ? h("div", { class: "muted small" }, a.note) : ""))) : "",
    h("h1", null, "Live & upcoming"),
    games.length ? cards.el : h("p", { class: "muted" }, "No games today."),
    h("div", { class: "row between", style: { marginTop: "28px" } }, h("h2", { style: { margin: 0 } }, "Stat leaders"), scope),
    leadersBox,
    leagues.length ? [h("h2", { style: { marginTop: "28px" } }, "Leagues"),
      h("div", { class: "grid three" }, leagues.map((l) => h("a", { class: "card game-card", href: `/league?id=${l.id}` },
        h("strong", null, l.name),
        h("div", { class: "muted small" }, `${l.divisions} division${l.divisions === 1 ? "" : "s"}${l.current_season ? ` · ${l.current_season} season` : ""}`))))] : "",
    h("h2", { style: { marginTop: "28px" } }, "Tournaments"),
    tournaments.length
      ? h(
          "div",
          { class: "grid three" },
          tournaments.map((t) =>
            h(
              "a",
              { class: "card game-card", href: `/tournament?id=${t.id}` },
              h("div", { class: "row between" }, h("strong", { class: "title-row" }, t.logo_version ? h("img", { class: "logo md", src: BLST.logoUrl("tournaments", t.id, t.logo_version), alt: "" }) : "", t.name), t.live_games > 0 ? h("span", { class: "badge live" }, `${t.live_games} live`) : h("span", { class: "badge" }, t.status)),
              h("div", { class: "muted small" }, [t.season, t.location].filter(Boolean).join(" · ")),
              h("div", { class: "muted small" }, t.start_date ? `${fmtDate(t.start_date, { month: "short", day: "numeric", year: "numeric" })}` : "", ` · ${t.team_count} teams`),
            ),
          ),
        )
      : h("div", { class: "card", style: { textAlign: "center", padding: "28px 16px" } },
          h("h2", null, `Welcome to ${BLST.org ? BLST.org.name : "Beer League Stats"}`),
          h("p", { class: "muted" }, "No tournaments yet. Set one up in Admin: pick the number of teams, add players, and schedule games. Then score them live from an iPad."),
          h("div", { class: "row", style: { justifyContent: "center" } },
            h("a", { class: "btn primary", href: "/admin" }, "Set up a tournament"),
            h("a", { class: "btn", href: "/scorekeeper" }, "Scorekeeper"))),
  );

  drawLeaders();

  // New games appearing (a game starts that wasn't in the list) just reload the list.
  stream({}, {
    "game.summary": (s) => {
      if (!cards.update(s)) location.reload();
    },
  });
})().catch((err) => BLST.toast(err.message, true));

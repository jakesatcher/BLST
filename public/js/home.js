(async function () {
  const { h, mount, get, $, topbar, gameCards, stream, fmtDate } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");

  const [games, tournaments] = await Promise.all([get("/games"), get("/tournaments")]);
  const cards = gameCards(games, { showTournament: true });

  mount(
    app,
    h("h1", null, "Live & upcoming"),
    cards.el,
    h("h2", { style: { marginTop: "28px" } }, "Tournaments"),
    tournaments.length
      ? h(
          "div",
          { class: "grid three" },
          tournaments.map((t) =>
            h(
              "a",
              { class: "card game-card", href: `/tournament.html?id=${t.id}` },
              h("div", { class: "row between" }, h("strong", null, t.name), t.live_games > 0 ? h("span", { class: "badge live" }, `${t.live_games} live`) : h("span", { class: "badge" }, t.status)),
              h("div", { class: "muted small" }, [t.season, t.location].filter(Boolean).join(" · ")),
              h("div", { class: "muted small" }, t.start_date ? `${fmtDate(t.start_date, { month: "short", day: "numeric", year: "numeric" })}` : "", ` · ${t.team_count} teams`),
            ),
          ),
        )
      : h("p", { class: "empty" }, "No tournaments yet. Create one in Admin."),
  );

  // New games appearing (a game starts that wasn't in the list) just reload the list.
  stream({}, {
    "game.summary": (s) => {
      if (!cards.update(s)) location.reload();
    },
  });
})().catch((err) => BLST.toast(err.message, true));

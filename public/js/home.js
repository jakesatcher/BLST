(async function () {
  const { h, mount, get, $, topbar, gameCards, stream, fmtDate } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  await BLST.ready;

  const [games, tournaments, factions] = await Promise.all([get("/games"), get("/tournaments"), BLST.org && BLST.org.factions_enabled ? get("/factions/orders").catch(() => []) : []]);
  const cards = gameCards(games, { showTournament: true });

  mount(
    app,
    h("h1", null, "Live & upcoming"),
    games.length ? cards.el : h("p", { class: "muted" }, "No games today."),
    factions.length ? [
      h("div", { class: "row between", style: { marginTop: "28px" } }, h("h2", { style: { margin: 0 } }, "Faction standings"), h("a", { href: "/factions" }, "All standings →")),
      h("div", { class: "order-strip", style: { marginTop: "8px" } }, [...factions].sort((a, b) => a.rank - b.rank).map((o) => {
        const meta = BLST.ORDER[o.slug] || o;
        return h("a", { href: `/factions#${o.slug}`, style: { "--order": meta.color }, title: `${meta.name}: ${o.total_points} points` },
          h("small", null, `#${o.rank} ${meta.emoji}`), h("strong", null, o.total_points.toLocaleString()), h("small", null, meta.name));
      })),
    ] : "",
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

  // New games appearing (a game starts that wasn't in the list) just reload the list.
  stream({}, {
    "game.summary": (s) => {
      if (!cards.update(s)) location.reload();
    },
  });
})().catch((err) => BLST.toast(err.message, true));

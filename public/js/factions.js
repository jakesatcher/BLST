(async function () {
  const { h, mount, get, $, topbar, table, ORDERS, ORDER, orderBadge, fmtDate } = BLST;
  $("#top").replaceWith(topbar("factions"));
  const app = $("#app");

  let data = await get("/factions");
  const narrow = () => window.matchMedia("(max-width: 520px)").matches;
  const standings = h("div");
  const eventBox = h("div");
  const leadersBox = h("div");

  /** Six Order cards, best first, with a bar relative to the leader. */
  function orderCards(rows, { pointsKey = "total_points", sub } = {}) {
    const max = Math.max(1, ...rows.map((r) => r[pointsKey]));
    const sorted = [...rows].sort((a, b) => b[pointsKey] - a[pointsKey] || a.name.localeCompare(b.name));
    return h("div", { class: "order-grid" }, sorted.map((r) => {
      const o = ORDER[r.slug];
      return h("div", { class: `order-card${r.rank === 1 && r[pointsKey] > 0 ? " leader" : ""}`, id: r.slug, style: { "--order": o.color } },
        h("span", { class: "rank", "aria-label": `rank ${r.rank}` }, `#${r.rank}`),
        h("div", { class: "emoji", "aria-hidden": "true" }, o.emoji),
        h("h3", null, o.name),
        h("div", { class: "muted small" }, `The ${o.animal}s · ${r.members} member${r.members === 1 ? "" : "s"}`),
        h("div", { class: "pts" }, r[pointsKey].toLocaleString(), h("span", { class: "muted small", style: { fontWeight: 400 } }, " pts")),
        sub ? h("div", { class: "muted small" }, sub(r)) : "",
        h("div", { class: "bar" }, h("span", { style: { width: `${Math.round((100 * r[pointsKey]) / max)}%` } })));
    }));
  }

  function renderStandings() {
    mount(standings, orderCards(data.orders, {
      sub: (r) => (r.bonus_points ? `${r.event_points.toLocaleString()} from events · ${r.bonus_points.toLocaleString()} bonus` : null),
    }));
  }

  async function renderEvent(id) {
    if (!id) return mount(eventBox, h("p", { class: "muted" }, "Pick an event to see how each Order did there."));
    const e = data.events.find((x) => x.id === id);
    mount(eventBox, h("p", { class: "muted" }, "Loading…"));
    const totals = await get(`/factions/events/${encodeURIComponent(id)}/totals`);
    mount(eventBox,
      h("div", { class: "order-strip", style: { marginTop: "10px" } }, [...totals].sort((a, b) => a.rank - b.rank).map((r) => {
        const o = ORDER[r.slug];
        return h("a", { href: `#${r.slug}`, style: { "--order": o.color }, title: `${o.name}: ${r.total_points} points from ${r.members} members` },
          h("small", null, `#${r.rank} ${o.emoji}`), h("strong", null, r.total_points.toLocaleString()), h("small", null, o.name));
      })),
      e && e.tournament_id ? h("p", null, h("a", { href: `/tournament.html?id=${e.tournament_id}` }, `${e.tournament_name} scores and stats →`)) : "");
  }

  async function renderLeaders(order) {
    const rows = order ? await get(`/factions/leaders?order=${order}&limit=25`) : data.leaders;
    mount(leadersBox, rows.length
      ? table([
        { key: "rank", label: "#", num: true, sort: false },
        { key: "name", label: "Member", fmt: (r) => (r.player_id ? h("a", { href: `/player.html?id=${r.player_id}` }, r.name) : r.name) },
        { key: "order_slug", label: "Order", fmt: (r) => orderBadge(r.order_slug, { compact: narrow() }) },
        { key: "total_points", label: "Points", num: true },
      ], rows.map((r, i) => ({ ...r, rank: i + 1 })), { sortKey: "total_points" })
      : h("p", { class: "muted" }, "No points yet."));
  }

  const eventPicker = h("select", { "aria-label": "Event", onchange: (e) => renderEvent(e.target.value) },
    h("option", { value: "" }, data.events.length ? "Choose an event…" : "No events yet"),
    data.events.map((e) => h("option", { value: e.id }, `${e.name}${e.start_date ? ` (${fmtDate(e.start_date, { month: "short", year: "numeric" })})` : ""}`)));
  const leaderFilter = h("select", { "aria-label": "Order", onchange: (e) => renderLeaders(e.target.value) },
    h("option", { value: "" }, "All Orders"), ORDERS.map((o) => h("option", { value: o.slug }, `${o.emoji} ${o.name}`)));

  mount(app,
    h("div", { class: "row between" },
      h("div", null, h("h1", { style: { marginBottom: "2px" } }, "BLPA Factions"),
        h("p", { class: "muted", style: { marginTop: 0 } }, "The Original Draft Society: every player belongs to one of six Orders for life. Games, titles and awards earn points for your Order.")),
      h("button", { onclick: async () => { data = await get("/factions"); renderStandings(); renderLeaders(""); } }, "Refresh")),
    h("h2", null, "Order standings"),
    standings,
    h("div", { class: "grid two", style: { marginTop: "20px" } },
      h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "By event"), eventPicker), eventBox),
      h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "Top members"), leaderFilter), leadersBox)));
  renderStandings();
  renderLeaders("");
  const latest = data.events.find((e) => e.participants > 0);
  if (latest) {
    eventPicker.value = latest.id;
    renderEvent(latest.id);
  } else renderEvent(null);

  // Points change when games go final: refresh quietly once a minute.
  setInterval(async () => {
    if (document.hidden) return;
    data = await get("/factions").catch(() => data);
    renderStandings();
  }, 60000);
})().catch((err) => BLST.toast(err.message, true));

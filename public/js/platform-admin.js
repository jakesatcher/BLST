/* Platform admin (bare domain /platform): approve organizations and manage
   every account. Only platform admins get past the first request. */
(async function () {
  const { h, mount, api, get, $, topbar, tabs, toast, fmtDate, confirmSheet, formSheet } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  const n = (v, word) => `${v.toLocaleString()} ${word}${v === 1 ? "" : "s"}`;
  const STATUS = { pending: "Waiting", active: "Live", suspended: "Suspended", rejected: "Not approved" };

  const me = await get("/me").catch(() => ({}));
  if (!me.platform_admin) {
    return mount(app, h("div", { class: "card auth-card" }, h("h1", null, "Platform admin"),
      h("p", null, "Sign in with a platform admin account to approve organizations."),
      h("a", { class: "btn primary", href: "/account?next=/platform" }, "Sign in")));
  }
  const body = h("div");
  const bar = tabs([["orgs", "Organizations"], ["accounts", "Accounts"]], (id) => (id === "orgs" ? renderOrgs() : renderAccounts()), "orgs", { size: "medium" });
  mount(app, h("h1", null, "Platform admin"), bar.el, body);
  renderOrgs();

  async function act(fn, done) {
    try {
      await fn();
      done();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function renderOrgs() {
    const orgs = await get("/platform/orgs");
    const setStatus = (o, status, verb) => act(async () => {
      if (status !== "active" && !(await confirmSheet(`${verb} ${o.name}?${status === "suspended" ? " Its pages and API stop working until it's reactivated." : ""}`, { title: verb, confirmLabel: verb, danger: true }))) return;
      await api("PATCH", `/platform/orgs/${o.id}`, { status });
      toast(`${o.name}: ${STATUS[status]}`);
    }, renderOrgs);
    const card = (o) => h("li", { class: "card" },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("div", null, h("h3", { style: { margin: 0 } }, o.name), h("a", { class: "small", href: o.url }, o.url.replace(/^https?:\/\//, ""))),
        h("span", { class: `badge${o.status === "active" ? " good" : o.status === "pending" ? "" : " bad"}` }, STATUS[o.status])),
      h("dl", { class: "kv small" },
        h("dt", null, "Asked by"), h("dd", null, o.requested_by || "—"),
        h("dt", null, "Asked"), h("dd", null, fmtDate(o.created_at, { month: "short", day: "numeric", year: "numeric" })),
        o.request_note ? [h("dt", null, "Note"), h("dd", null, o.request_note)] : "",
        h("dt", null, "Size"), h("dd", null, [n(o.members, "member"), n(o.tournaments, "tournament"), n(o.players, "player")].join(" · ")),
        h("dt", null, "Factions"), h("dd", null, o.factions_enabled ? "On" : "Off")),
      h("div", { class: "row", style: { marginTop: "10px" } },
        o.status === "pending" ? [
          h("button", { class: "primary", onclick: () => setStatus(o, "active", "Approve") }, "Approve"),
          h("button", { onclick: () => setStatus(o, "rejected", "Reject") }, "Reject")] : "",
        o.status === "active" ? h("button", { class: "danger", onclick: () => setStatus(o, "suspended", "Suspend") }, "Suspend") : "",
        o.status === "suspended" || o.status === "rejected" ? h("button", { onclick: () => setStatus(o, "active", "Reactivate") }, o.status === "rejected" ? "Approve" : "Reactivate") : "",
        h("button", { onclick: () => rename(o) }, "Rename")));
    const pending = orgs.filter((o) => o.status === "pending");
    mount(body,
      h("h2", null, pending.length ? `Waiting for approval (${pending.length})` : "Nothing waiting for approval"),
      h("ul", { class: "card-list" }, pending.map(card)),
      h("h2", null, "All organizations"),
      h("ul", { class: "card-list" }, orgs.filter((o) => o.status !== "pending").map(card)));
  }

  async function rename(o) {
    const v = await formSheet(`Rename ${o.name}`, [
      { name: "name", label: "Name", value: o.name, required: true },
      { name: "slug", label: "Address", value: o.slug, required: true, hint: "Changing the address breaks old links and bookmarks." },
    ]);
    if (!v) return;
    const patch = {};
    if (v.name !== o.name) patch.name = v.name;
    if (v.slug.toLowerCase() !== o.slug) patch.slug = v.slug.toLowerCase();
    if (Object.keys(patch).length) act(() => api("PATCH", `/platform/orgs/${o.id}`, patch), renderOrgs);
  }

  async function renderAccounts() {
    const list = await get("/platform/accounts");
    mount(body, h("ul", { class: "card-list" }, list.map((a) => h("li", { class: "card" },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("div", null, h("b", null, a.email), h("div", { class: "small muted" }, a.phone, " · ", a.sessions, " active sessions")),
        h("div", { class: "row" },
          a.platform_admin ? h("span", { class: "badge good" }, "Platform admin") : "",
          a.disabled ? h("span", { class: "badge bad" }, "Disabled") : "")),
      a.orgs.length ? h("p", { class: "small" }, a.orgs.map((o) => `${o.name} (${o.role})`).join(", ")) : h("p", { class: "small muted" }, "No organizations"),
      h("div", { class: "row" },
        h("button", { onclick: () => act(() => api("PATCH", `/platform/accounts/${a.id}`, { platform_admin: !a.platform_admin }), renderAccounts) },
          a.platform_admin ? "Remove platform admin" : "Make platform admin"),
        h("button", { onclick: () => act(() => api("PATCH", `/platform/accounts/${a.id}`, { disabled: !a.disabled }), renderAccounts) }, a.disabled ? "Enable" : "Disable"),
        h("button", { onclick: () => act(async () => { const r = await api("POST", `/platform/accounts/${a.id}/logout`); toast(`Ended ${r.ended} sessions`); }, () => {}) }, "Sign out everywhere"),
        h("button", { class: "danger", onclick: () => act(async () => {
          if (!(await confirmSheet(`Delete ${a.email}? This can't be undone.`, { title: "Delete account", confirmLabel: "Delete", danger: true }))) return;
          await api("DELETE", `/platform/accounts/${a.id}`);
        }, renderAccounts) }, "Delete"))))));
  }
})();

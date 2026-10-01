/* The platform home (the bare domain): what Beer League Stats is, sign in,
   your organizations, and asking for a new one (a platform admin approves). */
(async function () {
  const { h, mount, api, get, $, topbar, tabs, toast, debounce, signInFlow, signOut } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  const STATUS = { pending: "Waiting for approval", active: "Live", suspended: "Suspended", rejected: "Not approved" };

  const [status, me] = await Promise.all([get("/auth/status"), get("/me").catch(() => ({}))]);
  const intro = h("section", { class: "card platform-hero" },
    h("h1", null, "Beer League Stats"),
    h("p", null, "Live scoring, stats and standings for your league, with optional Factions for player engagement."),
    h("p", { class: "small muted" }, "Each organization gets its own address, like ", h("b", null, "yourleague.", location.host), ", with Stats, Factions and Admin pages."));
  if (me.via !== "session") return renderSignedOut();
  renderSignedIn();

  function renderSignedOut() {
    const box = h("div");
    const names = [["login", "Sign in"], ["signup", "Create account"]];
    const initial = location.hash === "#signup" ? "signup" : "login";
    const intros = {
      login: "We'll email you a code, then text a code to your phone. No password needed.",
      signup: "Create an account, then ask for your organization. All we keep is your email address and mobile number.",
    };
    const bar = tabs(names, (id) => signInFlow(box, { mode: id, intro: intros[id], onDone: renderSignedIn }), initial, { size: "medium" });
    mount(app, intro, h("div", { class: "card auth-card" }, h("h2", null, "Get started"), bar.el, box,
      status.setup_needed ? h("p", { class: "notice small" }, "First start: ", h("a", { href: "/account" }, "set up the platform admin"), ".") : "",
      status.dev_codes ? h("p", { class: "notice small" }, "Development server: codes are printed in the server log.") : ""));
    signInFlow(box, { mode: initial, intro: intros[initial], onDone: renderSignedIn });
  }

  async function renderSignedIn() {
    const acct = await get("/account");
    const mine = await get("/platform/orgs/mine");
    const list = mine.length
      ? h("ul", { class: "org-list" }, mine.map((o) => h("li", null,
        h("div", null, h("b", null, o.name), h("div", { class: "small muted" }, o.url.replace(/^https?:\/\//, ""), " · ", o.role === "admin" ? "Admin" : "Scorekeeper")),
        o.status === "active"
          ? h("div", { class: "row" }, h("a", { class: "btn primary", href: `${o.url}/stats` }, "Open"), o.role === "admin" ? h("a", { class: "btn", href: `${o.url}/admin` }, "Admin") : "")
          : h("span", { class: `badge${o.status === "pending" ? "" : " bad"}` }, STATUS[o.status]))))
      : h("p", { class: "muted" }, "You aren't part of an organization yet. Ask for one below, or ask your league's admin to invite this email address.");
    mount(app, intro,
      h("section", { class: "card" }, h("h2", null, "Your organizations"), list,
        h("p", { class: "small muted" }, "Signed in as ", acct.email, ". Each organization's address has its own sign-in."),
        h("div", { class: "row" },
          acct.platform_admin ? h("a", { class: "btn primary", href: "/platform" }, "Platform admin") : "",
          h("a", { class: "btn", href: "/account" }, "Account"),
          h("button", { onclick: async () => { await signOut(); location.assign("/"); } }, "Sign out"))),
      requestForm());
  }

  function requestForm() {
    const name = h("input", { id: "org-name", maxlength: 80, autocomplete: "organization", placeholder: "Metro Beer League" });
    const slug = h("input", { id: "org-slug", maxlength: 40, autocapitalize: "none", spellcheck: "false", placeholder: "metro" });
    const note = h("textarea", { id: "org-note", maxlength: 500, rows: 3, placeholder: "Anything we should know (optional)" });
    const hint = h("p", { class: "small muted", "aria-live": "polite" });
    let slugEdited = false;
    const check = debounce(async () => {
      const v = slug.value.trim().toLowerCase();
      if (!v) return mount(hint, "");
      const r = await get(`/platform/orgs/check?slug=${encodeURIComponent(v)}`).catch(() => null);
      if (!r || slug.value.trim().toLowerCase() !== v) return;
      mount(hint, r.available ? ["✓ ", h("b", null, r.url.replace(/^https?:\/\//, "")), " is available"] : r.reason);
      hint.className = `small ${r.available ? "good-text" : "muted"}`;
    }, 300);
    name.addEventListener("input", () => {
      if (slugEdited) return;
      slug.value = name.value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      check();
    });
    slug.addEventListener("input", () => { slugEdited = true; check(); });
    const submit = h("button", { class: "primary", type: "submit" }, "Ask for this organization");
    return h("section", { class: "card" },
      h("h2", null, "Start an organization"),
      h("p", { class: "small muted" }, "A platform admin reviews new organizations, usually within a day. You'll get an email when it's live, and you'll be its admin."),
      h("form", { class: "org-form", onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          const o = await api("POST", "/platform/orgs", { name: name.value.trim(), slug: slug.value.trim().toLowerCase(), note: note.value.trim() || undefined });
          toast(`Asked for ${o.name}. We'll email you when it's approved.`);
          renderSignedIn();
        } catch (err) {
          toast(err.message, true);
          submit.disabled = false;
        }
      } },
      h("label", null, "Name", name),
      h("label", null, "Address", h("span", { class: "slug-row" }, slug, h("span", null, ".", location.host))), hint,
      h("label", null, "Note", note),
      h("div", { class: "row" }, submit)));
  }
})();

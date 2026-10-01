(async function () {
  const { h, mount, api, get, $, topbar, tabs, toast, setToken, fmtDate, confirmSheet, signInFlow, signOut } = BLST;
  $("#top").replaceWith(topbar("account"));
  const app = $("#app");
  await BLST.ready;
  const org = BLST.org;
  const next = new URLSearchParams(location.search).get("next");
  // Only same-site paths, never another origin.
  const goNext = () => location.assign(next && /^\/[A-Za-z0-9_\-./?=&]*$/.test(next) && !next.startsWith("//") ? next : "/account");

  const [status, me] = await Promise.all([get("/auth/status"), get("/me").catch(() => ({ role: null }))]);
  if (me.via === "session") return renderProfile();
  renderSignedOut();

  function renderSignedOut() {
    const box = h("div");
    const names = [["login", "Sign in"], ["signup", "Create account"]];
    if (status.setup_needed) names.push(["setup", "Set up admin"]);
    const initial = status.setup_needed ? "setup" : location.hash === "#signup" ? "signup" : "login";
    const intros = {
      login: "We'll email you a code, then text a code to your phone. No password needed.",
      signup: "All we keep is your email address and mobile number. Both are confirmed with one-time codes.",
      setup: "No admin account exists yet. Create the platform admin account: it signs in with an email code and a text-message code every time.",
    };
    const bar = tabs(names, (id) => signInFlow(box, { mode: id, intro: intros[id], onDone: done }), initial, { size: "medium" });
    mount(app, h("div", { class: "card auth-card" },
      h("h1", null, status.setup_needed ? "Welcome to Beer League Stats" : org ? `Sign in to ${org.name}` : "Your account"),
      bar.el, box,
      status.dev_codes ? h("p", { class: "notice small" }, "Development server: email and text-message codes are printed in the server log.") : ""));
    signInFlow(box, { mode: initial, intro: intros[initial], onDone: done });
  }

  function done(r) {
    toast("Signed in");
    if (next) return goNext();
    const here = org && (r.account.orgs || []).find((o) => o.slug === org.slug && o.status === "active");
    location.assign(here ? (here.role === "admin" ? "/admin" : "/scorekeeper") : r.account.platform_admin && !org ? "/platform" : org ? "/stats" : "/");
  }

  async function renderProfile() {
    const a = await get("/account");
    const roleText = { admin: "Admin", scorekeeper: "Scorekeeper" };
    const here = org && a.orgs.find((o) => o.slug === org.slug);
    const phoneBox = h("div");
    mount(app, h("div", { class: "card auth-card" },
      h("h1", null, "Your account"),
      h("dl", { class: "kv" },
        h("dt", null, "Email"), h("dd", null, a.email),
        h("dt", null, "Mobile"), h("dd", null, a.phone),
        a.platform_admin ? [h("dt", null, "Platform"), h("dd", null, "Platform admin")] : "",
        h("dt", null, "Member since"), h("dd", null, fmtDate(a.created_at, { month: "short", day: "numeric", year: "numeric" }))),
      org
        ? here
          ? h("div", { class: "row", style: { marginTop: "12px" } },
            h("span", null, `${roleText[here.role]} at ${org.name}`),
            here.role === "admin" ? h("a", { class: "btn primary", href: "/admin" }, "Admin & setup") : "",
            h("a", { class: "btn", href: "/scorekeeper" }, "Scorekeeper"))
          : h("p", { class: "small muted" }, `Need to score games or run ${org.name}? Ask one of its admins to add this email address.`)
        : "",
      a.orgs.length ? [h("h2", { style: { marginTop: "20px" } }, "Your organizations"),
        h("ul", { class: "org-list" }, a.orgs.map((o) => h("li", null,
          h("span", null, h("b", null, o.name), h("span", { class: "muted small" }, ` · ${roleText[o.role]}${o.status === "active" ? "" : ` · ${o.status}`}`)),
          o.status === "active" && o.url ? h("a", { class: "btn sm", href: `${o.url}/stats` }, "Open") : "")))] : "",
      h("h2", { style: { marginTop: "20px" } }, "Mobile number"),
      phoneBox,
      h("h2", { style: { marginTop: "20px" } }, "Sign out"),
      h("div", { class: "row" },
        h("button", { onclick: async () => { await signOut(); location.assign("/"); } }, "Sign out"),
        h("button", { onclick: async () => {
          if (!(await confirmSheet("Sign out on every phone, tablet and computer where this account is signed in?", { title: "Sign out everywhere", confirmLabel: "Sign out everywhere" }))) return;
          await api("POST", "/account/logout-all");
          setToken("");
          location.assign("/");
        } }, "Sign out everywhere")),
      h("h2", { style: { marginTop: "20px" } }, "Delete account"),
      h("p", { class: "small muted" }, "Deletes your email address and mobile number from Beer League Stats. Player stats aren't linked to accounts and stay."),
      h("button", { class: "danger", onclick: async () => {
        if (!(await confirmSheet("Delete your account? Your email and phone number are erased. This can't be undone.", { title: "Delete account", confirmLabel: "Delete", danger: true }))) return;
        try {
          await api("DELETE", "/account");
          setToken("");
          location.assign("/");
        } catch (e) {
          toast(e.message, true);
        }
      } }, "Delete my account")));
    const showPhoneButton = () => mount(phoneBox, h("button", { onclick: () => signInFlow(phoneBox, {
      mode: "phone", intro: "We'll email you a code to confirm it's you, then text a code to the new number.",
      onDone: () => { toast("Mobile number changed"); renderProfile(); },
    }) }, "Change mobile number"));
    showPhoneButton();
  }
})();

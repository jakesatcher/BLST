(async function () {
  const { h, mount, api, get, $, topbar, tabs, toast, setToken, fmtDate, confirmSheet, signInFlow, signOut } = BLST;
  $("#top").replaceWith(topbar("account"));
  const app = $("#app");
  const next = new URLSearchParams(location.search).get("next");
  // Only same-site paths, never another origin.
  const goNext = () => location.assign(next && /^\/[A-Za-z0-9_\-./?=&]*$/.test(next) && !next.startsWith("//") ? next : "/account.html");

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
      setup: "No admin account exists yet. Create the global admin account: it signs in with an email code and a text-message code every time.",
    };
    const bar = tabs(names, (id) => signInFlow(box, { mode: id, intro: intros[id], onDone: done }), initial, { size: "medium" });
    mount(app, h("div", { class: "card auth-card" },
      h("h1", null, status.setup_needed ? "Welcome to BLST" : "Your account"),
      bar.el, box,
      status.dev_codes ? h("p", { class: "notice small" }, "Development server: email and text-message codes are printed in the server log.") : ""));
    signInFlow(box, { mode: initial, intro: intros[initial], onDone: done });
  }

  function done(r) {
    toast(r.account.role === "admin" ? "Signed in as admin" : "Signed in");
    if (next) return goNext();
    location.assign(r.account.role === "admin" ? "/admin.html" : "/account.html");
  }

  async function renderProfile() {
    const a = await get("/account");
    const roleText = { admin: "Global admin", scorekeeper: "Scorekeeper", user: "Standard account" }[a.role];
    const phoneBox = h("div");
    mount(app, h("div", { class: "card auth-card" },
      h("h1", null, "Your account"),
      h("dl", { class: "kv" },
        h("dt", null, "Email"), h("dd", null, a.email),
        h("dt", null, "Mobile"), h("dd", null, a.phone),
        h("dt", null, "Access"), h("dd", null, roleText),
        h("dt", null, "Member since"), h("dd", null, fmtDate(a.created_at, { month: "short", day: "numeric", year: "numeric" }))),
      a.role === "user" ? h("p", { class: "small muted" }, "Need to score games or run a tournament? Ask an admin to give your account access.") : "",
      a.role !== "user" ? h("div", { class: "row", style: { marginTop: "12px" } },
        a.role === "admin" ? h("a", { class: "btn primary", href: "/admin.html" }, "Admin & setup") : "",
        h("a", { class: "btn", href: "/scorekeeper.html" }, "Scorekeeper")) : "",
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
      h("p", { class: "small muted" }, "Deletes your email address and mobile number from BLST. Player stats aren't linked to accounts and stay."),
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

(async function () {
  const { h, mount, api, get, $, topbar, tabs, toast, setToken, fmtDate, confirmSheet, signInFlow, signOut, mfaSetup, showBackupCodes } = BLST;
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
      login: "We'll email you a code. Admins and scorekeepers then use their authenticator app or passkey. No password needed.",
      signup: "All we keep is your email address, confirmed with a one-time code.",
      setup: "No admin account exists yet. Create the platform admin account: after the emailed code you'll set up an authenticator app or passkey.",
    };
    const bar = tabs(names, (id) => signInFlow(box, { mode: id, intro: intros[id], onDone: done }), initial, { size: "medium" });
    mount(app, h("div", { class: "card auth-card" },
      h("h1", null, status.setup_needed ? "Welcome to Beer League Stats" : org ? `Sign in to ${org.name}` : "Your account"),
      bar.el, box,
      status.dev_codes ? h("p", { class: "notice small" }, "Email isn't set up yet: sign-in codes are printed in the server log.") : ""));
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
    const securityBox = h("div", { id: "security" });
    mount(app, h("div", { class: "card auth-card" },
      h("h1", null, "Your account"),
      h("dl", { class: "kv" },
        h("dt", null, "Email"), h("dd", null, a.email),
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
      h("h2", { style: { marginTop: "20px" } }, "Sign-in security"),
      securityBox,
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
      h("p", { class: "small muted" }, "Deletes your email address from Beer League Stats. Player stats aren't linked to accounts and stay."),
      h("button", { class: "danger", onclick: async () => {
        if (!(await confirmSheet("Delete your account? Your email address is erased. This can't be undone.", { title: "Delete account", confirmLabel: "Delete", danger: true }))) return;
        try {
          await api("DELETE", "/account");
          setToken("");
          location.assign("/");
        } catch (e) {
          toast(e.message, true);
        }
      } }, "Delete my account")));
    renderSecurity(a);
    if (location.hash === "#security") securityBox.scrollIntoView();

    function renderSecurity(acct) {
      const m = acct.mfa;
      const again = () => renderProfile();
      const setup = () => mfaSetup(securityBox, { onDone: again, onCancel: () => renderSecurity(acct) });
      const remove = async (what, path) => {
        if (!(await confirmSheet(`Remove ${what}?`, { title: "Remove", confirmLabel: "Remove", danger: true }))) return;
        try {
          await api("DELETE", path);
          toast("Removed");
          again();
        } catch (e) {
          toast(e.message, true);
        }
      };
      mount(securityBox,
        acct.staff && !m.enabled ? h("p", { class: "notice" }, "Your account has admin or scorekeeper access. Set up an authenticator app or passkey to use it.") : "",
        h("p", { class: "small muted" }, m.enabled
          ? "After the emailed code, you confirm it's you with one of these."
          : "Sign-in uses an emailed code. Add an authenticator app or passkey for a second step (required for admins and scorekeepers)."),
        h("ul", { class: "org-list" },
          h("li", null, h("span", null, h("b", null, "Authenticator app"), h("span", { class: "muted small" }, m.totp ? " · on" : " · off")),
            m.totp ? h("button", { class: "sm", onclick: () => remove("the authenticator app", "/account/mfa/totp") }, "Remove") : ""),
          m.passkeys.map((k) => h("li", null,
            h("span", null, h("b", null, k.name), h("span", { class: "muted small" }, `${k.name === "Passkey" ? "" : " · passkey"} · added ${fmtDate(k.created_at, { month: "short", day: "numeric", year: "numeric" })}`)),
            h("button", { class: "sm", onclick: () => remove(`the passkey "${k.name}"`, `/account/mfa/passkeys/${encodeURIComponent(k.id)}`) }, "Remove"))),
          m.enabled ? h("li", null, h("span", null, h("b", null, "Backup codes"), h("span", { class: "muted small" }, ` · ${m.backup_codes_left} left`)),
            h("button", { class: "sm", onclick: async () => {
              if (!(await confirmSheet("Make new backup codes? The old ones stop working.", { title: "New backup codes", confirmLabel: "Make new codes" }))) return;
              try {
                const r = await api("POST", "/account/mfa/backup-codes");
                showBackupCodes(securityBox, r.backup_codes, again);
              } catch (e) {
                toast(e.message, true);
              }
            } }, "New codes")) : ""),
        h("button", { class: m.enabled ? "" : "primary", onclick: setup }, m.enabled ? "Add another authenticator or passkey" : "Set up an authenticator app or passkey"));
    }
  }
})();

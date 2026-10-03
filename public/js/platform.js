/* The main site (beerleaguestats.hockey / www): a landing page that isn't
   any one league. Every league lives at its own address
   (<league>.beerleaguestats.hockey); this page points people there, and
   lets someone sign in and ask for a new league (a platform admin approves). */
(async function () {
  const { h, mount, api, get, $, topbar, tabs, toast, debounce, signInFlow, signOut } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  await BLST.ready;
  const STATUS = { pending: "Waiting for approval", active: "Live", suspended: "Suspended", rejected: "Not approved" };
  const domain = (BLST.platform && BLST.platform.app_domain) || location.host.replace(/^www\./, "");

  const [status, me, leagues] = await Promise.all([
    get("/auth/status"), get("/me").catch(() => ({})), get("/platform/leagues").catch(() => []),
  ]);
  const live = leagues.reduce((a, l) => a + l.live_games, 0);
  /** "BLPA" → BLPA; "Metro Beer League" → MBL */
  const monogram = (name) => {
    const words = String(name).split(/[\s-]+/).filter(Boolean);
    return (words.length === 1 ? words[0].slice(0, 5) : words.slice(0, 3).map((w) => w[0]).join("")).toUpperCase();
  };

  // ---- Hero
  const hero = h("section", { class: "rink-hero landing-hero" },
    h("div", { class: "kicker" }, "Hockey stats for beer leagues"),
    h("h1", null, "Beer League Stats"),
    h("p", { class: "sub" }, "Live scoring from the bench, stat leaders, standings and every season's history, for your league, at your league's own address."),
    h("div", { class: "row hero-cta" },
      h("a", { class: "btn primary", href: "#leagues" }, "Find your league"),
      h("a", { class: "btn ghost-light", href: "#start" }, "Start a league")),
    h("div", { class: "tally" },
      h("div", null, h("strong", null, leagues.length), leagues.length === 1 ? "League" : "Leagues"),
      h("div", { class: live ? "live" : "" }, h("strong", null, live), "Live now")));

  // ---- Find your league
  const jump = h("input", { placeholder: "yourleague", autocapitalize: "none", spellcheck: "false", "aria-label": "League address" });
  const go = (e) => {
    e.preventDefault();
    const slug = jump.value.trim().toLowerCase().replace(/\..*$/, "");
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) return toast("Type your league's address, like blpa", true);
    const known = leagues.find((l) => l.slug === slug);
    location.assign(known ? known.url : `${location.protocol}//${slug}.${domain}`);
  };
  const directory = h("section", { id: "leagues" },
    h("div", { class: "section-head" }, h("h2", null, "Find your league")),
    h("form", { class: "jump card", onsubmit: go },
      h("label", { class: "jump-row" }, h("span", { class: "sr-only" }, "League address"),
        jump, h("span", { class: "jump-domain" }, `.${domain}`)),
      h("button", { class: "primary" }, "Go")),
    leagues.length
      ? h("div", { class: "league-grid" }, leagues.map((l) => h("a", { class: "league-tile", href: `${l.url}/stats` },
        h("div", { class: "row between" },
          h("span", { class: "league-mark" }, monogram(l.name)),
          l.live_games ? h("span", { class: "badge live" }, `${l.live_games} live`) : ""),
        h("strong", null, l.name),
        h("span", { class: "league-url" }, l.url.replace(/^https?:\/\//, "")),
        h("span", { class: "league-meta" }, [l.leagues ? `${l.leagues} league${l.leagues === 1 ? "" : "s"}` : null, l.tournaments ? `${l.tournaments} tournament${l.tournaments === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ") || "Just getting started"))))
      : h("p", { class: "muted" }, "No leagues yet. Be the first."));

  // ---- What it does
  const features = h("section", null,
    h("div", { class: "section-head" }, h("h2", null, "What your league gets")),
    h("div", { class: "feature-grid" }, [
      ["⏱", "Live scoring at the rink", "Run the clock, goals, assists and penalties from an iPad on the bench. Scores update on everyone's phone as they happen."],
      ["🏒", "Stats and leaders", "Goals, assists, PIM, save % and more, for every game, season and division, with leader boards on the front page."],
      ["🏆", "Seasons and history", "Divisions, standings, playoffs and career stats that follow players across teams, plus player ratings."],
      ["🔌", "Bring what you have", "Import old seasons from spreadsheets, stat sites, Google Sheets, SportsEngine or LeagueApps."],
    ].map(([icon, title, text]) => h("div", { class: "card feature" }, h("div", { class: "feature-icon", "aria-hidden": "true" }, icon), h("h3", null, title), h("p", null, text)))));

  const start = h("section", { id: "start" });
  mount(app, hero, directory, features, start);
  if (me.via === "session") renderSignedIn();
  else renderSignedOut();

  // ---- Run a league: sign in, your leagues, ask for a new one
  function renderSignedOut() {
    const box = h("div");
    const names = [["signup", "Create account"], ["login", "Sign in"]];
    if (status.setup_needed) names.push(["setup", "Set up admin"]);
    const initial = status.setup_needed ? "setup" : location.hash === "#login" ? "login" : "signup";
    const intros = {
      login: "We'll email you a code. Admins and scorekeepers then use their authenticator app or passkey. No password needed.",
      signup: "Create an account, then ask for your league's address. All we keep is your email address.",
      setup: "No admin account exists yet. Enter the setup key from the server log (or ADMIN_TOKEN) to create the platform admin.",
    };
    const bar = tabs(names, (id) => signInFlow(box, { mode: id, intro: intros[id], onDone: renderSignedIn }), initial, { size: "medium" });
    mount(start,
      h("div", { class: "section-head" }, h("h2", null, "Start a league")),
      h("div", { class: "card auth-card" },
        h("p", { class: "muted small" }, "Players and fans don't need an account: they just visit the league's address. To run a league, create an account and ask for one."),
        bar.el, box,
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
      : h("p", { class: "muted" }, "You aren't part of a league yet. Ask for one below, or ask your league's admin to invite this email address.");
    mount(start,
      h("div", { class: "section-head" }, h("h2", null, "Your leagues")),
      acct.staff && !acct.mfa.enabled ? h("section", { class: "card" },
        h("p", { class: "notice" }, "Your account can run a league. Set up an authenticator app or passkey to use that access."),
        h("a", { class: "btn primary", href: "/account#security" }, "Set it up")) : "",
      h("section", { class: "card" }, list,
        h("p", { class: "small muted" }, "Signed in as ", acct.email, ". Each league's address has its own sign-in (same account)."),
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
    const submit = h("button", { class: "primary", type: "submit" }, "Ask for this league");
    return h("section", { class: "card" },
      h("h2", null, "Start a league"),
      h("p", { class: "small muted" }, "A platform admin reviews new leagues, usually within a day. You'll get an email when it's live, with a link to set it up, and you'll be its admin."),
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
      h("label", null, "League name", name),
      h("label", null, "Address", h("span", { class: "slug-row" }, slug, h("span", null, `.${domain}`))), hint,
      h("label", null, "Note", note),
      h("div", { class: "row" }, submit)));
  }
})();

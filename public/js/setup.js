/* League setup (/setup): a new organization's admin is walked through the
   league and divisions, this season, connections, past seasons and people. */
(async function () {
  const { h, mount, api, get, $, topbar, toast, table } = BLST;
  $("#top").replaceWith(topbar("admin"));
  const app = $("#app");
  await BLST.ready;

  const me = await get("/me").catch(() => ({ role: null }));
  if (me.role !== "admin") {
    const box = h("div");
    mount(app, h("div", { class: "card auth-card" }, h("h1", null, "Set up your league"),
      me.role ? h("p", { class: "notice" }, "This page is for the organization's admins.") : "", box));
    if (me.mfa_required) return BLST.mfaSetup(box, { required: true, onDone: () => location.reload() });
    if (!me.role) BLST.signInFlow(box, { mode: "login", intro: "Sign in with the email your organization was set up with.", onDone: () => location.reload() });
    return;
  }

  const STEPS = [
    ["league", "League"], ["season", "This season"], ["connect", "Connect"], ["history", "Past seasons"], ["people", "People"], ["finish", "Done"],
  ];
  let P = await get("/admin/onboarding");
  let current = location.hash.slice(1) && STEPS.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : P.completed ? "finish" : P.next;
  const body = h("div");
  const bar = h("nav", { class: "steps-mini setup-steps", "aria-label": "Setup steps" });

  async function run(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (err) {
      toast(err.message, true);
      throw err;
    }
  }
  const field = (label, control, cls) => h("label", { class: cls }, label, control);
  const stepState = (id) => (P.steps.find((s) => s.id === id) || {});
  async function refresh() {
    P = await get("/admin/onboarding");
  }
  function go(id) {
    current = id;
    history.replaceState(null, "", `#${id}`);
    draw();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  const nextOf = (id) => STEPS[STEPS.findIndex(([s]) => s === id) + 1][0];
  async function skip(id) {
    P = await run(() => api("PUT", "/admin/onboarding", { skip: id }));
    go(nextOf(id));
  }
  const footer = (id, { canContinue = true, label = "Continue" } = {}) => h("div", { class: "row between setup-footer" },
    STEPS[0][0] === id ? h("span") : h("button", { onclick: () => go(STEPS[STEPS.findIndex(([s]) => s === id) - 1][0]) }, "← Back"),
    h("div", { class: "row" },
      stepState(id).done ? "" : h("button", { onclick: () => skip(id) }, "Skip for now"),
      h("button", { class: "primary", disabled: !canContinue, onclick: async () => { await refresh(); go(nextOf(id)); } }, label)));

  mount(app,
    h("div", { class: "row between" }, h("h1", null, `Set up ${P.org.name}`), h("a", { href: "/admin" }, "Admin →")),
    bar, body);
  draw();

  function drawBar() {
    mount(bar, STEPS.map(([id, label]) => {
      const s = stepState(id);
      const cls = id === current ? "now" : s.done ? "done" : "";
      return h("button", { class: cls, type: "button", "aria-current": id === current ? "step" : null, onclick: () => go(id) }, s.done && id !== current ? `✓ ${label}` : label);
    }));
  }

  async function draw() {
    drawBar();
    mount(body, h("p", { class: "muted" }, "Loading…"));
    try {
      await ({ league: leagueStep, season: seasonStep, connect: connectStep, history: historyStep, people: peopleStep, finish: finishStep })[current]();
    } catch (err) {
      mount(body, h("p", { class: "notice error" }, err.message));
    }
  }

  // ---- 1. League and divisions
  async function leagueStep() {
    const L = P.league;
    if (L) {
      const add = h("input", { placeholder: "e.g. D", maxlength: 40 });
      return mount(body, h("div", { class: "card" },
        h("h2", null, L.name),
        h("p", null, "Divisions, strongest first: ", h("strong", null, L.divisions.map((d) => d.name).join(", ") || "none yet")),
        h("p", { class: "muted small" }, "Ratings compare players across divisions using this order: production in a stronger division counts for more. Fine-tune each division's strength later under Admin → Leagues."),
        h("form", { class: "row", onsubmit: async (e) => {
          e.preventDefault();
          if (!add.value.trim()) return;
          await run(() => api("POST", `/leagues/${L.id}/divisions`, { name: add.value.trim() }), "Division added");
          await refresh();
          draw();
        } }, add, h("button", null, "Add division")),
        footer("league")));
    }
    const name = h("input", { name: "name", required: true, maxlength: 80, value: P.org.name });
    const short = h("input", { name: "short_name", maxlength: 20, placeholder: "e.g. Metro" });
    const divs = h("textarea", { rows: 4, placeholder: "B\nC\nD" });
    const types = h("input", { placeholder: "e.g. DEX, Bash (optional)", value: (P.org.tournament_types || []).join(", ") });
    mount(body, h("div", { class: "card" },
      h("h2", null, "Your league"),
      h("p", { class: "muted small" }, "A league runs seasons; each season has divisions (B, C, D…). Stats are kept by season and division, and follow each player across teams and divisions."),
      h("form", { class: "form", onsubmit: async (e) => {
        e.preventDefault();
        const divisions = divs.value.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
        if (!divisions.length) return toast("Add at least one division (one per line, strongest first)", true);
        const league = await run(() => api("POST", "/leagues", { name: name.value.trim(), short_name: short.value.trim() || undefined, divisions }), "League created");
        const list = types.value.split(",").map((x) => x.trim()).filter(Boolean);
        if (list.length) await run(() => api("PUT", "/admin/tournament-types", { types: list }));
        P = await run(() => api("PUT", "/admin/onboarding", { league_id: league.id }));
        go("season");
      } },
        field("League name", name), field("Short name (for headings)", short),
        field("Divisions, strongest first (one per line)", divs, "wide"),
        field("Do you also run one-off tournaments? Their types", types, "wide"),
        h("div", { class: "wide" }, h("button", { class: "primary" }, "Create the league")))));
  }

  // ---- 2. This season
  async function seasonStep() {
    const L = P.league;
    if (!L) return mount(body, h("div", { class: "card" }, h("p", null, "Create the league first."), footer("season", { canContinue: false })));
    const live = L.competitions.filter((c) => !c.imported);
    const year = new Date().getFullYear();
    const name = h("input", { required: true, maxlength: 40, value: String(year) });
    const start = h("input", { type: "date" });
    const end = h("input", { type: "date" });
    const rows = L.divisions.map((d) => ({
      d, on: h("input", { type: "checkbox", checked: true }),
      teams: h("textarea", { rows: 4, placeholder: "One team per line" }),
    }));
    mount(body, h("div", { class: "card" },
      h("h2", null, "This season"),
      live.length ? h("p", null, "Already set up: ", h("strong", null, live.map((c) => c.name).join(", ")), ". Add another season below, or continue.") : "",
      h("p", { class: "muted small" }, "Each division in the season gets its own teams, schedule, standings and live scoring. Team names carry over from season to season."),
      h("form", { class: "stack", onsubmit: async (e) => {
        e.preventDefault();
        const chosen = rows.filter((r) => r.on.checked);
        if (!chosen.length) return toast("Choose at least one division", true);
        let season = L.seasons.find((s) => s.name.toLowerCase() === name.value.trim().toLowerCase());
        if (!season) season = await run(() => api("POST", `/leagues/${L.id}/seasons`, { name: name.value.trim(), year: Number((/(19|20)\d{2}/.exec(name.value) || [])[0]) || undefined, start_date: start.value || undefined, end_date: end.value || undefined }));
        for (const r of chosen) {
          const names = r.teams.value.split("\n").map((x) => x.trim()).filter(Boolean);
          await run(() => api("POST", `/leagues/${L.id}/seasons/${season.id}/divisions/${r.d.id}`, { team_names: names, num_teams: Math.max(2, names.length || 4) }))
            .catch(() => null);
        }
        toast(`${season.name} is set up`);
        await refresh();
        go("connect");
      } },
        h("div", { class: "form" }, field("Season", name), field("Starts", start), field("Ends", end)),
        h("div", { class: "setup-divisions" }, rows.map((r) => h("div", { class: "card setup-division" },
          h("label", { class: "inline" }, r.on, h("strong", null, `${r.d.name} division`)),
          field("Teams (blank = Team 1, Team 2…; rename later)", r.teams)))),
        h("div", null, h("button", { class: "primary" }, "Set up the season"))),
      footer("season")));
  }

  // ---- 3. Connect other systems
  async function connectStep() {
    const se = h("div");
    const la = h("div");
    mount(body,
      h("div", { class: "card" }, h("h2", null, "Connect the systems you already use"),
        h("p", { class: "muted small" }, "Optional. SportsEngine brings teams, rosters, schedules and past scores; LeagueApps brings registrations and players' emails. You can connect either later under Admin → Integrations, and import from spreadsheets without either.")),
      la, se, h("div", { class: "card" }, footer("connect")));
    const changed = async () => {
      await refresh();
      drawBar();
    };
    await Promise.all([BLST.leagueAppsCard(la, { onChange: changed }), BLST.sportsEngineCard(se, { onChange: changed })]);
  }

  // ---- 4. Past seasons
  async function historyStep() {
    const L = P.league;
    const imp = h("div");
    const summary = () => h("p", null, P.counts.history_rows || P.counts.imported_results
      ? [h("strong", null, `${P.counts.history_rows} stat lines`), P.counts.imported_results ? ` and ${P.counts.imported_results} game results` : "", " imported so far."]
      : "Nothing imported yet.");
    const sum = h("div", null, summary());
    mount(body,
      h("div", { class: "card" }, h("h2", null, "Bring in past seasons"),
        h("p", { class: "muted small" }, "Player stats from earlier seasons count toward career totals, history pages and player ratings. Use one file with every season and division (season and division columns), or one file at a time. Spreadsheets, stats-site exports, Google Sheets links, SportsEngine and LeagueApps all work."),
        sum),
      imp, h("div", { class: "card" }, footer("history")));
    if (!L) return mount(imp, h("p", { class: "notice" }, "Create the league first."));
    await BLST.historyImporter(imp, { leagueId: L.id, onDone: async () => {
      await refresh();
      mount(sum, summary());
      drawBar();
    } });
  }

  // ---- 5. People
  async function peopleStep() {
    const list = h("div");
    const load = async () => {
      const m = await get("/admin/members");
      const people = [...(m.members || []).map((x) => ({ email: x.email, role: x.role, status: "member" })), ...(m.invites || []).map((x) => ({ email: x.email, role: x.role, status: "invited" }))];
      mount(list, table([{ key: "email", label: "Email" }, { key: "role", label: "Role" }, { key: "status", label: "" }], people));
    };
    const email = h("input", { type: "email", required: true, placeholder: "name@example.com", autocomplete: "off" });
    const role = h("select", null, h("option", { value: "scorekeeper" }, "Scorekeeper"), h("option", { value: "admin" }, "Admin"));
    mount(body, h("div", { class: "card" },
      h("h2", null, "Who helps run it?"),
      h("p", { class: "muted small" }, "Scorekeepers run the clock and record goals and penalties at the rink. Admins set up seasons, teams and imports. They get an email; their access applies when they sign in with that address."),
      h("form", { class: "form", onsubmit: async (e) => {
        e.preventDefault();
        await run(() => api("POST", "/admin/members", { email: email.value.trim(), role: role.value }), "Invitation sent");
        email.value = "";
        await refresh();
        drawBar();
        load();
      } }, field("Email", email), field("Role", role), h("div", null, h("button", { class: "primary" }, "Invite"))),
      list, footer("people")));
    load();
  }

  // ---- Done
  async function finishStep() {
    const L = P.league;
    const left = P.steps.filter((s) => !s.done);
    mount(body, h("div", { class: "card" },
      h("h2", null, P.completed ? "Your league is set up" : "Almost there"),
      h("ul", { class: "checklist" }, P.steps.map((s) => h("li", { class: s.done ? "done" : "" },
        h("span", null, h("span", { class: "tick" }, s.done ? "✓" : ""), " ", STEPS.find(([id]) => id === s.id)[1]),
        s.done ? "" : h("button", { class: "sm", onclick: () => go(s.id) }, s.skipped ? "Skipped · do it now" : "Do it now")))),
      left.length ? h("p", { class: "muted small" }, "Skipped steps can be done any time, here or in Admin.") : "",
      h("div", { class: "row", style: { marginTop: "12px" } },
        P.completed ? "" : h("button", { class: "primary", onclick: async () => {
          P = await run(() => api("PUT", "/admin/onboarding", { completed: true }), "Setup finished");
          draw();
        } }, "Finish setup"),
        L ? h("a", { class: "btn", href: `/league?id=${L.id}` }, "League page") : "",
        h("a", { class: "btn", href: "/scorekeeper" }, "Scorekeeper"),
        h("a", { class: "btn", href: "/admin" }, "Admin"))));
  }

})();

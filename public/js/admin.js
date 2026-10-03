(async function () {
  const { h, mount, api, get, $, topbar, tabs, table, toast, setToken, fmtDate, statusBadge, teamDot, debounce, confirmSheet, formSheet, openSheet } = BLST;
  $("#top").replaceWith(topbar("admin"));
  const app = $("#app");

  const me = await get("/me").catch(() => ({ role: null }));
  if (me.role !== "admin") return renderLogin();

  async function renderLogin() {
    const status = await get("/auth/status").catch(() => ({}));
    const box = h("div");
    mount(app, h("div", { class: "card auth-card" },
      h("h1", null, status.setup_needed ? "Set up the admin account" : "Admin sign-in"),
      me.role && !me.mfa_required ? h("p", { class: "notice" }, "You're signed in, but this account isn't an admin. Ask an admin for access.") : "",
      box,
      status.setup_needed ? "" : h("details", null, h("summary", null, "Use an API key instead"), keyForm())));
    if (me.mfa_required) return BLST.mfaSetup(box, { required: true, onDone: () => location.reload() });
    BLST.signInFlow(box, {
      mode: status.setup_needed ? "setup" : "login",
      intro: status.setup_needed
        ? "No admin account exists yet. Create the platform admin: after the emailed code you'll set up an authenticator app or passkey. After that, the admin password (ADMIN_TOKEN) stops working."
        : "Admins sign in with an emailed code, then their authenticator app or passkey.",
      onDone: () => location.reload(),
    });
  }

  function keyForm() {
    const input = h("input", { type: "password", placeholder: "Admin API key", autocomplete: "off", style: { width: "100%" } });
    return h("form", { class: "stack", style: { marginTop: "8px" }, onsubmit: async (e) => {
      e.preventDefault();
      setToken(input.value.trim());
      const who = await get("/me").catch(() => ({ role: null }));
      if (who.role !== "admin") {
        setToken("");
        return toast("Not an admin key", true);
      }
      location.reload();
    } }, h("p", { class: "small muted" }, "For automation and break-glass access only. People should sign in with their account."), input, h("button", null, "Use key"));
  }

  // -------------------------------------------------------------------------
  // Small form helpers

  function values(form, { blankAsNull = false } = {}) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "radio") {
        if (el.checked) out[el.name] = el.value;
        continue;
      }
      if (el.type === "checkbox") out[el.name] = el.checked;
      else if (el.value === "") out[el.name] = blankAsNull ? null : undefined;
      else if (el.type === "number" || el.dataset.num) out[el.name] = Number(el.value);
      else if (el.type === "datetime-local") out[el.name] = new Date(el.value).toISOString();
      else out[el.name] = el.value;
    }
    return out;
  }
  const field = (label, input, cls) => h("label", { class: cls }, label, input);
  const input = (name, attrs = {}) => h("input", { name, ...attrs });
  const select = (name, options, value, attrs = {}) =>
    h("select", { name, ...attrs }, options.map((o) => (Array.isArray(o) ? h("option", { value: o[0], selected: String(o[0]) === String(value) }, o[1]) : h("option", { value: o, selected: String(o) === String(value) }, o))));
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
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
  function fileLoader(textarea) {
    return h("input", { type: "file", accept: ".csv,text/csv,.json,application/json", onchange: async (e) => {
      const f = e.target.files[0];
      if (f) textarea.value = await f.text();
    } });
  }
  function importPayload(text, extra) {
    const trimmed = text.trim();
    if (trimmed.startsWith("[")) return { rows: JSON.parse(trimmed), ...extra };
    return { csv: text, ...extra };
  }
  function importReport(r) {
    return h("div", { class: `notice ${r.errors.length ? "error" : ""}`, style: { marginTop: "10px" } },
      h("div", null, h("strong", null, r.dry_run ? "Dry run: " : r.committed ? "Imported: " : "Not imported: "),
        `${r.imported}/${r.rows} rows OK · ${r.created_players} new players${r.created_teams ? ` · ${r.created_teams} new teams` : ""}${r.moved ? ` · ${r.moved} moved` : ""}`),
      !r.committed && !r.dry_run ? h("div", null, "Fix the rows below or tick “skip bad rows” and import again.") : "",
      r.errors.length ? h("ul", { class: "small" }, r.errors.slice(0, 50).map((e) => h("li", null, `Row ${e.row}: ${e.error}`))) : "",
      r.errors.length > 50 ? h("div", { class: "small" }, `…and ${r.errors.length - 50} more`) : "",
      r.tournament ? h("div", { class: "small", style: { marginTop: "6px" } }, "Tournament: ", h("strong", { class: "mono" }, r.tournament.code), " ",
        r.tournament.id && !r.dry_run ? h("a", { href: `/tournament?id=${r.tournament.id}`, target: "_blank" }, r.tournament.name) : r.tournament.name,
        r.tournament.created ? " (new)" : "", r.tournament.replaced ? " · earlier upload replaced" : "") : "");
  }

  // -------------------------------------------------------------------------
  // Shell

  await BLST.ready;
  const factionsOn = Boolean(BLST.org && BLST.org.factions_enabled);
  const view = h("div");
  const tabNames = [["tournaments", "Tournaments"], ["leagues", "Leagues"], ["players", "Players"], ["history", "History"], ["org", "Organization"], ["keys", "API keys"], ["webhooks", "Webhooks"], ["integrations", "Integrations"],
    ...(factionsOn ? [["factions", "Factions"]] : []), ["security", "Security"]];
  let firstTab = location.hash.slice(1).split("/")[0] || "tournaments";
  if (firstTab === "accounts") firstTab = "org";
  if (!tabNames.some(([id]) => id === firstTab)) firstTab = "tournaments";
  const mainTabs = tabs(tabNames, (t) => { history.replaceState(null, "", `#${t}`); show(t); }, firstTab, { size: "big" });
  mount(app,
    h("div", { class: "row between" }, h("h1", null, "Admin"),
      me.via === "dev-open" ? h("span", { class: "badge" }, "dev mode: no ADMIN_TOKEN set") : ""),
    mainTabs.el, view);

  function show(tab) {
    const fn = { tournaments: tournamentsView, players: playersView, history: historyView, leagues: leaguesView, org: orgView, keys: keysView, webhooks: webhooksView, integrations: integrationsView, factions: factionsGlobalView, security: securityView }[tab];
    mount(view, h("p", { class: "muted" }, "Loading…"));
    fn().catch((err) => mount(view, h("p", { class: "notice error" }, err.message)));
  }

  // -------------------------------------------------------------------------
  // Tournaments

  let selectedTid = Number((location.hash.split("/")[1] || "").trim()) || null;

  async function tournamentsView() {
    const list = await get("/tournaments");
    if (!selectedTid && list.length) selectedTid = list[0].id;
    const picker = select("t", [["", "— choose —"], ...list.map((t) => [t.id, `${t.name}${t.season ? ` (${t.season})` : ""}`])], selectedTid || "", {
      onchange: (e) => { selectedTid = Number(e.target.value) || null; history.replaceState(null, "", `#tournaments/${selectedTid || ""}`); tournamentsView(); },
    });
    const body = h("div");
    mount(view,
      h("div", { class: "row between", style: { marginBottom: "12px" } },
        h("div", { class: "row" }, h("strong", null, "Tournament"), picker, selectedTid ? h("a", { href: `/tournament?id=${selectedTid}`, target: "_blank" }, "Public page ↗") : ""),
        h("button", { class: "primary", onclick: () => { selectedTid = null; mount(body, newTournamentForm()); } }, "New tournament")),
      body);
    if (!selectedTid) return mount(body, newTournamentForm());
    const t = await get(`/tournaments/${selectedTid}`);
    const sub = h("div");
    const subTabs = tabs([["registrations", "Registrations"], ["teams", "Teams & rosters"], ["schedule", "Schedule"], ["import", "Draft / roster upload"], ["streams", "Streams"], ["moves", "Moves"], ["settings", "Settings"]],
      (s) => tournamentSub(s, t, sub), "teams", { size: "medium" });
    const checklist = h("div");
    mount(body, checklist, subTabs.el, sub);
    tournamentSub("teams", t, sub);
    renderChecklist(t, checklist, subTabs).catch(() => {});
  }

  /** Setup steps for a tournament; hides itself once everything is done. */
  async function renderChecklist(t, el, subTabs) {
    const [games, keys] = await Promise.all([get(`/tournaments/${t.id}/games`), get("/admin/api-keys")]);
    const steps = [
      ["Create the tournament", true],
      ["Name your teams, pick colors, add logos", t.teams.length > 0 && !t.teams.some((x) => /^Team \d+$/.test(x.name)), "Teams & rosters", () => subTabs.set("teams")],
      ["Put players on every team: upload the draft results CSV", t.teams.length > 0 && t.teams.every((x) => x.player_count > 0), "Upload rosters", () => subTabs.set("import")],
      ["Schedule games", games.length > 0, "Schedule", () => subTabs.set("schedule")],
      ["Create a scorekeeper key for each rink device", keys.some((k) => k.role === "scorekeeper" && !k.revoked_at), "API keys", () => mainTabs.set("keys")],
      ["Score a game", games.some((g) => g.status !== "scheduled"), "Open scorekeeper", () => (location.href = "/scorekeeper")],
    ];
    const done = steps.filter((x) => x[1]).length;
    if (done === steps.length) return mount(el);
    mount(el, h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "Getting started"), h("span", { class: "muted small" }, `${done} of ${steps.length} done`)),
      h("ol", { class: "checklist", style: { marginTop: "12px" } }, steps.map(([label, ok, cta, go], i) =>
        h("li", { class: ok ? "done" : null },
          h("span", { class: "lbl" }, h("span", { class: "tick" }, ok ? "✓" : i + 1), label),
          !ok && cta ? h("button", { class: "sm primary", onclick: go }, cta) : "")))));
  }

  /** Team-name boxes, one per team; typed names are kept when the count changes. Returns { el, count, names() }. */
  function teamNameLines(initial = 4) {
    const typed = [];
    const box = h("div", { class: "team-name-lines" });
    const draw = (n) => {
      for (const [i, el] of [...box.querySelectorAll("input")].entries()) typed[i] = el.value;
      mount(box, range(1, n).map((i) => h("label", { class: "team-line" }, h("span", { class: "team-line-no" }, `${i}`),
        h("input", { value: typed[i - 1] || "", placeholder: `Team ${i}`, maxlength: 80, "aria-label": `Team ${i} name` }))));
    };
    const count = select("num_teams", range(2, 32), initial, { "data-num": 1, onchange: (e) => draw(Number(e.target.value)) });
    draw(initial);
    return { el: box, count, names: () => [...box.querySelectorAll("input")].map((x) => x.value.trim()) };
  }

  // -------------------------------------------------------------------------
  // Leagues: league -> seasons -> divisions; each division in a season is a
  // competition, managed under Tournaments like any other.

  let selectedLeague = null;
  async function leaguesView() {
    const list = await get("/leagues");
    if (!selectedLeague && list.length) selectedLeague = list[0].id;
    const body = h("div");
    const picker = select("league", [["", "— choose —"], ...list.map((l) => [l.id, l.name])], selectedLeague || "", {
      onchange: (e) => { selectedLeague = Number(e.target.value) || null; leaguesView(); } });
    mount(view,
      h("div", { class: "row between", style: { marginBottom: "12px" } },
        h("div", { class: "row" }, h("strong", null, "League"), picker, selectedLeague ? h("a", { href: `/league?id=${selectedLeague}`, target: "_blank" }, "Public page ↗") : ""),
        h("button", { class: "primary", onclick: newLeague }, "New league")),
      body);
    if (!selectedLeague) return mount(body, h("p", { class: "muted" }, "No leagues yet. A league runs seasons; each season has divisions (B, C, D…) with their own teams, schedule and standings."));
    const L = await get(`/leagues/${selectedLeague}`);
    const reload = () => leaguesView();

    const divisionsCard = h("div", { class: "card" }, h("h2", null, "Divisions"),
      h("p", { class: "muted small" }, "Rank 1 is the strongest division. Strength scales production in player ratings (blank = from the rank: 1.00, 0.85, 0.70 …)."),
      table([
        { key: "name", label: "Division" }, { key: "rank", label: "Rank", num: true },
        { key: "strength_used", label: "Strength", num: true, fmt: (d) => `${d.strength_used}${d.strength == null ? " (auto)" : ""}` },
        { key: "x", label: "", sort: false, fmt: (d) => h("div", { class: "row" },
          h("button", { class: "sm", onclick: async () => {
            const v = await formSheet(`${d.name} division`, [
              { name: "name", label: "Name", value: d.name, required: true },
              { name: "rank", label: "Rank (1 = strongest)", type: "number", value: d.rank, min: 1, max: 20 },
              { name: "strength", label: "Strength for ratings (blank = automatic)", value: d.strength ?? "", placeholder: "e.g. 0.85" },
            ]);
            if (!v) return;
            await run(() => api("PATCH", `/leagues/${L.id}/divisions/${d.id}`, { ...v, strength: v.strength === null ? null : Number(v.strength) }), "Saved");
            reload();
          } }, "Edit"),
          h("button", { class: "sm danger", onclick: async () => {
            await run(() => api("DELETE", `/leagues/${L.id}/divisions/${d.id}`), "Removed");
            reload();
          } }, "Remove")) },
      ], L.divisions, { sortKey: "rank", sortDir: 1 }),
      h("button", { style: { marginTop: "8px" }, onclick: async () => {
        const v = await formSheet("Add a division", [{ name: "name", label: "Name", required: true, placeholder: "e.g. C" }], { submitLabel: "Add" });
        if (!v) return;
        await run(() => api("POST", `/leagues/${L.id}/divisions`, v), "Division added");
        reload();
      } }, "Add a division"));

    const startDivision = async (season, d) => {
      const lines = teamNameLines(4);
      const err = h("div", { class: "notice error hidden" });
      const { close } = BLST.openSheet(`${d.name} division · ${season.name}`, h("div", { class: "stack" },
        h("p", { class: "muted small", style: { margin: 0 } }, "Teams with the same name as last season carry over (record and players)."),
        field("Number of teams", lines.count), lines.el, err), (c) => [
        h("button", { type: "button", onclick: () => c(null) }, "Cancel"),
        h("button", { type: "button", class: "primary", onclick: async () => {
          try {
            const comp = await api("POST", `/leagues/${L.id}/seasons/${season.id}/divisions/${d.id}`, { num_teams: Number(lines.count.value), team_names: lines.names() });
            close(comp);
          } catch (e) {
            err.textContent = e.message;
            err.classList.remove("hidden");
          }
        } }, "Start division"),
      ], { onClose: (comp) => { if (comp) { toast(`${comp.name} created`); reload(); } } });
    };

    const seasonsCard = h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "Seasons"),
        h("button", { class: "primary", onclick: async () => {
          const v = await formSheet("New season", [
            { name: "name", label: "Name", placeholder: "e.g. 2026 or Fall 2026" }, { name: "year", label: "Year", type: "number", value: new Date().getFullYear() },
            { name: "start_date", label: "Starts", type: "date" }, { name: "end_date", label: "Ends", type: "date" },
          ], { submitLabel: "Add season" });
          if (!v) return;
          await run(() => api("POST", `/leagues/${L.id}/seasons`, v), "Season added");
          reload();
        } }, "New season")),
      L.seasons.length ? h("ul", { class: "card-list", style: { marginTop: "12px" } }, L.seasons.map((season) => h("li", { class: "card" },
        h("div", { class: "row between" }, h("strong", null, season.name), h("span", { class: "muted small" }, [season.start_date, season.end_date].filter(Boolean).join(" – "))),
        h("ul", { class: "org-list", style: { marginTop: "8px" } }, L.divisions.map((d) => {
          const c = (season.divisions.find((x) => x.division_id === d.id) || {}).competition;
          return h("li", null,
            h("span", null, h("b", null, `${d.name} division`), c ? h("span", { class: "muted small" }, ` · ${c.teams} teams · ${c.games} games${c.live_games ? ` · ${c.live_games} live` : ""}`) : h("span", { class: "muted small" }, " · not started")),
            c ? h("div", { class: "row" },
              h("a", { class: "btn sm", href: `#tournaments/${c.id}`, onclick: () => { selectedTid = c.id; setTimeout(() => mainTabs.set("tournaments"), 0); } }, "Teams, schedule & scoring"),
              h("a", { class: "btn sm", href: `/tournament?id=${c.id}`, target: "_blank" }, "Public ↗"))
              : h("button", { class: "sm primary", onclick: () => startDivision(season, d) }, "Start division"));
        }))))) : h("p", { class: "muted" }, "No seasons yet."));

    const s = (await get(`/leagues/${L.id}/ratings`)).settings;
    const RATING_FIELDS = [["goal", "Goal"], ["assist", "Assist"], ["shg", "Short-handed goal (extra)"], ["gwg", "Game-winning goal (extra)"], ["ppg", "Power-play goal (extra)"],
      ["pim", "Per penalty minute (subtract)"], ["recency_decay", "Each older season counts ×"], ["skater_prior_games", "Skater sample-size cushion (games)"],
      ["goalie_prior_games", "Goalie sample-size cushion (games)"], ["goalie_sv_weight", "Goalies: weight of save % (0–1)"], ["min_games", "Minimum games to be rated"]];
    const ratingCard = h("div", { class: "card" }, h("h2", null, "Player rating weights"),
      h("p", { class: "muted small" }, "Production per game = goals × goal weight + assists × assist weight + the extras, then × division strength. Recent seasons count most; the cushion blends in league-average games so small samples don't top the list. Ratings are percentiles (0–100) within the league."),
      h("form", { class: "form", onsubmit: async (e) => {
        e.preventDefault();
        await run(() => api("PUT", `/leagues/${L.id}/rating-settings`, values(e.target)), "Rating weights saved");
      } }, RATING_FIELDS.map(([k, label]) => field(label, input(k, { type: "number", step: "0.05", value: s[k] }))),
      h("div", { class: "wide" }, h("button", { class: "primary" }, "Save weights"))));

    mount(body, seasonsCard, divisionsCard, ratingCard);
  }

  async function newLeague() {
    const v = await formSheet("New league", [
      { name: "name", label: "Name", required: true, placeholder: "Metro Beer League" },
      { name: "short_name", label: "Short name (optional)", placeholder: "Metro" },
      { name: "divisions", label: "Divisions, strongest first", value: "B, C, D" },
    ], { submitLabel: "Create league" });
    if (!v) return;
    const l = await run(() => api("POST", "/leagues", { name: v.name, short_name: v.short_name, divisions: String(v.divisions || "").split(",").map((x) => x.trim()).filter(Boolean) }), "League created");
    selectedLeague = l.id;
    leaguesView();
  }

  /** Tournament type: draft (teams drafted fresh) or team (the same teams carry over). */
  function typeChooser(value) {
    const opt = (v, title, text) => h("label", { class: `type-option${value === v ? " on" : ""}` },
      h("input", { type: "radio", name: "format", value: v, checked: value === v,
        onchange: (e) => { for (const el of e.target.closest(".type-choice").querySelectorAll(".type-option")) el.classList.toggle("on", el.contains(e.target)); } }),
      h("span", null, h("strong", null, title), h("span", { class: "small muted" }, text)));
    return h("fieldset", { class: "type-choice wide" }, h("legend", null, "Team format"),
      opt("draft", "Draft", "Teams are drafted fresh each time. Stats follow each player."),
      opt("team", "Team", "The same teams play each time. Teams keep their record and players across tournaments."));
  }

  /** The organization's tournament types (DEX, Bash, …): with city and year, the Tournament ID. */
  function seriesField(value) {
    const types = (BLST.org && BLST.org.tournament_types) || [];
    const opts = [["", "—"], ...types.map((x) => [x, x])];
    if (value && !types.includes(value)) opts.push([value, value]);
    return field("Tournament type", types.length ? select("series", opts, value || "") : input("series", { value: value || "", placeholder: "e.g. DEX", maxlength: 30 }));
  }

  function tournamentFormFields(t = {}) {
    return [
      field("Name", input("name", { required: true, value: t.name || "", placeholder: "Fall Classic" }), "wide"),
      field("Season", input("season", { value: t.season || "" })),
      typeChooser(t.format || "draft"),
      field("City", input("location", { value: t.location || "" })),
      seriesField(t.series),
      field("Year", input("year", { type: "number", min: 1950, max: 2100, value: t.year || "", "data-num": 1 })),
      field("Start date", input("start_date", { type: "date", value: t.start_date || "" })),
      field("End date", input("end_date", { type: "date", value: t.end_date || "" })),
      field("Periods", select("periods", [1, 2, 3, 4], t.periods || 3, { "data-num": 1 })),
      field("Period length (min)", input("period_length_min", { type: "number", min: 1, max: 60, step: "0.5", value: t.period_length_sec ? t.period_length_sec / 60 : 15 })),
      field("Overtime length (min, 0 = none)", input("ot_length_min", { type: "number", min: 0, max: 60, step: "0.5", value: t.ot_length_sec != null ? t.ot_length_sec / 60 : 5 })),
      field("Skaters per side", select("skaters_per_side", [3, 4, 5, 6], t.skaters_per_side || 5, { "data-num": 1 })),
      field("Points: win", input("points_win", { type: "number", min: 0, max: 10, value: t.points_win ?? 2 })),
      field("Points: OT/SO loss", input("points_otl", { type: "number", min: 0, max: 10, value: t.points_otl ?? 1 })),
      field("Points: tie", input("points_tie", { type: "number", min: 0, max: 10, value: t.points_tie ?? 1 })),
      h("label", { class: "inline" }, h("input", { type: "checkbox", name: "allow_ties", checked: Boolean(t.allow_ties) }), "Allow tie games"),
    ];
  }

  function newTournamentForm() {
    // One name box per team; typed names are kept when the count changes.
    const typed = [];
    const namesBox = h("div", { class: "team-name-lines" });
    const drawNames = (n) => {
      for (const [i, el] of [...namesBox.querySelectorAll("input")].entries()) typed[i] = el.value;
      mount(namesBox, range(1, n).map((i) => h("label", { class: "team-line" },
        h("span", { class: "team-line-no" }, `${i}`),
        h("input", { "data-team-name": "1", value: typed[i - 1] || "", placeholder: `Team ${i}`, maxlength: 80, "aria-label": `Team ${i} name` }))));
    };
    const count = select("num_teams", range(2, 32), 4, { "data-num": 1, onchange: (e) => drawNames(Number(e.target.value)) });
    drawNames(4);
    return h("div", { class: "card" }, h("h2", null, "New tournament"),
      h("form", { class: "form", onsubmit: async (e) => {
        e.preventDefault();
        const v = values(e.target);
        // Blank lines keep their place ("Team 3"), so names line up with their slot.
        const lines = [...namesBox.querySelectorAll("input")].map((el) => el.value.trim());
        const last = lines.reduce((a, x, i) => (x ? i : a), -1);
        const team_names = lines.slice(0, last + 1).map((x, i) => x || `Team ${i + 1}`);
        const t = await run(() => api("POST", "/tournaments", { ...v, team_names }), "Tournament created");
        selectedTid = t.id;
        history.replaceState(null, "", `#tournaments/${t.id}`);
        tournamentsView();
      } },
        ...tournamentFormFields(),
        field("Number of teams", count),
        h("div", { class: "wide" }, h("div", { class: "field-label" }, "Team names ", h("span", { class: "muted small" }, "(leave blank for Team 1, Team 2, …)")), namesBox),
        h("div", { class: "wide" }, h("button", { class: "primary" }, "Create tournament"))));
  }

  async function tournamentSub(tab, t, el) {
    mount(el, h("p", { class: "muted" }, "Loading…"));
    try {
      if (tab === "teams") await teamsView(t, el);
      if (tab === "schedule") await scheduleView(t, el);
      if (tab === "import") rosterImportView(t, el);
      if (tab === "moves") await movesView(t, el);
      if (tab === "streams") await streamsView(t, el);
      if (tab === "registrations") await registrationsView(t, el);
      if (tab === "settings") settingsView(t, el);
    } catch (err) {
      mount(el, h("p", { class: "notice error" }, err.message));
    }
  }

  function settingsView(t, el) {
    mount(el,
      h("div", { class: "card" }, h("h2", null, "Tournament logo"),
        h("p", { class: "muted small" }, "Shown on the tournament page and the home page. Team logos are set on each team's card under Teams & rosters."),
        BLST.logoEditor("tournaments", t, null, { label: "Tournament logo" })),
      h("div", { class: "card" }, h("h2", null, "Settings"),
        h("p", { class: "small" }, "Tournament ID: ", t.code ? h("strong", { class: "mono" }, t.code) : h("span", { class: "muted" }, "set the city, tournament type and year to get one (historical uploads use it)")),
      h("form", { class: "form", onsubmit: async (e) => {
        e.preventDefault();
        await run(() => api("PATCH", `/tournaments/${t.id}`, values(e.target, { blankAsNull: true })), "Saved");
        tournamentsView();
      } },
        ...tournamentFormFields(t),
        field("Status", select("status", ["upcoming", "active", "completed"], t.status)),
        h("div", { class: "wide row" }, h("button", { class: "primary" }, "Save settings"))),
      h("hr", { style: { margin: "20px 0", border: 0, borderTop: "1px solid var(--border)" } }),
      h("button", { class: "danger", onclick: async () => {
        const ok = await formSheet("Delete tournament", [{ name: "name", label: `Type "${t.name}" to confirm`, required: true }], {
          intro: "This permanently deletes the tournament with all of its teams, games, events and stats. Players and imported history are kept.",
          submitLabel: "Delete forever", danger: true,
          validate: (v) => (v.name === t.name ? null : "The name doesn't match"),
        });
        if (!ok) return;
        await run(() => api("DELETE", `/tournaments/${t.id}?confirm=true`), "Deleted");
        selectedTid = null;
        tournamentsView();
      } }, "Delete tournament…")));
  }

  async function teamsView(t, el) {
    const teams = await get(`/tournaments/${t.id}/teams`);
    const refresh = () => tournamentSub("teams", t, el);
    const numSelect = select("num_teams", range(2, 32), teams.length);

    const teamCard = (team) => {
      return h("div", { class: "card" },
        BLST.logoEditor("teams", team, null, { label: "Team logo" }),
        h("div", { style: { height: "12px" } }),
        h("form", { class: "form", onsubmit: async (e) => {
          e.preventDefault();
          await run(() => api("PATCH", `/teams/${team.id}`, values(e.target, { blankAsNull: true })), "Team saved");
          refresh();
        } },
          field("Name", input("name", { value: team.name, required: true })),
          field("Short", input("short_name", { value: team.short_name || "", maxlength: 12, style: { width: "90px" } })),
          field("Color", input("color", { type: "color", value: team.color || "#56627a" })),
          field("Seed", input("seed", { type: "number", min: 1, value: team.seed ?? "" })),
          field("Final place", input("final_placement", { type: "number", min: 1, value: team.final_placement ?? "", title: "Set after playoffs; 1 = champion" })),
          h("div", { class: "row" }, h("button", { class: "sm" }, "Save"),
            h("button", { type: "button", class: "sm danger", onclick: async () => {
              if (!(await confirmSheet(`Delete ${team.name}? Its players come off the roster (they aren't deleted).`, { title: "Delete team", confirmLabel: "Delete", danger: true }))) return;
              await run(() => api("DELETE", `/teams/${team.id}`), "Team deleted");
              refresh();
            } }, "Delete"))),
        h("div", { style: { height: "10px" } }),
        table([
          { key: "jersey_number", label: "#", num: true },
          { key: "last_name", label: "Player", fmt: (r) => h("span", null, `${r.first_name} ${r.last_name}`, r.role ? ` (${r.role})` : "") },
          { key: "position", label: "Pos" },
          { key: "edit", label: "", sort: false, fmt: () => "Edit ›" },
        ], team.roster, { sortKey: "jersey_number", sortDir: 1, rowClass: () => "tap", onRow: (r) => editRosterEntry(r, team) }));
    };

    function editRosterEntry(r, team) {
      const num = input("jersey_number", { type: "number", inputmode: "numeric", min: 0, max: 99, value: r.jersey_number ?? "" });
      const pos = select("position", [["", "—"], "C", "LW", "RW", "F", "D", "G"], r.position || "");
      const role = select("role", [["", "—"], ["C", "Captain"], ["A", "Alternate"]], r.role || "");
      const teamSel = select("team", teams.map((x) => [x.id, x.id === team.id ? `${x.name} (current)` : x.name]), team.id);
      const reason = input("reason", { placeholder: "e.g. balancing teams" });
      const reasonRow = field("Reason for the move (optional)", reason, "hidden");
      const taken = h("span", { class: "small muted" });
      const showTaken = () => {
        const target = teams.find((x) => x.id === Number(teamSel.value));
        const nums = target.roster.filter((x) => x.id !== r.id && x.jersey_number != null).map((x) => x.jersey_number).sort((a, b) => a - b);
        taken.textContent = nums.length ? `Taken on ${target.short_name || target.name}: ${nums.join(", ")}` : "";
        const clash = nums.includes(num.value === "" ? null : Number(num.value));
        taken.style.color = clash ? "var(--danger)" : "";
      };
      teamSel.addEventListener("change", () => {
        reasonRow.classList.toggle("hidden", Number(teamSel.value) === team.id);
        showTaken();
      });
      num.addEventListener("input", showTaken);
      const err = h("div", { class: "notice error hidden" });
      openSheet(`#${r.jersey_number ?? "?"} ${r.first_name} ${r.last_name}`, h("div", { class: "stack" },
        h("label", null, "Jersey number", num, taken), field("Position", pos), field("Captain / alternate", role),
        field("Team", teamSel, null), reasonRow,
        h("p", { class: "muted small", style: { margin: 0 } }, "Moving keeps stats from games already played with the old team."), err), (close) => [
        h("button", { type: "button", class: "danger", style: { marginRight: "auto" }, onclick: async () => {
          close();
          if (!(await confirmSheet(`Take ${r.first_name} ${r.last_name} off ${team.name}? They stay in the player database.`, { title: "Remove from team", confirmLabel: "Remove", danger: true }))) return;
          await run(() => api("DELETE", `/roster/${r.roster_entry_id}`), "Removed");
          refresh();
        } }, "Remove"),
        h("button", { type: "button", onclick: () => close() }, "Cancel"),
        h("button", { type: "button", class: "primary", onclick: async () => {
          const number = num.value === "" ? null : Number(num.value);
          const to = Number(teamSel.value);
          try {
            if (to !== team.id) {
              await api("POST", `/tournaments/${t.id}/roster/move`, { player_id: r.id, to_team_id: to, jersey_number: number, reason: reason.value || undefined });
              await api("PATCH", `/roster/${r.roster_entry_id}`, { position: pos.value || null, role: role.value || null });
              toast(`Moved to ${teams.find((x) => x.id === to).name}`);
            } else {
              await api("PATCH", `/roster/${r.roster_entry_id}`, { jersey_number: number, position: pos.value || null, role: role.value || null });
              toast("Saved");
            }
            close();
            refresh();
          } catch (e) {
            err.textContent = e.message;
            err.classList.remove("hidden");
          }
        } }, "Save"),
      ]);
    }

    // Add player: search existing or create new.
    const results = h("div", { class: "stack", style: { marginTop: "8px" } });
    const addForm = h("form", { class: "form" },
      field("Team", select("team_id", teams.map((x) => [x.id, x.name]), teams[0]?.id, { "data-num": 1 })),
      field("Jersey #", input("jersey_number", { type: "number", min: 0, max: 99 })),
      field("Position", select("position", [["", "—"], "C", "LW", "RW", "F", "D", "G"], "")),
      field("Role", select("role", [["", "—"], ["C", "Captain"], ["A", "Alternate"]], "")));
    const search = h("input", { placeholder: "Search existing players by name…", style: { minWidth: "260px" } });
    search.addEventListener("input", debounce(async () => {
      const q = search.value.trim();
      if (q.length < 2) return mount(results);
      const found = await get(`/players?q=${encodeURIComponent(q)}&limit=10`);
      mount(results, found.length ? found.map((p) => h("div", { class: "row between" }, `${p.first_name} ${p.last_name}${p.position ? ` · ${p.position}` : ""}${p.email ? ` · ${p.email}` : ""}`,
        h("button", { class: "sm primary", onclick: async () => {
          const v = values(addForm);
          await run(() => api("POST", `/tournaments/${t.id}/roster`, { player_id: p.id, ...v, jersey_number: v.jersey_number ?? p.preferred_number ?? undefined, position: v.position }), "Added");
          refresh();
        } }, "Add to team"))) : h("div", { class: "muted small" }, "No match — create the player below."));
    }, 250));
    const createForm = h("form", { class: "form", onsubmit: async (e) => {
      e.preventDefault();
      const pv = values(e.target);
      const rv = values(addForm);
      const player = await run(() => api("POST", "/players", { ...pv, position: rv.position, preferred_number: rv.jersey_number }));
      await run(() => api("POST", `/tournaments/${t.id}/roster`, { player_id: player.id, ...rv }), "Player created and added");
      refresh();
    } },
      field("First name", input("first_name", { required: true })),
      field("Last name", input("last_name", { required: true })),
      field("Email", input("email", { type: "email" })),
      field("Shoots", select("shoots", [["", "—"], "L", "R"], "")),
      h("div", null, h("button", { class: "primary" }, "Create & add")));

    mount(el,
      h("div", { class: "card" },
        h("div", { class: "row" }, h("strong", null, "Number of teams"), numSelect,
          h("button", { onclick: async () => {
            await run(() => api("PATCH", `/tournaments/${t.id}`, { num_teams: Number(numSelect.value) }), "Team count updated");
            refresh();
          } }, "Apply"),
          h("span", { class: "muted small" }, "Adding creates placeholder teams you can rename. Removing only drops empty teams with no games."))),
      h("div", { class: "card" }, h("h2", null, "Add a player"), addForm, h("div", { style: { height: "10px" } }), search, results,
        h("details", { style: { marginTop: "10px" } }, h("summary", null, "New player"), h("div", { style: { marginTop: "10px" } }, createForm))),
      h("div", { class: "teamgrid" }, teams.map(teamCard)));
  }

  async function scheduleView(t, el) {
    const [games, teams] = await Promise.all([get(`/tournaments/${t.id}/games`), get(`/tournaments/${t.id}/teams`)]);
    const refresh = () => tournamentSub("schedule", t, el);
    const teamOpts = teams.map((x) => [x.id, x.name]);
    mount(el,
      h("div", { class: "grid two" },
        h("div", { class: "card" }, h("h2", null, "Add a game"),
          h("form", { class: "form", onsubmit: async (e) => {
            e.preventDefault();
            await run(() => api("POST", `/tournaments/${t.id}/games`, values(e.target)), "Game added");
            refresh();
          } },
            field("Away", select("away_team_id", teamOpts, teams[1]?.id, { "data-num": 1 })),
            field("Home", select("home_team_id", teamOpts, teams[0]?.id, { "data-num": 1 })),
            field("Start", input("scheduled_at", { type: "datetime-local" })),
            field("Rink", input("venue")),
            field("Type", select("game_type", [["pool", "Pool play"], ["playoff", "Playoff"], ["final", "Final"], ["exhibition", "Exhibition"]], "pool")),
            h("div", null, h("button", { class: "primary" }, "Add game")))),
        h("div", { class: "card" }, h("h2", null, "Generate round robin"),
          h("form", { class: "form", onsubmit: async (e) => {
            e.preventDefault();
            const created = await run(() => api("POST", `/tournaments/${t.id}/schedule/round-robin`, values(e.target)));
            toast(`${created.length} games created`);
            refresh();
          } },
            field("First game", input("start_at", { type: "datetime-local" })),
            field("Minutes between games", input("interval_minutes", { type: "number", min: 0, value: 75 })),
            field("Times each pair meets", select("rounds", [1, 2, 3], 1, { "data-num": 1 })),
            field("Rink", input("venue")),
            h("div", null, h("button", null, "Generate"))))),
      h("div", { class: "card" }, h("h2", null, "Games"),
        table([
          { key: "scheduled_at", label: "When", fmt: (g) => fmtDate(g.scheduled_at) },
          { key: "matchup", label: "Game", sort: false, fmt: (g) => h("span", null, BLST.gameTeamMark(g, "away"), g.away_team, " @ ", BLST.gameTeamMark(g, "home"), g.home_team) },
          { key: "game_type", label: "Type" },
          { key: "status", label: "Status", fmt: (g) => statusBadge(g) },
          { key: "score", label: "Score", sort: false, fmt: (g) => (g.status === "scheduled" ? "" : `${g.away_score}–${g.home_score}`) },
          { key: "actions", label: "", sort: false, fmt: (g) => h("div", { class: "row", style: { justifyContent: "flex-end" } },
            h("a", { class: "btn sm", href: `/scorekeeper?game=${g.id}` }, "Score"),
            h("button", { class: "sm", onclick: async () => {
              const saved = await BLST.officialsEditor(g.id);
              if (saved) toast(saved.length ? `Officials saved: ${BLST.officialsText(saved)}` : "Officials cleared");
            } }, "Officials"),
            h("a", { class: "btn sm", href: `/game?id=${g.id}`, target: "_blank" }, "View"),
            h("button", { class: "sm", onclick: async () => {
              const v = await formSheet(`${g.away_team} @ ${g.home_team}`, [
                { name: "scheduled_at", label: "Start time", type: "datetime", value: g.scheduled_at },
                { name: "venue", label: "Rink", value: g.venue || "" },
                { name: "game_type", label: "Type", type: "select", value: g.game_type, options: [["pool", "Pool play"], ["playoff", "Playoff"], ["final", "Final"], ["exhibition", "Exhibition"]] },
                { name: "livebarn_url", label: "LiveBarn link for this game (optional)", value: g.livebarn_url || "", placeholder: "Leave blank to use the rink's link from Streams", type: "url" },
                { name: "stream_embed_url", label: "Video embed for this game (optional)", value: g.stream_embed_url || "", placeholder: "YouTube Live, partner embed or .m3u8", type: "url" },
                { name: "stream_delay_sec", label: "Stream delay, seconds (optional)", value: g.stream_delay_sec ?? "", type: "number", min: 0, max: 300 },
              ], { submitLabel: "Save" });
              if (!v) return;
              await run(() => api("PATCH", `/games/${g.id}`, v), "Game updated");
              refresh();
            } }, "Edit"),
            h("button", { class: "sm danger", onclick: async () => {
              const started = g.status !== "scheduled";
              if (!(await confirmSheet(started ? "This game has been played. Deleting it removes all of its events and stats." : "Delete this game from the schedule?", { title: "Delete game", confirmLabel: "Delete", danger: true }))) return;
              await run(() => api("DELETE", `/games/${g.id}${started ? "?force=true" : ""}`), "Deleted");
              refresh();
            } }, "✕")) },
        ], games, { sortKey: "scheduled_at", sortDir: 1 })));
  }

  /**
   * Post-draft roster upload: download a template with the real team names,
   * fill it in (or export the draft sheet), upload, review the preview, import.
   */
  function rosterImportView(t, el) {
    let text = "";
    let fileName = "";
    const hasRosters = t.teams.some((x) => x.player_count > 0);
    const fileInput = h("input", { type: "file", accept: ".csv,text/csv,text/plain,.tsv,.txt", class: "hidden" });
    const area = h("textarea", { placeholder: "team,number,first_name,last_name,position,role,email,round,pick\nVarghona Wolves,9,Sam,Sniper,C,C,sam@example.com,1,3" });
    const chosen = h("div", { class: "muted small" }, "No file chosen yet.");
    const replace = h("input", { type: "checkbox", checked: false });
    const createTeams = h("input", { type: "checkbox" });
    const skip = h("input", { type: "checkbox" });
    const review = h("div");

    async function preview() {
      text = area.value.trim() ? area.value : text;
      if (!text.trim()) return mount(review);
      mount(review, h("div", { class: "card" }, h("p", { class: "muted" }, "Checking the file…")));
      const body = importPayload(text, { dry_run: true, replace: replace.checked, create_missing_teams: createTeams.checked, skip_errors: skip.checked });
      try {
        renderReview(await api("POST", `/import/roster/${t.id}`, body), body);
      } catch (err) {
        if (err.data && err.data.errors) renderReview(err.data, body);
        else mount(review, h("div", { class: "card" }, h("p", { class: "notice error" }, err.message)));
      }
    }

    function renderReview(r, body) {
      const pv = r.preview || [];
      const errors = r.errors || [];
      const count = (k) => pv.filter((x) => x.change === k).length;
      const newPlayers = pv.filter((x) => x.new_player).length;
      const pill = (label, cls) => h("span", { class: `badge ${cls || ""}` }, label);
      const byTeam = new Map();
      for (const p of pv) {
        if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, { name: p.team, new_team: p.new_team, players: [] });
        byTeam.get(p.team_id).players.push(p);
      }
      const teamInfo = new Map((r.teams || t.teams).map((x) => [x.id, x]));
      const tag = (p) => {
        if (p.change === "added") return pill(p.new_player ? "new player" : "added", "good");
        if (p.change === "moved") return pill("moved", "pp");
        if (p.change === "updated") return pill("updated");
        return "";
      };
      const draft = (p) => [p.draft_round != null ? `Rd ${p.draft_round}` : null, p.draft_pick != null ? `#${p.draft_pick}` : null].filter(Boolean).join(" ");
      const canImport = pv.length > 0 && (errors.length === 0 || skip.checked);
      mount(review, h("div", { class: "card" },
        h("h2", null, "Review"),
        h("div", { class: "summary-pills" },
          pill(`${pv.length} player${pv.length === 1 ? "" : "s"}`),
          newPlayers ? pill(`${newPlayers} new to BLST`, "good") : "",
          count("moved") ? pill(`${count("moved")} changing teams`, "pp") : "",
          r.removed && r.removed.length ? pill(`${r.removed.length} coming off rosters`, "bad") : "",
          r.created_teams ? pill(`${r.created_teams} new team${r.created_teams === 1 ? "" : "s"}`, "good") : "",
          r.skipped_blank ? pill(`${r.skipped_blank} blank line${r.skipped_blank === 1 ? "" : "s"} skipped`) : "",
          r.unassigned && r.unassigned.length ? pill(`${r.unassigned.length} not on a team`, "pp") : "",
          errors.length ? pill(`${errors.length} problem${errors.length === 1 ? "" : "s"}`, "bad") : pill("no problems", "good")),
        errors.length ? h("div", { class: "notice error", style: { marginBottom: "12px" } },
          h("strong", null, skip.checked ? "These rows will be skipped:" : "Fix these in your file and choose it again (or tick “skip rows with problems”):"),
          h("ul", { class: "small", style: { margin: "6px 0 0" } }, errors.slice(0, 40).map((e) => h("li", null, `Line ${e.row}: ${e.error}`))),
          errors.length > 40 ? h("div", { class: "small" }, `…and ${errors.length - 40} more`) : "") : "",
        r.replace_skipped ? h("p", { class: "notice" }, "Nobody will be taken off a roster while the file has problems.") : "",
        h("div", { class: "preview-teams" }, [...byTeam.entries()].map(([teamId, tm]) =>
          h("div", { class: "card" },
            h("h3", { class: "title-row" }, BLST.teamMark(teamInfo.get(teamId) || { id: teamId }, "md") || "", tm.name, tm.new_team ? pill("new team", "good") : "",
              h("span", { class: "muted small", style: { marginLeft: "auto" } }, `${tm.players.length}`)),
            h("ul", null, tm.players.sort((a, b) => (a.number ?? 999) - (b.number ?? 999)).map((p) =>
              h("li", { class: p.number_error ? "err" : null },
                h("span", { class: "n" }, p.number != null ? `#${p.number}` : "–"),
                h("span", null, p.name, p.role ? h("strong", null, ` (${p.role})`) : "", p.position ? h("span", { class: "muted" }, ` ${p.position}`) : "",
                  draft(p) ? h("span", { class: "muted small" }, ` · ${draft(p)}`) : ""),
                h("span", { class: "tag" }, tag(p)))))))),
        r.removed && r.removed.length ? h("details", { style: { marginTop: "12px" } },
          h("summary", null, `${r.removed.length} player(s) not in the file will come off their teams`),
          h("ul", { class: "small" }, r.removed.map((x) => h("li", null, `${x.name} (${x.team}${x.number != null ? ` #${x.number}` : ""})`)))) : "",
        h("div", { class: "row", style: { marginTop: "14px" } },
          h("button", { class: "primary", disabled: !canImport, onclick: async () => {
            try {
              const done = await api("POST", `/import/roster/${t.id}`, { ...body, dry_run: false });
              toast(`Imported ${done.imported} players`);
              mount(review, h("div", { class: "card" },
                h("p", { class: "notice" }, h("strong", null, "Rosters saved. "), `${done.imported} players imported${done.removed && done.removed.length ? `, ${done.removed.length} taken off rosters` : ""}.`),
                h("div", { class: "row" }, h("button", { class: "primary", onclick: () => tournamentsView() }, "See the teams"),
                  h("a", { class: "btn", href: `/tournament?id=${t.id}#teams`, target: "_blank" }, "Public rosters ↗"))));
            } catch (err) {
              if (err.data && err.data.errors) renderReview(err.data, body);
              else toast(err.message, true);
            }
          } }, `Import ${pv.length} player${pv.length === 1 ? "" : "s"}`),
          !canImport && errors.length ? h("span", { class: "muted small" }, "Fix the problems above to import.") : "")));
    }

    fileInput.addEventListener("change", async () => {
      const f = fileInput.files[0];
      fileInput.value = "";
      if (!f) return;
      if (/\.xlsx?$/i.test(f.name)) return toast("That's an Excel file: in Excel use File → Save As → CSV, then choose the CSV", true);
      text = await f.text();
      area.value = "";
      fileName = f.name;
      mount(chosen, h("strong", null, fileName), ` · ${text.split(/\r?\n/).filter((l) => l.trim()).length - 1} lines`);
      preview();
    });
    for (const box of [replace, createTeams, skip]) box.addEventListener("change", preview);
    area.addEventListener("input", debounce(() => { if (area.value.trim()) { fileName = ""; mount(chosen, "Using pasted text."); preview(); } }, 600));

    mount(el, h("div", { class: "steps" },
      h("div", { class: "card" }, h("h2", null, "Get the template"),
        h("p", { class: "muted" }, "One line per player: team, jersey number, name, and optionally position, C/A, email (needed for Factions), draft round and pick. Your own draft spreadsheet works too if its columns are named like these."),
        h("div", { class: "row" },
          h("button", { class: "primary", onclick: () => BLST.downloadAuthed(`/tournaments/${t.id}/roster.csv?template=1`, "roster-template.csv").catch((e) => toast(e.message, true)) }, "Download template"),
          hasRosters ? h("button", { onclick: () => BLST.downloadAuthed(`/tournaments/${t.id}/roster.csv`, "rosters.csv").catch((e) => toast(e.message, true)) }, "Download current rosters") : ""),
        h("p", { class: "small muted", style: { marginBottom: 0 } }, "Team names must match: ", t.teams.map((x) => x.name).join(", "),
          ". Google Sheets: File → Download → CSV. Excel: File → Save As → CSV. Numbers app: File → Export To → CSV.")),
      h("div", { class: "card" }, h("h2", null, "Upload the draft results"),
        h("div", { class: "row" }, h("button", { class: "primary", onclick: () => fileInput.click() }, "Choose CSV file…"), chosen, fileInput),
        h("details", { style: { marginTop: "10px" } }, h("summary", null, "…or paste from a spreadsheet"), area),
        h("div", { class: "stack", style: { marginTop: "12px" } },
          h("label", { class: "inline" }, replace, h("span", null, h("strong", null, "Replace current rosters with this file"), h("span", { class: "muted small" }, " · anyone not in the file comes off their team (use this for the final draft results)"))),
          h("label", { class: "inline" }, createTeams, "Create teams that don't exist yet"),
          h("label", { class: "inline" }, skip, "Skip rows with problems and import the rest"))),
      review));
  }

  /**
   * Registrations: each player gets a code for this tournament; returning
   * players are matched to their existing record (history, other events).
   */
  async function registrationsView(t, el) {
    const [regs, la] = await Promise.all([get(`/tournaments/${t.id}/registrations`), get("/integrations/leagueapps").catch(() => null)]);
    const refresh = () => tournamentSub("registrations", t, el);
    const active = regs.filter((r) => r.status === "active");
    const review = regs.filter((r) => r.needs_review);
    const returning = active.filter((r) => r.has_history);
    const pill = (text, cls) => h("span", { class: `badge ${cls || ""}` }, text);

    const showResult = (r) => openSheet(`Registered: ${r.registration_code}`, h("div", { class: "stack" },
      h("div", { style: { fontSize: "2.2rem", fontWeight: 900, fontFamily: "var(--mono)" } }, r.registration_code),
      h("div", null, `${r.player.first_name} ${r.player.last_name} · player ${r.player.player_code}`),
      r.history && r.history.has_history
        ? h("p", { class: "notice" }, `Returning player: ${r.history.prior_tournaments} other tournament(s), ${r.history.historical_lines} imported stat line(s). Their stats carry over.`)
        : h("p", { class: "muted" }, "New to BLST."),
      r.needs_review ? h("p", { class: "notice error" }, r.review_note || "Check this match in the review list.") : ""),
      (close) => [h("button", { class: "primary", onclick: () => { close(); refresh(); } }, "Done")]);

    async function lookupSheet(code) {
      try {
        const l = await get(`/registrations/lookup?code=${encodeURIComponent(code)}`);
        const p = l.player;
        openSheet(`${p.first_name} ${p.last_name}`, h("div", { class: "stack" },
          h("div", { class: "muted" }, `Player code ${p.player_code}${p.email ? ` · ${p.email}` : ""}${p.birth_date ? ` · born ${String(p.birth_date).slice(0, 10)}` : ""}`),
          h("h3", null, "Tournaments"),
          table([{ key: "registration_code", label: "Code" }, { key: "tournament", label: "Tournament" }, { key: "status", label: "Status" },
            { key: "team", label: "Team", fmt: (x) => (x.team ? `${x.team}${x.jersey_number != null ? ` #${x.jersey_number}` : ""}` : "—") }], l.registrations),
          h("h3", null, "Imported history"),
          l.historical_stats.length ? table([{ key: "season", label: "Season" }, { key: "event_name", label: "Event" }, { key: "gp", label: "GP", num: true },
            { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true }], l.historical_stats) : h("p", { class: "muted" }, "None"),
          h("a", { href: `/player?id=${p.id}`, target: "_blank" }, "Career stats page ↗")),
          (close) => [h("button", { onclick: () => close() }, "Close")]);
      } catch (err) {
        toast(err.message, true);
      }
    }

    async function mergeSheet(r) {
      const sameName = (await get(`/players?q=${encodeURIComponent(r.last_name)}&limit=50`)).filter((p) => p.id !== r.player_id);
      if (!sameName.length) return toast("No other players with that last name to merge with", true);
      const v = await formSheet(`Merge ${r.first_name} ${r.last_name} (${r.player_code})`, [
        { name: "keep", label: "This registration is really the same person as…", type: "select", required: true,
          options: sameName.map((p) => [p.id, `${p.first_name} ${p.last_name} · ${p.player_code}${p.position ? ` · ${p.position}` : ""}`]) },
      ], { submitLabel: "Merge", danger: true, intro: "Everything on this player (registrations, rosters, stats, history) moves to the person you pick, and this duplicate record is deleted. Registration codes stay the same." });
      if (!v) return;
      await run(() => api("POST", `/players/${v.keep}/merge`, { from_player_id: r.player_id }), "Merged");
      refresh();
    }

    // ---- LeagueApps card
    let laCard;
    if (!la || !la.configured) {
      laCard = h("div", { class: "card" }, h("h2", null, "LeagueApps"),
        h("p", { class: "muted" }, "Not connected yet. Ask LeagueApps for a Private API key (Admin Dashboard → Connect → API Settings), then set LEAGUEAPPS_SITE_ID, LEAGUEAPPS_CLIENT_ID and LEAGUEAPPS_PRIVATE_KEY on the server (see README). Until then, export the Registrations Report from LeagueApps as CSV and import it below; it gets the same codes and matching."));
    } else {
      const linked = new Set((t.leagueapps_program_ids || []).map(String));
      const boxes = la.programs.map((p) => {
        const other = (p.tournaments || []).filter((x) => x.id !== t.id);
        return h("label", { class: "inline" }, h("input", { type: "checkbox", value: p.program_id, checked: linked.has(String(p.program_id)) }),
          `${p.name || "Program"} (#${p.program_id}) · last registration activity ${fmtDate(p.last_seen_at, { month: "short", day: "numeric" })}`, other.length ? h("span", { class: "muted small" }, ` · also linked to ${other.map((x) => x.name).join(", ")}`) : "");
      });
      const prefix = input("prefix", { value: t.registration_prefix || "", placeholder: "auto, e.g. FC26", maxlength: 12, style: { width: "140px" } });
      const last = la.last_result;
      laCard = h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "LeagueApps"),
          h("span", { class: "muted small" }, la.last_run_at ? `Last sync ${fmtDate(la.last_run_at)}${la.auto_sync_minutes ? ` · auto every ${la.auto_sync_minutes} min` : ""}` : "Never synced")),
        last ? h("p", { class: "small muted" }, `Last run: ${last.seen} records, ${last.created} new, ${last.updated} updated, ${last.returning} returning, ${last.needs_review} to review, ${last.skipped_unlinked} from other programs${last.errors?.length ? `, ${last.errors.length} errors` : ""}.`) : "",
        h("h3", null, "Programs that feed this tournament"),
        boxes.length ? h("div", { class: "stack" }, boxes) : h("p", { class: "muted small" }, "No programs seen yet: run a sync first, then tick this tournament's program(s)."),
        h("div", { class: "row", style: { marginTop: "10px" } }, field("Registration code prefix", prefix),
          h("button", { class: "primary", onclick: async () => {
            const ids = boxes.map((b) => b.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
            await run(() => api("PUT", `/tournaments/${t.id}/leagueapps`, { program_ids: ids, registration_prefix: prefix.value.trim().toUpperCase() || undefined }), "Saved. Sync to pull registrations");
            t.leagueapps_program_ids = ids;
          } }, "Save links")),
        h("div", { class: "row", style: { marginTop: "12px" } },
          h("button", { class: "primary", onclick: async () => {
            const s = await run(() => api("POST", "/integrations/leagueapps/sync", {}));
            toast(`${s.created} new, ${s.updated} updated, ${s.returning} returning players`);
            refresh();
          } }, "Sync now"),
          h("button", { onclick: async () => {
            try {
              const pv = await get("/integrations/leagueapps/preview");
              const inputs = {};
              openSheet("LeagueApps field check", h("div", { class: "stack" },
                h("p", { class: "muted small" }, `Fields in your registrations: ${pv.record_fields.join(", ")}`),
                pv.mapped[0] ? table(Object.keys(pv.candidates).map((f) => ({ f, from: pv.mapped[0].sources[f], value: pv.mapped[0].record[f] })),
                  [{ key: "f", label: "BLST field" }, { key: "from", label: "Read from", fmt: (x) => x.from || h("span", { style: { color: "var(--danger)" } }, "not found") },
                   { key: "value", label: "First record", fmt: (x) => (x.value == null ? "" : String(x.value)) },
                   { key: "o", label: "Override", sort: false, fmt: (x) => (inputs[x.f] = h("input", { value: pv.override[x.f] || "", placeholder: "field name", style: { width: "140px" } })) }])
                  : h("p", null, "No registrations returned yet.")),
                (close) => [h("button", { onclick: () => close() }, "Close"), h("button", { class: "primary", onclick: async () => {
                  const map = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]).filter(([, v]) => v));
                  await run(() => api("PUT", "/integrations/leagueapps/field-map", { map }), "Field mapping saved");
                  close();
                } }, "Save overrides")]);
            } catch (err) {
              toast(err.message, true);
            }
          } }, "Check field mapping")));
    }

    // ---- walk-up + CSV
    const walkForm = h("form", { class: "form", onsubmit: async (e) => {
      e.preventDefault();
      const r = await run(() => api("POST", `/tournaments/${t.id}/registrations`, values(e.target)));
      e.target.reset();
      showResult(r);
    } },
      field("First name", input("first_name", { required: true })), field("Last name", input("last_name", { required: true })),
      field("Email", input("email", { type: "email" })), field("Birth date", input("birth_date", { type: "date" })),
      field("Position", select("position", [["", "—"], "C", "LW", "RW", "F", "D", "G"], "")),
      h("div", null, h("button", { class: "primary" }, "Register")));
    const csvArea = h("textarea", { placeholder: "First Name,Last Name,Email,Birth Date\nPat,Puck,pat@example.com,3/14/2001", style: { minHeight: "90px" } });
    const csvOut = h("div");
    const csvGo = async (dry) => {
      try {
        const r = await api("POST", `/tournaments/${t.id}/registrations/import`, { ...importPayload(csvArea.value, {}), dry_run: dry });
        mount(csvOut, h("div", { class: `notice ${r.errors.length ? "error" : ""}`, style: { marginTop: "8px" } },
          `${dry ? "Dry run" : "Imported"}: ${r.created} new, ${r.updated} already registered, ${r.returning} returning, ${r.needs_review} to review${r.errors.length ? `, ${r.errors.length} errors: ${r.errors.slice(0, 5).map((e) => `line ${e.row}: ${e.error}`).join("; ")}` : ""}`));
        if (!dry) refresh();
      } catch (err) {
        toast(err.message, true);
      }
    };
    const lookupInput = input("code", { placeholder: "Registration or player code", style: { textTransform: "uppercase" } });

    mount(el,
      h("div", { class: "summary-pills" }, pill(`${active.length} registered`), pill(`${returning.length} returning`, "good"),
        review.length ? pill(`${review.length} to review`, "bad") : pill("nothing to review", "good"),
        pill(`${regs.filter((r) => r.status === "waitlist").length} waitlist`), pill(`${regs.filter((r) => r.status === "cancelled").length} cancelled`)),
      h("div", { class: "card" }, h("div", { class: "row" }, h("strong", null, "Look up a code"), lookupInput,
        h("button", { onclick: () => lookupInput.value.trim() && lookupSheet(lookupInput.value.trim()) }, "Look up"),
        h("span", { class: "spacer" }),
        h("button", { onclick: () => BLST.downloadAuthed(`/tournaments/${t.id}/roster.csv?template=1`, "draft-sheet.csv").catch((e) => toast(e.message, true)) }, "Download draft sheet"))),
      laCard,
      h("div", { class: "grid two" },
        h("div", { class: "card" }, h("h2", null, "Walk-up registration"), walkForm),
        h("div", { class: "card" }, h("h2", null, "Import registrations (CSV)"),
          h("p", { class: "muted small" }, "LeagueApps → Reports → Registrations → Export CSV, or any sheet with first/last name, email and birth date."),
          h("div", { class: "row", style: { marginBottom: "6px" } }, fileLoader(csvArea)), csvArea,
          h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { onclick: () => csvGo(true) }, "Dry run"), h("button", { class: "primary", onclick: () => csvGo(false) }, "Import")),
          csvOut)),
      h("div", { class: "card" }, h("h2", null, "Registered players"),
        h("p", { class: "muted small" }, "Matched automatically by LeagueApps user ID, email + first name, or name + birth date. Name-only or ambiguous matches are flagged: confirm them, or merge duplicates."),
        table([
          { key: "registration_code", label: "Code", fmt: (r) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); lookupSheet(r.registration_code); } }, h("strong", { class: "mono" }, r.registration_code)) },
          { key: "last_name", label: "Player", fmt: (r) => h("span", null, `${r.first_name} ${r.last_name}`, h("div", { class: "muted small" }, r.player_code)) },
          { key: "status", label: "Status", fmt: (r) => (r.status === "active" ? "" : h("span", { class: "badge" }, r.status)) },
          { key: "has_history", label: "History", fmt: (r) => (r.has_history ? h("span", { class: "badge good" }, `Returning · ${r.prior_tournaments} event${r.prior_tournaments === 1 ? "" : "s"}${r.historical_gp ? ` · ${r.historical_gp} GP` : ""}`) : h("span", { class: "muted small" }, "new")) },
          { key: "match_method", label: "Matched by", fmt: (r) => ({ leagueapps_user_id: "LeagueApps ID", email: "email", name_birth_date: "name + birth date", name: "name only", external_id: "external ID", new: "new player" })[r.match_method] || r.match_method },
          { key: "team", label: "Team", fmt: (r) => (r.team ? `${r.team}${r.jersey_number != null ? ` #${r.jersey_number}` : ""}` : h("span", { class: "muted small" }, "undrafted")) },
          { key: "needs_review", label: "", sort: false, fmt: (r) => h("div", { class: "actions" },
            r.needs_review ? [h("span", { class: "badge bad", title: r.review_note || "" }, "review"),
              h("button", { class: "sm", onclick: async () => { await run(() => api("PATCH", `/registrations/${r.id}`, { reviewed: true }), "Confirmed"); refresh(); } }, "OK")] : "",
            h("button", { class: "sm", onclick: () => mergeSheet(r) }, "Merge…"),
            r.status !== "cancelled"
              ? h("button", { class: "sm danger", onclick: async () => { if (await confirmSheet(`Cancel ${r.first_name} ${r.last_name}'s registration (${r.registration_code})?`, { title: "Cancel registration", confirmLabel: "Cancel registration", danger: true })) { await run(() => api("PATCH", `/registrations/${r.id}`, { status: "cancelled" }), "Cancelled"); refresh(); } } }, "Cancel")
              : h("button", { class: "sm", onclick: async () => { await run(() => api("PATCH", `/registrations/${r.id}`, { status: "active" }), "Restored"); refresh(); } }, "Restore")) },
        ], regs, { sortKey: "registration_code", sortDir: 1, rowClass: (r) => (r.status === "cancelled" ? "voided" : null) })));
  }

  /** Rink → video links, plus per-game watch / OBS overlay links. */
  async function streamsView(t, el) {
    const [data, games] = await Promise.all([get(`/tournaments/${t.id}/streams`), get(`/tournaments/${t.id}/games`)]);
    const refresh = () => tournamentSub("streams", t, el);
    const rinks = [...data.streams, ...data.unconfigured_venues.map((venue) => ({ venue, delay_sec: 20 }))];

    const rinkCard = (r) => {
      const lb = input("livebarn_url", { type: "url", value: r.livebarn_url || "", placeholder: "https://livebarn.com/en/video/…" });
      const embed = input("embed_url", { type: "url", value: r.embed_url || "", placeholder: "YouTube Live, partner embed, or .m3u8 link", style: { flex: "1", minWidth: "0" } });
      const delay = input("delay_sec", { type: "number", min: 0, max: 300, value: r.delay_sec ?? 20, style: { width: "110px" } });
      const result = h("div", { class: "small" });
      return h("div", { class: "card" },
        h("div", { class: "row between" }, h("h3", { style: { margin: 0 } }, r.venue), r.id ? h("span", { class: "badge good" }, "set up") : h("span", { class: "badge" }, "not set up")),
        h("div", { class: "stack", style: { marginTop: "10px" } },
          field("LiveBarn link for this rink's camera", lb),
          h("label", null, "Video embed (optional: plays right on BLST)", h("div", { class: "row" }, embed,
            h("button", { type: "button", class: "sm", onclick: async () => {
              if (!embed.value.trim()) return mount(result, h("span", { class: "muted" }, "Paste a link first."));
              mount(result, h("span", { class: "muted" }, "Checking…"));
              try {
                const c = await api("POST", "/streams/check", { url: embed.value.trim() });
                mount(result, h("span", { style: { color: c.embeddable === false ? "var(--danger)" : c.embeddable ? "var(--good)" : "var(--warn)" } },
                  c.embeddable === false ? "✗ " : c.embeddable ? "✓ " : "? ", c.reason));
              } catch (err) {
                mount(result, h("span", { style: { color: "var(--danger)" } }, err.message));
              }
            } }, "Check")), result),
          h("label", null, "Default stream delay (seconds)", delay, h("span", { class: "small muted" }, "How far the video runs behind live. LiveBarn is usually 15–30s; viewers can fine-tune it.")),
          h("div", { class: "row" },
            h("button", { class: "primary", onclick: async () => {
              await run(() => api("PUT", `/tournaments/${t.id}/streams`, { venue: r.venue, livebarn_url: lb.value, embed_url: embed.value, delay_sec: delay.value === "" ? null : Number(delay.value) }), "Saved");
              refresh();
            } }, "Save"),
            r.id ? h("button", { class: "danger", onclick: async () => {
              if (!(await confirmSheet(`Remove the stream links for ${r.venue}?`, { title: "Remove stream", confirmLabel: "Remove", danger: true }))) return;
              await run(() => api("DELETE", `/tournaments/${t.id}/streams/${r.id}`), "Removed");
              refresh();
            } }, "Remove") : "")));
    };

    const newVenue = input("venue", { placeholder: "Rink name, exactly as on the schedule (e.g. Rink A)" });
    const grid = h("div", { class: "teamgrid" }, rinks.map(rinkCard));
    mount(el,
      h("div", { class: "card" }, h("h2", null, "Streams & live overlay"),
        h("p", { class: "muted" }, "Viewers tap ▶ Watch on any game. If the rink has a video embed, the video plays on BLST with the live score overlay on top. If it only has a LiveBarn link, viewers open LiveBarn with their own subscription and BLST shows the live scorebug next to it (pop-out window on a computer, Split View on iPad)."),
        h("p", { class: "muted small" }, "LiveBarn doesn't offer a public embed or API, and its pages can't be shown inside other sites. If LiveBarn gives your league an embed/partner player link for the tournament, paste it as the video embed and use Check. YouTube Live links (your own camera) work as-is.")),
      rinks.length ? "" : h("p", { class: "muted" }, "No rinks yet. Give games a rink on the Schedule tab, or add one below."),
      grid,
      h("div", { class: "card", style: { marginTop: "16px" } }, h("h3", null, "Add a rink"),
        h("div", { class: "row" }, newVenue, h("button", { onclick: () => {
          const v = newVenue.value.trim();
          if (!v) return;
          grid.prepend(rinkCard({ venue: v, delay_sec: 20 }));
          newVenue.value = "";
        } }, "Add"))),
      h("div", { class: "card" }, h("h2", null, "Per-game links"),
        h("p", { class: "muted small" }, "Watch page for fans, and a transparent overlay for OBS / streaming software (Browser Source, 1920×1080). Per-game video overrides are in Schedule → Edit."),
        table([
          { key: "scheduled_at", label: "When", fmt: (g) => fmtDate(g.scheduled_at) },
          { key: "m", label: "Game", sort: false, fmt: (g) => `${g.away_team} @ ${g.home_team}${g.venue ? ` · ${g.venue}` : ""}` },
          { key: "has_stream", label: "Video", fmt: (g) => (g.has_stream ? "✓" : "—") },
          { key: "x", label: "", sort: false, fmt: (g) => h("div", { class: "actions" },
            h("a", { class: "btn sm", href: `/watch?game=${g.id}`, target: "_blank" }, "Watch"),
            h("button", { class: "sm", onclick: async () => {
              const url = `${location.origin}/overlay?game=${g.id}`;
              try {
                await navigator.clipboard.writeText(url);
                toast("Overlay link copied");
              } catch {
                await formSheet("OBS overlay link", [{ name: "u", label: "Copy this link", value: url }], { submitLabel: "Done" });
              }
            } }, "Copy OBS link")) },
        ], games, { sortKey: "scheduled_at", sortDir: 1 })));
  }

  async function movesView(t, el) {
    const moves = await get(`/tournaments/${t.id}/roster/moves`);
    mount(el, h("div", { class: "card" }, h("h2", null, "Roster moves"), table([
      { key: "created_at", label: "When", fmt: (m) => fmtDate(m.created_at) },
      { key: "last_name", label: "Player", fmt: (m) => `${m.first_name} ${m.last_name}` },
      { key: "from_team", label: "From" }, { key: "to_team", label: "To" }, { key: "jersey_number", label: "#", num: true }, { key: "reason", label: "Reason" },
    ], moves, { sortKey: "created_at" })));
  }

  /** Factions points for one tournament or league division (lives in the Factions admin). */
  async function factionsView(t, el) {
    const status = await get("/factions/status");
    const out = h("div");
    const refresh = async () => factionsView(await get(`/tournaments/${t.id}`), el);
    const counts = Boolean(t.factions_event_id);
    const pts = { ...status.default_points, ...(t.factions_points || {}) };
    const ptsForm = h("form", { class: "form", onsubmit: async (e) => {
      e.preventDefault();
      await run(() => api("PATCH", `/tournaments/${t.id}`, { factions_points: values(e.target) }), "Point values saved");
      refresh();
    } }, Object.entries(pts).map(([k, v]) => field(k.replace(/_/g, " "), input(k, { type: "number", value: v, step: 1 }))), h("div", null, h("button", null, "Save point values")));

    const showPreview = async () => {
      const p = await get(`/tournaments/${t.id}/factions/preview`);
      mount(out, h("h3", null, "Points per player"), table([
        { key: "name", label: "Player" },
        { key: "order", label: "Faction", fmt: (r) => (r.order ? BLST.orderBadge(r.order, { link: false }) : h("span", { class: "muted small" }, "no email")) },
        { key: "gp", label: "GP", num: true }, { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true },
        { key: "wins", label: "W", num: true }, { key: "shutouts", label: "SO", num: true }, { key: "placement", label: "Place", num: true },
        { key: "points_earned", label: "Points", num: true },
        { key: "ach", label: "Achievements", sort: false, fmt: (r) => r.achievements.map((a) => a.title.split(" — ")[0]).join(", ") },
      ], p.participation, { sortKey: "points_earned" }));
    };

    mount(el,
      h("div", { class: "card" },
        h("div", { class: "row between" },
          h("h2", { style: { margin: 0 } }, "Factions"),
          counts ? h("span", { class: "badge good" }, "Counts for Factions") : h("span", { class: "badge" }, "Not counting")),
        h("p", { class: "muted" }, counts
          ? `Games in this tournament earn points for each player's faction${status.auto_award ? ", updated every time a game goes final" : ""}. Fans see the result on the Factions page.`
          : "Turn this on and every game here earns Factions points for the players' factions: games played, goals, assists, wins, shutouts, hat tricks and the title."),
        h("div", { class: "row" },
          counts
            ? [h("a", { class: "btn", href: "/factions", target: "_blank" }, "See standings ↗"),
              h("button", { class: "danger", onclick: async () => {
                if (!(await confirmSheet("Stop counting this tournament? Points already awarded stay in Factions.", { title: "Stop counting", confirmLabel: "Stop counting" }))) return;
                await run(() => api("DELETE", `/tournaments/${t.id}/factions/link`), "Stopped counting");
                refresh();
              } }, "Stop counting")]
            : h("button", { class: "primary", onclick: async () => {
              await run(() => api("POST", `/tournaments/${t.id}/factions/link`, {}), "Counting for Factions");
              await api("POST", `/tournaments/${t.id}/factions/award`).catch(() => {});
              refresh();
            } }, "Count this tournament for Factions"))),
      h("div", { class: "card" }, h("h2", null, "Point values"),
        h("p", { class: "muted small" }, "Per player. After playoffs, set each team's final place on Teams & rosters so the champion and runner-up bonuses apply. Hat tricks, shutouts and titles also become achievements."),
        ptsForm,
        h("div", { class: "row", style: { marginTop: "10px" } },
          h("button", { onclick: showPreview }, "Preview points"),
          counts ? h("button", { class: "primary", onclick: async () => {
            const r = await run(() => api("POST", `/tournaments/${t.id}/factions/award`));
            toast(`Awarded ${r.points} points to ${r.awarded} member${r.awarded === 1 ? "" : "s"}${r.skipped_no_email.length ? ` (${r.skipped_no_email.length} without email skipped)` : ""}`);
            showPreview();
          } }, "Recalculate & award now") : ""),
        out));
  }

  // -------------------------------------------------------------------------
  // Players

  async function playersView() {
    const results = h("div");
    const editor = h("div");
    const search = h("input", { placeholder: "Search by name, email or external id…", style: { minWidth: "300px" } });
    const load = async () => {
      const list = await get(`/players?limit=200${search.value.trim() ? `&q=${encodeURIComponent(search.value.trim())}` : ""}`);
      mount(results, table([
        { key: "id", label: "ID", num: true },
        { key: "last_name", label: "Name", fmt: (p) => `${p.first_name} ${p.last_name}` },
        { key: "email", label: "Email" }, { key: "position", label: "Pos" }, { key: "preferred_number", label: "#", num: true },
        { key: "external_id", label: "External ID" }, 
      ], list, { sortKey: "last_name", sortDir: 1, onRow: (p) => editPlayer(p.id) }));
    };
    search.addEventListener("input", debounce(load, 250));

    async function editPlayer(id) {
      const p = await get(`/players/${id}`);
      const hist = await get(`/players/${id}/history`);
      mount(editor, h("div", { class: "card" },
        h("div", { class: "row between" }, h("h2", null, `${p.first_name} ${p.last_name}`), h("a", { href: `/player?id=${id}`, target: "_blank" }, "Public page ↗")),
        h("form", { class: "form", onsubmit: async (e) => {
          e.preventDefault();
          await run(() => api("PATCH", `/players/${id}`, values(e.target, { blankAsNull: true })), "Saved");
          load();
        } }, playerFields(p), h("div", { class: "row" }, h("button", { class: "primary" }, "Save"),
          h("button", { type: "button", class: "danger", onclick: async () => {
            if (!(await confirmSheet(`Delete ${p.first_name} ${p.last_name} from the player database?`, { title: "Delete player", confirmLabel: "Delete", danger: true }))) return;
            try {
              await api("DELETE", `/players/${id}`);
            } catch (err) {
              if (!(await confirmSheet(`${err.message}`, { title: "Player has game records", confirmLabel: "Delete anyway", danger: true }))) return;
              await run(() => api("DELETE", `/players/${id}?force=true`));
            }
            toast("Deleted");
            mount(editor);
            load();
          } }, "Delete"))),
        h("h3", { style: { marginTop: "16px" } }, "Rosters"),
        p.rosters.length ? h("ul", null, p.rosters.map((r) => h("li", null, `${r.tournament}: ${r.team} #${r.jersey_number ?? "?"}`))) : h("p", { class: "muted" }, "Not on any tournament roster"),
        h("h3", null, "Imported history"),
        table([
          { key: "season", label: "Season" }, { key: "event_name", label: "Event" }, { key: "team_name", label: "Team" },
          { key: "gp", label: "GP", num: true }, { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true },
          { key: "goalie_gp", label: "G-GP", num: true }, { key: "source", label: "Source" },
          { key: "x", label: "", sort: false, fmt: (r) => h("button", { class: "sm danger", onclick: async () => { await run(() => api("DELETE", `/history/${r.id}`), "Removed"); editPlayer(id); } }, "✕") },
        ], hist)));
      editor.scrollIntoView({ behavior: "smooth" });
    }

    mount(view,
      h("div", { class: "card" }, h("h2", null, "New player"),
        h("form", { class: "form", onsubmit: async (e) => {
          e.preventDefault();
          const p = await run(() => api("POST", "/players", values(e.target)), "Player created");
          e.target.reset();
          load();
          editPlayer(p.id);
        } }, playerFields({}), h("div", null, h("button", { class: "primary" }, "Create")))),
      h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", null, "Players"), search), results),
      editor);
    load();
  }

  function playerFields(p) {
    return [
      field("First name", input("first_name", { required: true, value: p.first_name || "" })),
      field("Last name", input("last_name", { required: true, value: p.last_name || "" })),
      field("Email", input("email", { type: "email", value: p.email || "" })),
      field("Position", select("position", [["", "—"], "C", "LW", "RW", "F", "D", "G"], p.position || "")),
      field("Shoots", select("shoots", [["", "—"], "L", "R"], p.shoots || "")),
      field("Preferred #", input("preferred_number", { type: "number", min: 0, max: 99, value: p.preferred_number ?? "" })),
      field("External ID", input("external_id", { value: p.external_id || "" })),
    ];
  }

  // -------------------------------------------------------------------------
  // Historical import

  function historyView() {
    const sub = h("div");
    const bar = tabs([["import", "Import stats"], ["match", "Match players"], ["teams", "Teams over time"]],
      (id) => ({ import: importHistoryView, match: matchPlayersView, teams: clubsView })[id](sub).catch((e) => mount(sub, h("p", { class: "notice error" }, e.message))),
      "import", { size: "medium" });
    mount(view, bar.el, sub);
    return importHistoryView(sub);
  }

  async function importHistoryView(view) {
    await BLST.ready;
    const types = (BLST.org && BLST.org.tournament_types) || [];
    const city = input("hi-city", { required: true, placeholder: "Pittsburgh", maxlength: 60, autocomplete: "off" });
    const series = types.length
      ? select("hi-series", [["", "Choose…"], ...types.map((x) => [x, x])], "")
      : input("hi-series", { required: true, placeholder: "e.g. DEX", maxlength: 30 });
    const year = input("hi-year", { type: "number", min: 1950, max: 2100, value: new Date().getFullYear(), required: true });
    const fmt = select("hi-format", [["draft", "Draft (stats follow players)"], ["team", "Team (teams carry over)"]], "draft");
    // Or straight into a league division-season.
    const comps = (await get("/tournaments")).filter((t) => t.kind === "league");
    const intoSel = select("hi-into", [["", "A tournament (city, type and year below)"], ...comps.map((t) => [t.id, `League: ${t.name}`])], "", {
      onchange: () => { tournamentFields.classList.toggle("hidden", Boolean(intoSel.value)); checkId(); } });
    const leagueTarget = () => (intoSel.value ? Number(intoSel.value) : null);
    let tournamentFields;
    const idBox = h("div", { class: "notice small", "aria-live": "polite" }, "Fill in city, type and year to get the Tournament ID.");
    let idState = null;
    const checkId = debounce(async () => {
      idState = null;
      if (leagueTarget()) return mount(idBox, "Stats go into ", h("strong", null, comps.find((t) => t.id === leagueTarget()).name), ". A division-season's stats can be uploaded once; uploading again offers to replace them.");
      if (!city.value.trim() || !series.value || !/^\d{4}$/.test(year.value)) return mount(idBox, "Fill in city, type and year to get the Tournament ID.");
      try {
        const r = await get(`/import/tournament-id?city=${encodeURIComponent(city.value.trim())}&series=${encodeURIComponent(series.value)}&year=${year.value}`);
        idState = r;
        const t = r.tournament;
        mount(idBox, h("strong", { class: "mono" }, r.code), " · ",
          !t ? "a new tournament is created with this upload"
            : t.scored_games ? h("span", { class: "bad-text" }, `${t.name} was scored live in BLST; its stats are already here`)
              : t.uploaded_rows ? h("span", { class: "bad-text" }, `${t.name} already has ${t.uploaded_rows} uploaded rows. Uploading again replaces them.`)
                : `stats go into ${t.name}`);
      } catch (e) {
        mount(idBox, h("span", { class: "bad-text" }, e.message));
      }
    }, 300);
    for (const el of [city, series, year]) el.addEventListener("input", checkId);
    series.addEventListener("change", checkId);
    const area = h("textarea", { placeholder: "name,season,event,team,gp,g,a,pim,+/-\nSam Sniper,2025,Fall Classic,Wolves,10,8,6,4,5" });
    const report = h("div");
    const batches = h("div");
    const source = h("input", { placeholder: "e.g. 2025 league site", value: "" });
    const loadBatches = async () => {
      const list = await get("/import/batches");
      mount(batches, table([
        { key: "imported_at", label: "Imported", fmt: (b) => fmtDate(b.imported_at) }, { key: "tournament", label: "Tournament ID", fmt: (b) => b.tournament || "—" }, { key: "source", label: "Source" },
        { key: "rows", label: "Rows", num: true }, { key: "import_batch", label: "Batch" },
        { key: "x", label: "", sort: false, fmt: (b) => h("button", { class: "sm danger", onclick: async () => {
          if (!(await confirmSheet(`Delete all ${b.rows} stat lines from this import?`, { title: "Undo import", confirmLabel: "Delete rows", danger: true }))) return;
          await run(() => api("DELETE", `/import/batches/${encodeURIComponent(b.import_batch)}`), "Batch deleted");
          loadBatches();
        } }, "Undo import") },
      ], list, { sortKey: "imported_at" }));
    };
    const go = async (dry, replace = false) => {
      if (!leagueTarget() && (!city.value.trim() || !series.value || !/^\d{4}$/.test(year.value))) return toast("Fill in the city, tournament type and year first", true);
      if (!dry && !replace && idState && idState.tournament && idState.tournament.uploaded_rows) {
        if (!(await confirmSheet(`${idState.code} already has ${idState.tournament.uploaded_rows} uploaded rows. Replace them with this file? (The earlier upload's rows are removed, so nothing is counted twice.)`,
          { title: "Replace earlier upload", confirmLabel: "Replace" }))) return;
        replace = true;
      }
      const body = importPayload(area.value, { dry_run: dry, source: source.value || undefined, skip_errors: $("#hi-skip").checked, create_missing_players: $("#hi-create").checked,
        format: fmt.value, replace: replace || undefined,
        ...(leagueTarget() ? { tournament_id: leagueTarget() } : { city: city.value.trim(), series: series.value, year: Number(year.value) }) });
      try {
        mount(report, importReport(await api("POST", "/import/historical", body)));
        if (!dry) { loadBatches(); checkId(); }
      } catch (err) {
        if (err.data && err.data.errors) mount(report, importReport(err.data));
        else if (err.status === 409 && err.data && err.data.details && err.data.details.duplicate) {
          mount(report, h("div", { class: "notice error", style: { marginTop: "10px" } }, err.message,
            h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "primary", onclick: () => go(false, true) }, "Replace the earlier upload"))));
        } else toast(err.message, true);
      }
    };
    mount(view,
      h("div", { class: "card" }, h("h2", null, "Import historical stats"),
        h("p", { class: "muted small" },
          "One row per player per season/event. Recognised columns (case-insensitive, common abbreviations OK): name or first_name/last_name, email, external_id, season, event, team, position, GP, G, A, PIM, +/-, PPG, PPA, SHG, SHA, GWG, SOG, HITS, BLK, FOW, FOL; goalies: GP (or GPI), W, L, OTL, T, SA, GA, SV, SO, MIN (minutes or mm:ss)."),
        h("h3", null, "1. Which tournament?"),
        comps.length ? h("div", { class: "form" }, field("Upload into", intoSel, "wide")) : "",
        (tournamentFields = h("div", { class: "form" }, field("City", city), field("Tournament type", series), field("Year", year), field("Team format (if it's new)", fmt))),
        idBox,
        h("h3", null, "2. The stats file"),
        h("div", { class: "row", style: { marginBottom: "8px" } }, fileLoader(area), field("Source label", source)),
        area,
        h("div", { class: "row" },
          h("label", { class: "inline" }, h("input", { type: "checkbox", id: "hi-create", checked: true }), "Create players that don't exist"),
          h("label", { class: "inline" }, h("input", { type: "checkbox", id: "hi-skip" }), "Skip bad rows"),
          ),

        h("p", { class: "muted small" }, "One file per tournament. Each row is kept with the tournament (its own stats page) and also adds to the player's all-time totals and, for team tournaments, the team's history. Players are matched by registration or player code, email, then name. No emails in the file? That's fine: match them to registered players later under Match players."),
        h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { onclick: () => go(true) }, "Dry run"), h("button", { class: "primary", onclick: () => go(false) }, "Import")),
        report),
      h("div", { class: "card" }, h("h2", null, "Previous imports"), batches));
    loadBatches();
  }

  /** Imported players (often without email) who may be registered players. */
  async function matchPlayersView(view) {
    const [sug] = await Promise.all([get("/admin/identity/suggestions")]);
    const list = h("div");
    const who = (p) => h("div", null,
      h("a", { href: `/player?id=${p.id}`, target: "_blank" }, h("strong", null, p.name)), " ", h("span", { class: "muted small" }, p.player_code),
      h("div", { class: "small muted" }, p.email || "no email",
        p.history_lines ? ` · ${p.history_lines} imported line${p.history_lines === 1 ? "" : "s"}${p.history ? ` (${p.history})` : ""}` : "",
        p.tournaments ? ` · ${p.tournaments} tournament${p.tournaments === 1 ? "" : "s"}` : ""));
    const render = (rows) => mount(list, rows.length
      ? h("ul", { class: "card-list" }, rows.map((s) => h("li", { class: "card match-card" },
        h("div", { class: "match-pair" }, who(s.without_email), h("div", { class: "match-arrow", "aria-hidden": "true" }, "⇄"), who(s.with_email)),
        h("div", { class: "row between" },
          h("span", { class: "badge" }, { "same name": "Same name", nickname: "Nickname", initial: "Initial" }[s.match], s.note ? ` · ${s.note}` : ""),
          h("div", { class: "row" },
            h("button", { class: "sm", onclick: async () => {
              await run(() => api("POST", "/admin/identity/dismiss", { player_a: s.without_email.id, player_b: s.with_email.id }), "Kept apart");
              render(rows.filter((x) => x !== s));
            } }, "Different people"),
            h("button", { class: "sm primary", onclick: async () => {
              if (!(await confirmSheet(`Merge ${s.without_email.name} (${s.without_email.player_code}) into ${s.with_email.name} (${s.with_email.player_code})? All stats move to ${s.with_email.name}. This can't be undone.`, { title: "Same person", confirmLabel: "Merge" }))) return;
              await run(() => api("POST", `/players/${s.with_email.id}/merge`, { from_player_id: s.without_email.id }), "Merged: history now follows this player");
              matchPlayersView(view);
            } }, "Same person: merge"))))))
      : h("p", { class: "muted" }, "No suggestions. Imported players are matched automatically when someone registers with the same name; nicknames and initials show up here."));
    render(sug);

    const area = h("textarea", { placeholder: "player_code,email\nBLP-000123,sam@example.com\n\nor: name,email\nSam Sniper,sam@example.com" });
    const report = h("div");
    const go = async (dry) => {
      try {
        const r = await api("POST", "/admin/identity/emails", { ...importPayload(area.value, {}), dry_run: dry });
        mount(report, h("div", { class: `notice ${r.errors.length ? "error" : ""}`, style: { marginTop: "10px" } },
          h("strong", null, dry ? "Dry run: " : "Done: "), `${r.linked} email${r.linked === 1 ? "" : "s"} attached, ${r.already} already set`,
          r.merge_suggested.length ? h("div", null, h("p", null, "These emails already belong to another player, probably the same person:"),
            h("ul", null, r.merge_suggested.map((m) => h("li", null, `Row ${m.row}: ${m.merge} → ${m.keep} `,
              dry ? "" : h("button", { class: "sm", onclick: async (e) => {
                await run(() => api("POST", `/players/${m.keep_id}/merge`, { from_player_id: m.merge_id }), "Merged");
                e.target.disabled = true;
              } }, "Merge"))))) : "",
          r.errors.length ? h("ul", { class: "small" }, r.errors.slice(0, 50).map((e) => h("li", null, `Row ${e.row}: ${e.error}`))) : ""));
        if (!dry) matchPlayersView(view);
      } catch (err) {
        toast(err.message, true);
      }
    };
    mount(view,
      h("div", { class: "card" }, h("h2", null, "Same person?"),
        h("p", { class: "muted small" }, "Imported players without an email, next to registered players with a similar name. Merge them and every stat follows the one person from then on, whatever team they play for."),
        list),
      h("div", { class: "card" }, h("h2", null, "Attach emails to imported players"),
        h("p", { class: "muted small" }, "A list with a player code (or name) and an email. Later registrations with that email then link to the player and their history automatically. Emails are never overwritten."),
        h("div", { class: "row", style: { marginBottom: "8px" } }, fileLoader(area)),
        area,
        h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { onclick: () => go(true) }, "Dry run"), h("button", { class: "primary", onclick: () => go(false) }, "Attach emails")),
        report));
  }

  /** Teams that carry over between team tournaments. */
  async function clubsView(view) {
    const clubs = await get("/clubs");
    const reload = () => clubsView(view);
    const rec = (r) => `${r.w}-${r.l}-${r.otl}${r.t ? `-${r.t}` : ""}`;
    mount(view, h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "Teams over time"),
        h("button", { class: "primary", onclick: async () => {
          const v = await formSheet("Add a team", [{ name: "name", label: "Name", required: true }, { name: "short_name", label: "Short name (optional)" }], { submitLabel: "Add" });
          if (!v) return;
          await run(() => api("POST", "/clubs", v), "Added");
          reload();
        } }, "Add a team")),
      h("p", { class: "muted small" }, "In tournaments set to \"Teams (same teams carry over)\", each team joins the team with the same name here (created automatically), and imported stat lines with that team name count for it. Two names for one team? Merge them."),
      clubs.length ? table([
        { key: "name", label: "Team", fmt: (c) => h("a", { href: `/club?id=${c.id}`, target: "_blank" }, c.name) },
        { key: "tournaments", label: "Tournaments", num: true },
        { key: "history_lines", label: "Imported lines", num: true },
        { key: "record", label: "W-L-OTL", sort: false, fmt: (c) => rec(c.record) },
        { key: "x", label: "", sort: false, fmt: (c) => h("div", { class: "row" },
          h("button", { class: "sm", onclick: async () => {
            const v = await formSheet(`Rename ${c.name}`, [{ name: "name", label: "Name", value: c.name, required: true }, { name: "short_name", label: "Short name", value: c.short_name || "" }]);
            if (!v) return;
            await run(() => api("PATCH", `/clubs/${c.id}`, v), "Renamed");
            reload();
          } }, "Rename"),
          clubs.length > 1 ? h("button", { class: "sm", onclick: async () => {
            const v = await formSheet(`Merge into ${c.name}`, [{ name: "from", label: "This team is the same as", type: "select", options: clubs.filter((x) => x.id !== c.id).map((x) => [x.id, x.name]) }],
              { submitLabel: "Merge", intro: `The other team's tournaments and imported lines move to ${c.name}, and the other name is removed.` });
            if (!v) return;
            await run(() => api("POST", `/clubs/${c.id}/merge`, { from_club_id: Number(v.from) }), "Merged");
            reload();
          } }, "Merge…") : "",
          h("button", { class: "sm danger", onclick: async () => {
            if (!(await confirmSheet(`Remove ${c.name} from team history? Tournaments and stats stay; they just stop adding up under this team.`, { title: "Remove", confirmLabel: "Remove", danger: true }))) return;
            await run(() => api("DELETE", `/clubs/${c.id}`), "Removed");
            reload();
          } }, "Remove")) },
      ], clubs, { sortKey: "name", sortDir: 1 }) : h("p", { class: "muted" }, "No teams yet. Set a tournament's format to \"Teams (same teams carry over)\" under Tournaments → Settings, or import history with \"these teams carry over\" ticked.")));
  }

  // -------------------------------------------------------------------------
  // Organization: Factions on/off, the organization's own factions, and the
  // people who can run it (members and invitations)

  async function orgView() {
    const peopleBox = h("div");
    const factionsBox = h("div");
    mount(view,
      h("div", { class: "card" },
        h("h2", null, BLST.org ? BLST.org.name : "Organization"),
        BLST.org ? h("p", { class: "muted small" }, "Your site: ", h("a", { href: `${BLST.org.url}/stats` }, BLST.org.url.replace(/^https?:\/\//, ""), "/stats"),
          ". To rename the organization or change its address, ask a platform admin.") : ""),
      factionsBox, peopleBox);
    const typesBox = h("div");
    view.insertBefore(typesBox, factionsBox);
    tournamentTypesCard(typesBox);
    await Promise.all([factionsSetup(factionsBox), peopleView(peopleBox)]);
  }

  /** The organization's tournament types (event series): part of every Tournament ID. */
  function tournamentTypesCard(el) {
    const types = (BLST.org && BLST.org.tournament_types) || [];
    const box = h("input", { value: types.join(", "), placeholder: "DEX, Bash, Outlaw", style: { width: "100%" } });
    mount(el, h("div", { class: "card" },
      h("h2", null, "Tournament types"),
      h("p", { class: "muted small" }, "Your event series. Each tournament's ID is its city, type and year (e.g. PITTSBURGH-DEX-2025), and historical uploads must name one, so a tournament's stats can only be uploaded once."),
      h("form", { class: "row", onsubmit: async (e) => {
        e.preventDefault();
        const list = box.value.split(",").map((x) => x.trim()).filter(Boolean);
        const r = await run(() => api("PUT", "/admin/tournament-types", { types: list }), "Tournament types saved");
        if (BLST.org) BLST.org.tournament_types = r.types;
      } }, box, h("button", { class: "primary" }, "Save"))));
  }

  async function factionsSetup(el) {
    const s = await get("/factions-setup");
    const reload = () => factionsSetup(el);
    const toggle = async (on) => {
      if (!on && !(await confirmSheet("Turn Factions off? The Factions page, badges and points disappear for everyone. Nothing is deleted: turn it back on any time.",
        { title: "Turn off Factions", confirmLabel: "Turn off", danger: true }))) return;
      await run(() => api("PUT", "/factions-setup", { enabled: on }), on ? "Factions is on" : "Factions is off");
      location.reload(); // the menu and pages change
    };
    const row = (f) => {
      const name = h("input", { value: f.name, maxlength: 40, "aria-label": "Faction name" });
      const emoji = h("input", { value: f.emoji || "", maxlength: 8, class: "emoji", "aria-label": "Emoji" });
      const color = h("input", { type: "color", value: f.color, "aria-label": "Colour" });
      return h("div", { class: "faction-row" }, emoji, name, color,
        h("div", { class: "row" },
          h("button", { class: "sm", onclick: async () => {
            await run(() => api("PATCH", `/factions-setup/factions/${f.slug}`, { name: name.value.trim(), emoji: emoji.value.trim() || null, color: color.value }), "Saved");
            reload();
          } }, "Save"),
          h("button", { class: "sm danger", onclick: async () => {
            if (!(await confirmSheet(`Remove ${f.name}?`, { title: "Remove faction", confirmLabel: "Remove", danger: true }))) return;
            await run(() => api("DELETE", `/factions-setup/factions/${f.slug}`), "Removed");
            reload();
          } }, "Remove")));
    };
    const add = async () => {
      const v = await formSheet("Add a faction", [
        { name: "name", label: "Name", required: true, placeholder: "Wolves" },
        { name: "emoji", label: "Emoji (optional)", placeholder: "🐺" },
        { name: "color", label: "Colour", type: "color", value: "#2563eb" },
      ], { submitLabel: "Add" });
      if (!v) return;
      await run(() => api("POST", "/factions-setup/factions", v), "Added");
      reload();
    };
    mount(el, h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "Factions"),
        h("label", { class: "inline" }, h("input", { type: "checkbox", checked: s.enabled, onchange: (e) => toggle(e.target.checked).finally(() => { e.target.checked = s.enabled; }) }), s.enabled ? "On" : "Off")),
      h("p", { class: "muted small" }, "Factions splits every player with an email into teams-within-the-league that earn points from games, events and achievements. ",
        "Everyone is placed in a faction for life, from their email. Use it or not: when it's off, the Factions page and badges are hidden."),
      s.factions.length
        ? [h("div", { class: "faction-list" }, s.factions.map(row)),
          h("div", { class: "row", style: { marginTop: "10px" } }, s.factions.length < 24 ? h("button", { onclick: add }, "Add a faction") : "",
            h("span", { class: "muted small" }, "Once people are in factions, they can be renamed and recoloured but not removed."))]
        : h("div", null,
          h("p", null, "No factions yet. Start from a ready-made set or make your own:"),
          h("div", { class: "row" },
            Object.entries(s.presets).map(([key, p]) => h("button", { onclick: async () => {
              await run(() => api("POST", "/factions-setup/factions", { preset: key }), `${p.name} added`);
              reload();
            } }, p.name)),
            h("button", { onclick: add }, "Make my own")))));
  }

  async function peopleView(el) {
    const [list, tournamentsForAccounts] = await Promise.all([get("/admin/members"), get("/tournaments")]);
    const reload = () => peopleView(el);
    const roleLabel = { admin: "Admin", scorekeeper: "Scorekeeper" };
    const tournamentOptions = [["", "All tournaments"], ...tournamentsForAccounts.map((t) => [t.id, t.name])];
    const accessFields = (m = {}) => [
      { name: "role", label: "Access", type: "select", value: m.role || "scorekeeper", options: [["scorekeeper", "Scorekeeper (runs games)"], ["admin", "Admin (everything)"]] },
      { name: "tournament_id", label: "Scorekeeper limited to tournament", type: "select", value: m.tournament_id || "", options: tournamentOptions, hint: "Only applies to scorekeepers." },
    ];
    const tid = (v) => (v.tournament_id ? Number(v.tournament_id) : null);
    const addPerson = async () => {
      const v = await formSheet("Add a person", [{ name: "email", label: "Email", type: "email", required: true }, ...accessFields()],
        { submitLabel: "Add", intro: "If they don't have an account yet, they get an email invitation and the access applies when they sign up with that address." });
      if (!v) return;
      const r = await run(() => api("POST", "/admin/members", { email: v.email, role: v.role, tournament_id: tid(v) }));
      toast(r.invited ? `Invitation emailed to ${v.email}` : `${v.email} added`);
      reload();
    };
    const edit = async (m) => {
      const v = await formSheet(`Access for ${m.email}`, accessFields(m), { submitLabel: "Save" });
      if (!v) return;
      await run(() => api("PATCH", `/admin/members/${m.account_id}`, { role: v.role, tournament_id: tid(v) }), "Access updated");
      reload();
    };
    mount(el, h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "People"), h("button", { class: "primary", onclick: addPerson }, "Add a person")),
      h("p", { class: "muted small" }, "Admins run everything here; scorekeepers run games. They sign in with an emailed code plus an authenticator app or passkey, which they set up the first time. ",
        "Fans don't need an account."),
      table([
        { key: "email", label: "Email", fmt: (m) => h("span", null, m.email, m.account_id === me.account_id ? h("span", { class: "badge", style: { marginLeft: "6px" } }, "you") : "") },
        { key: "second_factor", label: "2nd step", fmt: (m) => (m.second_factor ? "✓" : h("span", { class: "muted small" }, "not set up")) },
        { key: "role", label: "Access", fmt: (m) => `${roleLabel[m.role]}${m.role === "scorekeeper" && m.tournament ? ` · ${m.tournament}` : ""}` },
        { key: "last_login_at", label: "Last sign-in", fmt: (m) => (m.last_login_at ? fmtDate(m.last_login_at) : "never") },
        { key: "disabled", label: "", sort: false, fmt: (m) => h("div", { class: "row" },
          m.disabled ? h("span", { class: "badge" }, "disabled") : "",
          h("button", { class: "sm", onclick: () => edit(m) }, "Access"),
          h("button", { class: "sm danger", onclick: async () => {
            if (!(await confirmSheet(`Remove ${m.email} from ${BLST.org ? BLST.org.name : "this organization"}? Their account stays; they just lose access here.`, { title: "Remove access", confirmLabel: "Remove", danger: true }))) return;
            await run(() => api("DELETE", `/admin/members/${m.account_id}`), "Removed");
            reload();
          } }, "Remove")) },
      ], list.members, { sortKey: "email", sortDir: 1 }),
      list.invites.length ? [
        h("h3", null, "Invitations waiting"),
        table([
          { key: "email", label: "Email" },
          { key: "role", label: "Access", fmt: (i) => `${roleLabel[i.role]}${i.tournament ? ` · ${i.tournament}` : ""}` },
          { key: "created_at", label: "Sent", fmt: (i) => fmtDate(i.created_at) },
          { key: "x", label: "", sort: false, fmt: (i) => h("button", { class: "sm", onclick: async () => {
            await run(() => api("DELETE", `/admin/invites/${encodeURIComponent(i.email)}`), "Invitation withdrawn");
            reload();
          } }, "Withdraw") },
        ], list.invites, { sortKey: "created_at" })] : ""));
  }

  // -------------------------------------------------------------------------
  // API keys

  async function keysView() {
    const [keys, tournamentsForKeys] = await Promise.all([get("/admin/api-keys"), get("/tournaments")]);
    const created = h("div");
    mount(view,
      h("div", { class: "card" }, h("h2", null, "Create API key"),
        h("p", { class: "muted small" }, "scorekeeper: run games (clock, events, lineups). readonly: export API when PUBLIC_EXPORTS=false. admin: everything, including creating keys. Tip: give each rink device its own scorekeeper key, limited to the tournament and expiring after the event; revoke keys you no longer need."),
        h("form", { class: "form", onsubmit: async (e) => {
          e.preventDefault();
          const k = await run(() => api("POST", "/admin/api-keys", values(e.target)));
          mount(created, h("div", { class: "notice" }, h("strong", null, "Copy this key now — it won't be shown again: "), h("code", { class: "mono" }, k.key)));
          keysView().then(() => view.prepend(created));
        } },
          field("Name", input("name", { required: true, placeholder: "Rink 1 scorekeeper" })),
          field("Role", select("role", ["scorekeeper", "readonly", "admin"], "scorekeeper")),
          field("Limit to tournament", select("tournament_id", [["", "All tournaments"], ...tournamentsForKeys.map((t) => [t.id, t.name])], "", { "data-num": 1 })),
          field("Expires after (days)", input("expires_in_days", { type: "number", min: 1, max: 3650, placeholder: "never" })),
          h("div", null, h("button", { class: "primary" }, "Create key")))),
      h("div", { class: "card" }, h("h2", null, "Keys"), table([
        { key: "name", label: "Name" }, { key: "role", label: "Role" },
        { key: "tournament", label: "Tournament", fmt: (k) => k.tournament || "all" },
        { key: "expires_at", label: "Expires", fmt: (k) => (k.expires_at ? fmtDate(k.expires_at) : "never") },
        { key: "key_prefix", label: "Key", fmt: (k) => h("code", null, `${k.key_prefix}…`) },
        { key: "created_at", label: "Created", fmt: (k) => fmtDate(k.created_at) },
        { key: "last_used_at", label: "Last used", fmt: (k) => (k.last_used_at ? fmtDate(k.last_used_at) : "never") },
        { key: "revoked_at", label: "", sort: false, fmt: (k) => (k.revoked_at ? h("span", { class: "badge" }, "revoked") : h("button", { class: "sm danger", onclick: async () => {
          if (!(await confirmSheet(`Revoke "${k.name}"? Any device using it is signed out immediately.`, { title: "Revoke key", confirmLabel: "Revoke", danger: true }))) return;
          await run(() => api("DELETE", `/admin/api-keys/${k.id}`), "Revoked");
          keysView();
        } }, "Revoke")) },
      ], keys)));
  }

  // -------------------------------------------------------------------------
  // Webhooks

  async function webhooksView() {
    const hooks = await get("/admin/webhooks");
    const deliveries = h("div");
    const created = h("div");
    mount(view,
      created,
      h("div", { class: "card" }, h("h2", null, "Add webhook"),
        h("p", { class: "muted small" }, "BLST POSTs JSON to your URL when things happen. Events: game.created, game.started, game.clock, game.period, game.event.created/updated/voided/restored, game.final, game.reopened, roster.added/updated/removed/moved/imported, player.created/updated, team.updated, tournament.*, schedule.generated. Use * for all or a prefix like game.*. Verify X-BLST-Signature (HMAC-SHA256 of \"timestamp.body\") — see the API page."),
        h("form", { class: "form", onsubmit: async (e) => {
          e.preventDefault();
          const hook = await run(() => api("POST", "/admin/webhooks", values(e.target)), "Webhook added");
          await webhooksView();
          view.prepend(h("div", { class: "notice" }, h("strong", null, "Signing secret (copy now): "), h("code", { class: "mono" }, hook.secret)));
        } },
          field("Name", input("name", { required: true })),
          field("URL", input("url", { required: true, type: "url", placeholder: "https://…" }), "wide"),
          field("Events", input("events", { value: "*", placeholder: "* or game.final,roster.moved" })),
          field("Secret (blank = generate)", input("secret")),
          h("div", null, h("button", { class: "primary" }, "Add")))),
      h("div", { class: "card" }, h("h2", null, "Webhooks"), table([
        { key: "name", label: "Name" }, { key: "url", label: "URL" }, { key: "events", label: "Events", fmt: (w) => w.events.join(", ") },
        { key: "active", label: "Active", fmt: (w) => h("input", { type: "checkbox", checked: w.active, onchange: async (e) => run(() => api("PATCH", `/admin/webhooks/${w.id}`, { active: e.target.checked }), "Saved") }) },
        { key: "x", label: "", sort: false, fmt: (w) => h("div", { class: "row", style: { justifyContent: "flex-end" } },
          h("button", { class: "sm", onclick: async () => { await run(() => api("POST", `/admin/webhooks/${w.id}/test`), "Ping sent"); setTimeout(() => showDeliveries(w), 800); } }, "Test"),
          h("button", { class: "sm", onclick: () => showDeliveries(w) }, "Deliveries"),
          h("button", { class: "sm danger", onclick: async () => { if (await confirmSheet(`Delete the webhook "${w.name}"?`, { title: "Delete webhook", confirmLabel: "Delete", danger: true })) { await run(() => api("DELETE", `/admin/webhooks/${w.id}`), "Deleted"); webhooksView(); } } }, "✕")) },
      ], hooks)),
      deliveries);
    async function showDeliveries(w) {
      const list = await get(`/admin/webhooks/${w.id}/deliveries`);
      mount(deliveries, h("div", { class: "card" }, h("h2", null, `Deliveries — ${w.name}`), table([
        { key: "id", label: "ID", num: true }, { key: "event", label: "Event" }, { key: "status", label: "Status" }, { key: "attempts", label: "Tries", num: true },
        { key: "response_code", label: "HTTP", num: true }, { key: "error", label: "Error" }, { key: "created_at", label: "At", fmt: (d) => fmtDate(d.created_at) },
      ], list, { sortKey: "id" })));
    }
  }

  // -------------------------------------------------------------------------
  // Integrations: SportsEngine

  async function integrationsView(keepTid, notice) {
    const st = await get("/integrations/sportsengine");
    const work = h("div");
    const connectForm = (orgs) => h("form", { class: "form", onsubmit: async (e) => {
      e.preventDefault();
      const v = values(e.target);
      const r = await run(() => api("PUT", "/integrations/sportsengine", {
        client_id: v.client_id, client_secret: v.client_secret || undefined, se_organization_id: v.se_organization_id || undefined, auto_push: e.target.auto_push.checked,
      }), "SportsEngine connected");
      await integrationsView();
      if (!r.se_organization_id && r.organizations.length > 1) toast("Choose which SportsEngine organization to use", true);
    } },
      field("Client ID", input("client_id", { required: true, value: st.client_id || "", autocomplete: "off" })),
      field(st.connected ? "Client secret (blank = keep)" : "Client secret", input("client_secret", { type: "password", required: !st.connected, autocomplete: "new-password" })),
      orgs && orgs.length ? field("SportsEngine organization", select("se_organization_id", [["", "— choose —"], ...orgs.map((o) => [o.id, o.name])], st.se_organization_id || ""))
        : field("SportsEngine organization ID (blank = the only one you can see)", input("se_organization_id", { value: st.se_organization_id || "" })),
      h("label", { class: "inline" }, h("input", { type: "checkbox", name: "auto_push", checked: st.connected ? st.auto_push : true }), "Send final scores to SportsEngine automatically"),
      h("div", null, h("button", { class: "primary" }, st.connected ? "Save and test" : "Connect")));

    const head = h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "SportsEngine"),
        st.connected ? h("span", { class: `badge ${st.last_error ? "danger" : ""}` }, st.last_error ? "Error" : "Connected") : h("span", { class: "badge" }, "Not connected")),
      h("p", { class: "muted small" }, "Brings teams, rosters and game schedules in from SportsEngine and sends final scores back. In SportsEngine, create an API client for your organization (SportsEngine → Developer / API settings) and enter its client ID and secret here. The secret is stored encrypted."),
      st.connected ? h("p", null, "Organization: ", h("strong", null, st.se_organization_name || st.se_organization_id || "— not chosen —"),
        ` · linked ${st.linked.teams} teams, ${st.linked.players} players, ${st.linked.games} games`, st.last_sync_at ? ` · last sync ${fmtDate(st.last_sync_at)}` : "") : "",
      st.last_error ? h("p", { class: "notice error" }, st.last_error) : "",
      connectForm(null),
      st.connected ? h("div", { class: "row", style: { marginTop: "8px" } },
        h("button", { class: "sm", onclick: async () => mount(work, connectForm((await run(() => api("PUT", "/integrations/sportsengine", { client_id: st.client_id }))).organizations)) }, "Choose organization…"),
        h("button", { class: "sm danger", onclick: async () => {
          if (await confirmSheet("Disconnect SportsEngine? Links between SportsEngine and BLST teams, players and games are kept for a reconnect.", { title: "Disconnect", confirmLabel: "Disconnect", danger: true })) {
            await run(() => api("DELETE", "/integrations/sportsengine"), "Disconnected");
            integrationsView();
          }
        } }, "Disconnect")) : "");

    if (!st.connected) return mount(view, head);

    const list = await get("/tournaments");
    const tBox = h("div");
    const pick = select("se-t", [["", "Choose a tournament or league division…"], ...list.map((t) => [t.id, `${t.name}${t.season ? ` (${t.season})` : ""}`])], keepTid || "", {
      onchange: (e) => (e.target.value ? tournamentSync(Number(e.target.value)) : mount(tBox)),
    });
    async function tournamentSync(tid) {
      mount(tBox, h("p", { class: "muted" }, "Loading SportsEngine teams…"));
      let seTeams;
      try {
        seTeams = await get("/integrations/sportsengine/teams");
      } catch (err) {
        return mount(tBox, h("p", { class: "notice error" }, err.message));
      }
      const links = await get(`/tournaments/${tid}/sportsengine`);
      const report = h("div");
      const boxes = seTeams.map((t) => ({ t, cb: h("input", { type: "checkbox", value: t.id, checked: Boolean(t.linked && t.linked.tournament_id === tid) }) }));
      const today = new Date().toISOString().slice(0, 10);
      const later = new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10);
      mount(tBox,
        h("div", { class: "card" }, h("h2", null, "Teams and rosters"),
          h("p", { class: "muted small" }, "Each team comes in under its SportsEngine name (an existing team with the same name is used). Players are matched by email, then name and birth date, then name; new ones are added. Run it again any time to pick up roster changes."),
          seTeams.length ? h("div", { class: "stack" }, boxes.map(({ t, cb }) => h("label", { class: "inline" }, cb, h("strong", null, t.name),
            t.program ? h("span", { class: "muted small" }, t.program) : "",
            t.linked ? h("span", { class: "muted small" }, `→ ${t.linked.team} (${t.linked.tournament})`) : ""))) : h("p", { class: "muted" }, "No teams found in this SportsEngine organization."),
          h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "primary", onclick: async () => {
            const ids = boxes.filter((b) => b.cb.checked).map((b) => b.t.id);
            if (!ids.length) return toast("Tick at least one team", true);
            const r = await run(() => api("POST", `/tournaments/${tid}/sportsengine/teams`, { team_ids: ids }));
            await integrationsView(tid, h("div", { class: `notice ${r.errors.length ? "error" : ""}` },
              `${r.teams} teams (${r.created_teams} new) · ${r.players} players (${r.created_players} new)${r.moved ? ` · ${r.moved} moved` : ""}`,
              r.review.length ? h("div", { class: "small" }, "Check these matches: ", r.review.join("; ")) : "",
              r.errors.length ? h("ul", { class: "small" }, r.errors.map((x) => h("li", null, x))) : ""));
          } }, "Import teams and rosters"))),
        h("div", { class: "card" }, h("h2", null, "Schedule"),
          h("p", { class: "muted small" }, "SportsEngine games between this competition's linked teams become BLST games (time, rink, home and away). Games already started in BLST aren't changed."),
          h("form", { class: "form", onsubmit: async (e) => {
            e.preventDefault();
            const v = values(e.target);
            const r = await run(() => api("POST", `/tournaments/${tid}/sportsengine/schedule`, { start: v.start, end: v.end }));
            await integrationsView(tid, h("div", { class: "notice" }, `${r.created} new games, ${r.updated} updated${r.skipped ? `, ${r.skipped} already underway` : ""} (${r.seen} SportsEngine events looked at)`));
          } },
            field("From", input("start", { type: "date", value: today })),
            field("To", input("end", { type: "date", value: later })),
            h("div", null, h("button", { class: links.teams.length < 2 ? "" : "primary", disabled: links.teams.length < 2 }, "Import schedule")),
            links.teams.length < 2 ? h("p", { class: "muted small" }, "Import at least two teams first.") : "")),
        h("div", { class: "card" }, h("h2", null, "Games and results"),
          h("p", { class: "muted small" }, st.auto_push ? "Final scores are sent to SportsEngine automatically when a game ends. Use Send to send one again (after a correction)." : "Automatic sending is off: use Send for each final game."),
          links.games.length ? table([
            { key: "scheduled_at", label: "When", fmt: (g) => (g.scheduled_at ? fmtDate(g.scheduled_at) : "—") },
            { key: "home", label: "Game", fmt: (g) => `${g.home} vs ${g.away}` },
            { key: "status", label: "Status", fmt: (g) => (g.status === "final" ? `Final ${g.home_score}-${g.away_score}` : g.status) },
            { key: "pushed_at", label: "Sent", fmt: (g) => (g.pushed_at ? `${g.pushed_score} · ${fmtDate(g.pushed_at)}` : "—") },
            { key: "x", label: "", sort: false, fmt: (g) => (g.status === "final" ? h("button", { class: "sm", onclick: async () => {
              await run(() => api("POST", `/games/${g.game_id}/sportsengine/result`, {}), "Score sent to SportsEngine");
              integrationsView(tid);
            } }, "Send") : "") },
          ], links.games) : h("p", { class: "muted" }, "No SportsEngine games in this competition yet.")));
    }

    mount(view, head, work,
      h("div", { class: "card" }, h("h2", null, "Sync a tournament or league division"), field("Into", pick)), tBox,
      h("div", { class: "card" }, h("h2", null, "Activity"), st.log.length ? table([
        { key: "at", label: "At", fmt: (l) => fmtDate(l.at) }, { key: "action", label: "What" },
        { key: "ok", label: "", fmt: (l) => (l.ok ? "✓" : h("span", { class: "danger-text" }, "✕")) }, { key: "message", label: "Details" },
      ], st.log, { sortKey: "at" }) : h("p", { class: "muted" }, "Nothing yet.")));
    if (keepTid) {
      await tournamentSync(keepTid);
      if (notice) tBox.prepend(notice);
    }
  }

  // -------------------------------------------------------------------------
  // Factions (global)

  async function factionsGlobalView() {
    const sub = h("div");
    const subTabs = tabs([["overview", "Overview"], ["members", "Members"], ["events", "Events"], ["games", "Points from games"], ["upload", "Bulk upload"]],
      (s) => factionsSub(s, sub), "overview", { size: "medium" });
    mount(view, subTabs.el, sub);
    factionsSub("overview", sub);
  }

  /** Which tournaments and league divisions earn Factions points (each player's games count for their faction). */
  async function fxGames(el) {
    const list = await get("/tournaments");
    const box = h("div");
    const pick = select("fx-t", [["", "Choose a tournament or league division…"], ...list.map((t) => [t.id, `${t.name}${t.season ? ` (${t.season})` : ""}${t.factions_event_id ? " ✓" : ""}`])], "", {
      onchange: async (e) => (e.target.value ? factionsView(await get(`/tournaments/${e.target.value}`), box) : mount(box)),
    });
    mount(el, h("div", { class: "card" }, h("h2", null, "Points from games"),
      h("p", { class: "muted small" }, "Factions runs separately from stats: nothing about factions shows on scores, standings or player pages. Pick which tournaments and league divisions earn faction points (✓ = counting); points then update by themselves as games go final."),
      field("Tournament or league division", pick)), box);
  }

  function factionsSub(tab, el) {
    mount(el, h("p", { class: "muted" }, "Loading…"));
    const fn = { overview: fxOverview, members: fxMembers, events: fxEvents, games: fxGames, upload: fxUpload }[tab];
    fn(el).catch((err) => mount(el, h("p", { class: "notice error" }, err.message)));
  }

  async function fxOverview(el) {
    const [s, orders, la] = await Promise.all([get("/factions/status"), get("/factions/orders"), get("/integrations/leagueapps").catch(() => null)]);
    mount(el,
      h("div", { class: "card" },
        h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "Faction standings"), h("a", { href: "/factions", target: "_blank" }, "Public Factions page ↗")),
        table([
          { key: "rank", label: "#", num: true },
          { key: "slug", label: "Faction", fmt: (r) => BLST.orderBadge(r.slug, { link: false }) },
          { key: "members", label: "Members", num: true },
          { key: "event_points", label: "Event pts", num: true },
          { key: "bonus_points", label: "Bonus pts", num: true },
          { key: "total_points", label: "Total", num: true },
        ], orders, { sortKey: "total_points" })),
      h("div", { class: "card" }, h("h2", null, "How Factions works here"),
        h("ul", { class: "stack", style: { paddingLeft: "18px" } },
          h("li", null, "Every player with an email belongs to a faction for life, assigned from their email the first time BLST sees it. ", h("strong", null, `${s.members} members`), " so far."),
          h("li", null, "Tournaments you mark ", h("em", null, "Count for Factions"), " (Tournaments → Factions) earn points automatically ", s.auto_award ? "as games go final." : "when you press Award (automatic awarding is off: FACTIONS_AUTO_AWARD=false)."),
          h("li", null, "Award bonus points and achievements to anyone under Members; record other events under Events."),
          s.players_without_email ? h("li", null, `${s.players_without_email} players have no email yet, so they have no faction.`) : ""),
        la && la.configured ? h("div", { class: "row", style: { marginTop: "8px" } },
          h("button", { onclick: async () => {
            const r = await run(() => api("POST", "/integrations/leagueapps/members/sync", {}));
            toast(`LeagueApps: ${r.new_members} new members, ${r.existing_members} already in a faction`);
            fxOverview(el);
          } }, "Import LeagueApps members"),
          h("span", { class: "muted small" }, la.members?.last_run_at ? `Last run ${fmtDate(la.members.last_run_at)}` : "Gives every LeagueApps member their faction, even before they register.")) : ""));
  }

  async function fxMembers(el) {
    const listBox = h("div");
    const detail = h("div");
    const q = h("input", { placeholder: "Search name or email…", style: { minWidth: "240px" }, oninput: debounce(() => load(), 250) });
    const orderSel = select("order", [["", "All factions"], ...BLST.ORDERS.map((o) => [o.slug, `${o.emoji} ${o.name}`])], "", { onchange: () => load() });
    const load = async () => {
      const params = new URLSearchParams({ limit: "200" });
      if (q.value.trim()) params.set("q", q.value.trim());
      if (orderSel.value) params.set("order", orderSel.value);
      const r = await get(`/factions/members?${params}`);
      mount(listBox,
        h("p", { class: "muted small" }, `${r.total} member${r.total === 1 ? "" : "s"}${r.total > r.members.length ? ` (showing ${r.members.length})` : ""}. Tap one to award points.`),
        table([
          { key: "display_name", label: "Name", fmt: (m) => m.display_name || h("span", { class: "muted" }, "—") },
          { key: "email", label: "Email" },
          { key: "order_slug", label: "Faction", fmt: (m) => BLST.orderBadge(m.order_slug, { link: false }) },
          { key: "total_points", label: "Points", num: true },
          { key: "events", label: "Events", num: true },
          { key: "achievements_count", label: "Awards", num: true },
        ], r.members, { sortKey: "total_points", onRow: (m) => showMember(m.id) }));
    };
    const showMember = async (id) => {
      const m = await get(`/factions/members/${encodeURIComponent(id)}`);
      const events = await get("/factions/events");
      mount(detail, h("div", { class: "card", style: { borderTop: `6px solid ${BLST.ORDER[m.order_slug].color}` } },
        h("div", { class: "row between" },
          h("div", null, h("h2", { style: { margin: 0 } }, m.display_name || m.email), h("div", { class: "muted small" }, m.email)),
          BLST.orderBadge(m.order_slug, { big: true })),
        h("dl", { class: "kv", style: { marginTop: "10px" } },
          h("dt", null, "Total"), h("dd", null, `${m.total_points} pts (${m.event_points} from events, ${m.bonus_points} bonus)`),
          h("dt", null, "BLST player"), h("dd", null, m.player ? h("a", { href: `/player?id=${m.player.id}` }, m.player.name) : "—"),
          h("dt", null, "Member since"), h("dd", null, fmtDate(m.created_at, { month: "short", day: "numeric", year: "numeric" })),
          m.leagueapps_user_id ? [h("dt", null, "LeagueApps id"), h("dd", null, m.leagueapps_user_id)] : ""),
        h("p", { class: "muted small" }, "A faction is for life: it can't be changed."),
        h("div", { class: "grid two" },
          h("form", { class: "stack", onsubmit: async (e) => {
            e.preventDefault();
            await run(() => api("POST", `/factions/members/${encodeURIComponent(id)}/points`, { points: Number(e.target.points.value) }), "Points updated");
            showMember(id);
            load();
          } }, h("h3", null, "Bonus points"),
            field("Points (negative takes away)", input("points", { type: "number", step: 1, required: true })),
            h("button", { class: "primary" }, "Add points")),
          h("form", { class: "stack", onsubmit: async (e) => {
            e.preventDefault();
            const v = values(e.target);
            const r = await run(() => api("POST", `/factions/members/${encodeURIComponent(id)}/achievements`, v));
            toast(r.created ? "Achievement awarded" : "They already have that achievement");
            showMember(id);
          } }, h("h3", null, "Achievement"),
            field("Code (unique per member)", input("code", { required: true, placeholder: "first_event", pattern: "[A-Za-z0-9_.:\\-]+" })),
            field("Title", input("title", { required: true, placeholder: "Played First Event" })),
            field("Event (optional)", select("event_id", [["", "—"], ...events.map((e) => [e.id, e.name])], "")),
            h("button", null, "Award"))),
        m.achievements.length ? [h("h3", null, "Achievements"), h("ul", null, m.achievements.map((a) =>
          h("li", null, `🏅 ${a.title}`, h("span", { class: "muted small" }, ` · ${a.code}${a.event_name ? ` · ${a.event_name}` : ""} · ${fmtDate(a.awarded_at, { month: "short", day: "numeric", year: "numeric" })}`))))] : "",
        m.participation.length ? [h("h3", null, "Events"), table([
          { key: "event_name", label: "Event" }, { key: "points_earned", label: "Points", num: true }, { key: "placement", label: "Place", num: true },
        ], m.participation)] : ""));
      detail.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    mount(el,
      h("div", { class: "card" }, h("h2", null, "Find or add a member"),
        h("form", { class: "form", onsubmit: async (e) => {
          e.preventDefault();
          const r = await run(() => api("POST", "/factions/members", values(e.target)));
          toast(r.created ? `New member: ${BLST.ORDER[r.order_slug].name}` : `Already a member of ${BLST.ORDER[r.order_slug].name}`);
          e.target.reset();
          load();
          showMember(r.id);
        } },
          field("Email", input("email", { type: "email", required: true, placeholder: "player@example.com" })),
          field("Name", input("display_name", { placeholder: "Jane Doe" })),
          h("div", null, h("button", { class: "primary" }, "Find / add")))),
      detail,
      h("div", { class: "card" }, h("div", { class: "row" }, q, orderSel), listBox));
    load();
  }

  async function fxEvents(el) {
    const events = await get("/factions/events");
    const detail = h("div");
    const showEvent = async (id) => {
      const [e, totals] = await Promise.all([get(`/factions/events/${encodeURIComponent(id)}`), get(`/factions/events/${encodeURIComponent(id)}/totals`)]);
      mount(detail, h("div", { class: "card" },
        h("h2", null, e.name),
        e.tournament_id ? h("p", { class: "muted small" }, "Points for this event come from the tournament ", h("a", { href: `/tournament?id=${e.tournament_id}` }, e.tournament_name),
          ". Recording someone here by hand is kept until the tournament is awarded again.") : "",
        h("div", { class: "order-strip" }, [...totals].sort((a, b) => a.rank - b.rank).map((o) =>
          h("a", { href: `/factions#${o.slug}`, style: { "--order": BLST.ORDER[o.slug].color } },
            h("small", null, `#${o.rank} ${BLST.ORDER[o.slug].emoji}`), h("strong", null, o.total_points), h("small", null, BLST.ORDER[o.slug].name)))),
        h("h3", null, "Record participation"),
        h("form", { class: "form", onsubmit: async (ev) => {
          ev.preventDefault();
          const v = values(ev.target);
          await run(() => api("POST", `/factions/events/${encodeURIComponent(id)}/participation`, v), "Recorded");
          showEvent(id);
        } },
          field("Member email", input("email", { type: "email", required: true })),
          field("Points", input("points_earned", { type: "number", step: 1, value: 0, required: true })),
          field("Placement", input("placement", { type: "number", min: 1, step: 1 })),
          h("div", null, h("button", { class: "primary" }, "Record"))),
        h("h3", null, `Participants (${e.participation.length})`),
        table([
          { key: "display_name", label: "Member", fmt: (r) => r.display_name || r.email },
          { key: "order_slug", label: "Faction", fmt: (r) => BLST.orderBadge(r.order_slug, { link: false }) },
          { key: "points_earned", label: "Points", num: true }, { key: "placement", label: "Place", num: true },
        ], e.participation, { sortKey: "points_earned" })));
      detail.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    mount(el,
      h("div", { class: "card" }, h("h2", null, "Events"),
        h("p", { class: "muted small" }, "Tournaments that count for Factions appear here automatically. Add other events (socials, camps, tryouts) to give their points too."),
        table([
          { key: "name", label: "Event" },
          { key: "start_date", label: "Date", fmt: (e) => (e.start_date ? fmtDate(e.start_date, { month: "short", day: "numeric", year: "numeric" }) : "—") },
          { key: "tournament_name", label: "Tournament", fmt: (e) => (e.tournament_id ? h("a", { href: `/tournament?id=${e.tournament_id}` }, e.tournament_name) : "—") },
          { key: "participants", label: "Members", num: true }, { key: "points", label: "Points", num: true },
        ], events, { sortKey: "start_date", onRow: (e) => showEvent(e.id) })),
      detail,
      h("div", { class: "card" }, h("h2", null, "New event"),
        h("form", { class: "form", onsubmit: async (e) => {
          e.preventDefault();
          const ev = await run(() => api("POST", "/factions/events", values(e.target)), "Event created");
          await fxEvents(el);
          showEvent(ev.id);
        } },
          field("Name", input("name", { required: true, placeholder: "Summer Social" })),
          field("Start", input("start_date", { type: "date" })),
          field("End", input("end_date", { type: "date" })),
          field("LeagueApps event id (optional)", input("leagueapps_event_id")),
          h("div", null, h("button", { class: "primary" }, "Create event")))));
  }

  async function fxUpload(el) {
    const textarea = h("textarea", { rows: 8, style: { width: "100%" }, placeholder: "email,name\njane@example.com,Jane Doe" });
    const fileIn = h("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv", onchange: async (e) => {
      const f = e.target.files[0];
      if (f) textarea.value = await f.text();
    } });
    const out = h("div");
    const send = async (dryRun) => {
      if (!textarea.value.trim()) return toast("Choose a file or paste a list first", true);
      const r = await run(() => api("POST", "/factions/members/import", { csv: textarea.value, dry_run: dryRun }));
      mount(out,
        h("p", { class: r.invalid ? "notice" : "notice" }, `${dryRun ? "Preview: " : "Imported: "}${r.new_members} new member${r.new_members === 1 ? "" : "s"}, ${r.existing_members} already in a faction, ${r.invalid} invalid row${r.invalid === 1 ? "" : "s"}.`),
        r.errors.length ? h("ul", { class: "small" }, r.errors.slice(0, 50).map((x) => h("li", null, `Line ${x.line}: ${x.error}`))) : "",
        table([
          { key: "line", label: "Line", num: true }, { key: "email", label: "Email" }, { key: "name", label: "Name" },
          { key: "order", label: "Faction", fmt: (x) => BLST.orderBadge(x.order, { link: false }) },
          { key: "new", label: "", fmt: (x) => (x.new ? h("span", { class: "badge good" }, "new") : x.duplicate_in_file ? h("span", { class: "badge" }, "repeated in file") : h("span", { class: "badge" }, "already a member")) },
        ], r.results, { sortKey: "line", sortDir: 1 }));
    };
    mount(el, h("div", { class: "card" }, h("h2", null, "Bulk upload members"),
      h("p", { class: "muted small" }, "A spreadsheet saved as CSV (commas, semicolons or tabs) with an email column, and optionally a name. Everyone gets their faction; people already in a faction keep it, so uploading the same list twice changes nothing."),
      fileIn, textarea,
      h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { onclick: () => send(true) }, "Preview"), h("button", { class: "primary", onclick: () => send(false) }, "Import")),
      out));
  }


  // -------------------------------------------------------------------------
  // Security

  async function securityView() {
    const [sec, log] = await Promise.all([get("/admin/security"), get("/admin/audit-log?limit=200")]);
    const ok = (good, text) => h("li", null, h("span", { style: { color: good ? "var(--good)" : "var(--danger)", fontWeight: 800 } }, good ? "✓ " : "✗ "), text);
    const rejectedOnly = h("input", { type: "checkbox" });
    const logBox = h("div");
    const renderLog = (rows) => mount(logBox, table([
      { key: "at", label: "When", fmt: (r) => fmtDate(r.at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) },
      { key: "actor", label: "Who" }, { key: "method", label: "" }, { key: "path", label: "Path" },
      { key: "status", label: "Result", num: true, fmt: (r) => h("span", { style: { color: r.status >= 400 ? "var(--danger)" : "" } }, r.status) },
      { key: "ip", label: "IP" },
    ], rows, { sortKey: "at" }));
    rejectedOnly.addEventListener("change", async () => renderLog(await get(`/admin/audit-log?limit=200${rejectedOnly.checked ? "&rejected=true" : ""}`)));
    mount(view,
      h("div", { class: "card" }, h("h2", null, "Security checklist"),
        h("ul", { class: "stack", style: { listStyle: "none", padding: 0 } },
          ok(sec.accounts.admins > 0, sec.accounts.admins > 0 ? `${sec.accounts.admins} platform admin account(s)` : "No admin account yet: set one up (Account → Set up admin)"),
          sec.accounts.admins > 0
            ? ok(!sec.accounts.admin_token_break_glass, sec.accounts.admin_token_break_glass ? "ADMIN_TOKEN_BREAK_GLASS is on: the admin password works without MFA. Turn it off when you're done." : "Admin password (ADMIN_TOKEN) is retired: admins must use MFA")
            : ok(!sec.admin_token_set || sec.admin_token_strong, sec.admin_token_set
              ? (sec.admin_token_strong ? "Strong setup key (ADMIN_TOKEN) is set" : "ADMIN_TOKEN is too short: use at least 16 random characters")
              : "A one-time setup key is printed in the server log at each start until the first admin exists"),
          ok(sec.accounts.email_configured, sec.accounts.email_configured ? "Email codes are sent (Resend or SMTP)" : "Email isn't set up (RESEND_API_KEY or SMTP_URL): codes only appear in the server log"),
          ok(sec.accounts.staff_without_second_factor === 0, sec.accounts.staff_without_second_factor === 0 ? "Every admin and scorekeeper here has an authenticator app or passkey" : `${sec.accounts.staff_without_second_factor} admin(s)/scorekeeper(s) haven't set up an authenticator or passkey yet (no staff access until they do)`),
          ok(!sec.deployed || !sec.accounts.codes_in_log, sec.accounts.codes_in_log ? "Sign-in codes are printed in the server log (development)" : "Sign-in codes are never logged"),
          ok(true, sec.accounts.auth_secret_set ? "AUTH_SECRET is set" : "AUTH_SECRET was generated on first start and is kept in the database"),
          ok(!sec.open_dev_mode, sec.open_dev_mode ? "Open development mode is ON: anyone can make changes" : "Changes require an account or key"),
          ok(!sec.database.superuser && !sec.database.can_change_schema,
            !sec.database.superuser && !sec.database.can_change_schema
              ? `The app's database login ("${sec.database.role}") can only read and write rows${sec.database.mode === "auto" ? " (set up automatically)" : ""}`
              : `The app connects to the database as "${sec.database.role}"${sec.database.superuser ? ", a superuser" : ", which can change the schema"}. Run npm run db:app-role for a least-privilege login (see SECURITY.md)`),
          ok(sec.database.statement_timeout !== "0", `Database queries time out after ${sec.database.statement_timeout}`),
          ok(!sec.deployed || sec.database.tls || sec.platform === "railway",
            sec.database.tls ? "Database connection is encrypted (TLS)"
              : sec.platform === "railway" ? "Database traffic stays on Railway's encrypted private network"
                : sec.deployed ? "Database connection isn't using TLS (set DATABASE_SSL=true)" : "Database connection is local (no TLS needed)"),
          ok(!sec.private_network_urls_allowed, sec.private_network_urls_allowed ? "Webhooks may target private networks (ALLOW_PRIVATE_NETWORK_URLS)" : "Webhooks and link checks can't reach internal networks"),
          ok(true, `Rate limits: ${sec.rate_limits.readsPerMinute} reads / ${sec.rate_limits.writesPerMinute} changes per minute per IP; sign-in locked after ${sec.rate_limits.authFailuresPer15Min} bad keys in 15 min`),
          ok(true, `Browser access (CORS): ${sec.cors_origins.join(", ")}`),
          ok(true, `Exports are ${sec.public_exports ? "public (no personal data)" : "key-only"}`)),
        h("p", { class: "muted small" }, `Last 24 hours: ${sec.last_24h.changes} changes, ${sec.last_24h.denied} denied requests, ${sec.last_24h.throttled} rate-limited. Details: SECURITY.md in the repository.`)),
      h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "Audit log"),
        h("label", { class: "inline" }, rejectedOnly, "Only denied / rate-limited")),
        h("p", { class: "muted small" }, "Every change and every rejected request, kept 180 days. No passwords, keys or request contents are recorded."),
        logBox));
    renderLog(log);
  }

  show(mainTabs.current);
})().catch((err) => BLST.toast(err.message, true));

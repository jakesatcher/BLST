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
      me.role ? h("p", { class: "notice" }, "You're signed in, but this account isn't an admin. Ask an admin for access.") : "",
      box,
      status.setup_needed ? "" : h("details", null, h("summary", null, "Use an API key instead"), keyForm())));
    BLST.signInFlow(box, {
      mode: status.setup_needed ? "setup" : "login",
      intro: status.setup_needed
        ? "No admin account exists yet. Create the global admin: it signs in with an emailed code and a text-message code every time. After that, the admin password (ADMIN_TOKEN) stops working."
        : "Admins sign in with two codes: one emailed, one texted to your phone.",
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
      r.errors.length > 50 ? h("div", { class: "small" }, `…and ${r.errors.length - 50} more`) : "");
  }

  // -------------------------------------------------------------------------
  // Shell

  const view = h("div");
  const mainTabs = tabs([["tournaments", "Tournaments"], ["players", "Players"], ["history", "Historical import"], ["accounts", "Accounts"], ["keys", "API keys"], ["webhooks", "Webhooks"], ["factions", "BLPA Factions"], ["security", "Security"]],
    (t) => { history.replaceState(null, "", `#${t}`); show(t); }, location.hash.slice(1).split("/")[0] || "tournaments", { size: "big" });
  mount(app,
    h("div", { class: "row between" }, h("h1", null, "Admin"),
      me.via === "dev-open" ? h("span", { class: "badge" }, "dev mode: no ADMIN_TOKEN set") : ""),
    mainTabs.el, view);

  function show(tab) {
    const fn = { tournaments: tournamentsView, players: playersView, history: historyView, accounts: accountsView, keys: keysView, webhooks: webhooksView, factions: factionsGlobalView, security: securityView }[tab];
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
        h("div", { class: "row" }, h("strong", null, "Tournament"), picker, selectedTid ? h("a", { href: `/tournament.html?id=${selectedTid}`, target: "_blank" }, "Public page ↗") : ""),
        h("button", { class: "primary", onclick: () => { selectedTid = null; mount(body, newTournamentForm()); } }, "New tournament")),
      body);
    if (!selectedTid) return mount(body, newTournamentForm());
    const t = await get(`/tournaments/${selectedTid}`);
    const sub = h("div");
    const subTabs = tabs([["registrations", "Registrations"], ["teams", "Teams & rosters"], ["schedule", "Schedule"], ["import", "Draft / roster upload"], ["streams", "Streams"], ["moves", "Moves"], ["settings", "Settings"], ["factions", "Factions sync"]],
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
      ["Score a game", games.some((g) => g.status !== "scheduled"), "Open scorekeeper", () => (location.href = "/scorekeeper.html")],
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

  function tournamentFormFields(t = {}) {
    return [
      field("Name", input("name", { required: true, value: t.name || "", placeholder: "BLPA Fall Classic" }), "wide"),
      field("Season", input("season", { value: t.season || "" })),
      field("Location", input("location", { value: t.location || "" })),
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
    const namesArea = h("textarea", { name: "team_names_text", placeholder: "Optional: one team name per line (blank = Team 1, Team 2, …)", style: { minHeight: "90px" } });
    return h("div", { class: "card" }, h("h2", null, "New tournament"),
      h("form", { class: "form", onsubmit: async (e) => {
        e.preventDefault();
        const v = values(e.target);
        const team_names = (v.team_names_text || "").split("\n").map((x) => x.trim()).filter(Boolean);
        delete v.team_names_text;
        const t = await run(() => api("POST", "/tournaments", { ...v, team_names }), "Tournament created");
        selectedTid = t.id;
        history.replaceState(null, "", `#tournaments/${t.id}`);
        tournamentsView();
      } },
        ...tournamentFormFields(),
        field("Number of teams", select("num_teams", range(2, 32), 4, { "data-num": 1 })),
        field("Team names", namesArea, "wide"),
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
      if (tab === "factions") await factionsView(t, el);
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
      field("Email (for Factions)", input("email", { type: "email" })),
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
            h("a", { class: "btn sm", href: `/scorekeeper.html?game=${g.id}` }, "Score"),
            h("a", { class: "btn sm", href: `/game.html?id=${g.id}`, target: "_blank" }, "View"),
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
                  h("a", { class: "btn", href: `/tournament.html?id=${t.id}#teams`, target: "_blank" }, "Public rosters ↗"))));
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
        h("p", { class: "muted" }, "One line per player: team, jersey number, name, and optionally position, C/A, email (needed for BLPA Factions), draft round and pick. Your own draft spreadsheet works too if its columns are named like these."),
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
          h("a", { href: `/player.html?id=${p.id}`, target: "_blank" }, "Career stats page ↗")),
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
        h("p", { class: "muted small" }, "LiveBarn doesn't offer a public embed or API, and its pages can't be shown inside other sites. If LiveBarn gives BLPA an embed/partner player link for the tournament, paste it as the video embed and use Check. YouTube Live links (your own camera) work as-is.")),
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
            h("a", { class: "btn sm", href: `/watch.html?game=${g.id}`, target: "_blank" }, "Watch"),
            h("button", { class: "sm", onclick: async () => {
              const url = `${location.origin}/overlay.html?game=${g.id}`;
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

  async function factionsView(t, el) {
    const status = await get("/factions/status");
    const out = h("div");
    const refresh = async () => tournamentSub("factions", await get(`/tournaments/${t.id}`), el);
    const pts = { ...status.default_points, ...(t.factions_points || {}) };
    const ptsForm = h("form", { class: "form", onsubmit: async (e) => {
      e.preventDefault();
      await run(() => api("PATCH", `/tournaments/${t.id}`, { factions_points: values(e.target) }), "Point values saved");
      refresh();
    } }, Object.entries(pts).map(([k, v]) => field(k.replace(/_/g, " "), input(k, { type: "number", value: v, step: 1 }))), h("div", null, h("button", null, "Save points")));

    const showPreview = async () => {
      const p = await get(`/tournaments/${t.id}/factions/preview`);
      mount(out, h("h3", null, "Points preview"), table([
        { key: "name", label: "Player" }, { key: "gp", label: "GP", num: true }, { key: "goals", label: "G", num: true }, { key: "assists", label: "A", num: true },
        { key: "wins", label: "W", num: true }, { key: "shutouts", label: "SO", num: true }, { key: "hat_tricks", label: "Hat tricks", num: true },
        { key: "placement", label: "Place", num: true }, { key: "points_earned", label: "Points", num: true },
        { key: "factions_player_id", label: "Synced", fmt: (r) => (r.factions_player_id ? "✓" : h("span", { class: "muted" }, "no email / not synced")) },
        { key: "ach", label: "Achievements", sort: false, fmt: (r) => r.achievements.map((a) => a.title.split(" — ")[0]).join(", ") },
      ], p.participation, { sortKey: "points_earned" }));
    };

    mount(el,
      !status.configured ? h("p", { class: "notice error" }, "FACTIONS_BASE_URL isn't set on the server, so nothing can be sent yet. See the BLPA Factions tab.") : "",
      h("div", { class: "card" }, h("h2", null, "1. Link to a Factions event"),
        t.factions_event_id ? h("p", null, "Linked to Factions event ", h("code", null, t.factions_event_id)) : h("p", { class: "muted" }, "Not linked yet."),
        h("div", { class: "row" },
          h("button", { class: "primary", disabled: !status.configured, onclick: async () => { await run(() => api("POST", `/tournaments/${t.id}/factions/link`, {}), "Event created in Factions"); refresh(); } },
            t.factions_event_id ? "Create a new event instead" : "Create event in Factions"),
          h("span", { class: "muted" }, "or"),
          h("input", { id: "fx-event", placeholder: "existing event id", value: "" }),
          h("button", { disabled: !status.configured, onclick: async () => {
            const id = $("#fx-event").value.trim();
            if (!id) return;
            await run(() => api("POST", `/tournaments/${t.id}/factions/link`, { event_id: id }), "Linked");
            refresh();
          } }, "Link existing"))),
      h("div", { class: "card" }, h("h2", null, "2. Sync players"),
        h("p", { class: "muted small" }, "Registers each rostered player with Factions by email and records their Order. Players without an email are skipped."),
        h("button", { disabled: !status.configured, onclick: async () => {
          const r = await run(() => api("POST", `/tournaments/${t.id}/factions/sync-players`));
          toast(`${r.synced} synced, ${r.skipped_no_email.length} without email, ${r.errors.length} errors`, r.errors.length > 0);
          showPreview();
        } }, "Sync players")),
      h("div", { class: "card" }, h("h2", null, "3. Points & push"),
        h("p", { class: "muted small" }, "Points per player are sent as the event participation's pointsEarned (an upsert, so pushing again after a correction replaces the old value). Hat tricks, shutouts and championships are also sent as achievements. Set each team's final place on the Teams tab after playoffs."),
        ptsForm,
        h("div", { class: "row", style: { marginTop: "10px" } },
          h("button", { onclick: showPreview }, "Preview"),
          h("button", { class: "primary", disabled: !status.configured || !t.factions_event_id, onclick: async () => {
            const r = await run(() => api("POST", `/tournaments/${t.id}/factions/push`));
            toast(`Pushed ${r.pushed} players, ${r.achievements} achievements${r.skipped_unsynced ? `, ${r.skipped_unsynced} not synced` : ""}`, r.errors.length > 0);
          } }, "Push to Factions"),
          status.auto_sync ? h("span", { class: "badge" }, "auto-push on every final") : ""),
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
        { key: "external_id", label: "External ID" }, { key: "factions_order", label: "Order" },
      ], list, { sortKey: "last_name", sortDir: 1, onRow: (p) => editPlayer(p.id) }));
    };
    search.addEventListener("input", debounce(load, 250));

    async function editPlayer(id) {
      const p = await get(`/players/${id}`);
      const hist = await get(`/players/${id}/history`);
      mount(editor, h("div", { class: "card" },
        h("div", { class: "row between" }, h("h2", null, `${p.first_name} ${p.last_name}`), h("a", { href: `/player.html?id=${id}`, target: "_blank" }, "Public page ↗")),
        p.factions_player_id ? h("p", { class: "muted small" }, `Factions: ${p.factions_order || "?"} (synced)`) : "",
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

  async function historyView() {
    const area = h("textarea", { placeholder: "name,season,team,gp,g,a,pim,+/-\nSam Sniper,2025,Wolves,10,8,6,4,5" });
    const report = h("div");
    const batches = h("div");
    const source = h("input", { placeholder: "e.g. 2025 league site", value: "" });
    const loadBatches = async () => {
      const list = await get("/import/batches");
      mount(batches, table([
        { key: "imported_at", label: "Imported", fmt: (b) => fmtDate(b.imported_at) }, { key: "source", label: "Source" },
        { key: "rows", label: "Rows", num: true }, { key: "import_batch", label: "Batch" },
        { key: "x", label: "", sort: false, fmt: (b) => h("button", { class: "sm danger", onclick: async () => {
          if (!(await confirmSheet(`Delete all ${b.rows} stat lines from this import?`, { title: "Undo import", confirmLabel: "Delete rows", danger: true }))) return;
          await run(() => api("DELETE", `/import/batches/${encodeURIComponent(b.import_batch)}`), "Batch deleted");
          loadBatches();
        } }, "Undo import") },
      ], list, { sortKey: "imported_at" }));
    };
    const go = async (dry) => {
      const body = importPayload(area.value, { dry_run: dry, source: source.value || undefined, skip_errors: $("#hi-skip").checked, create_missing_players: $("#hi-create").checked });
      try {
        mount(report, importReport(await api("POST", "/import/historical", body)));
        if (!dry) loadBatches();
      } catch (err) {
        if (err.data && err.data.errors) mount(report, importReport(err.data));
        else toast(err.message, true);
      }
    };
    mount(view,
      h("div", { class: "card" }, h("h2", null, "Import historical stats"),
        h("p", { class: "muted small" },
          "One row per player per season/event. Recognised columns (case-insensitive, common abbreviations OK): name or first_name/last_name, email, external_id, season, event, team, position, GP, G, A, PIM, +/-, PPG, PPA, SHG, SHA, GWG, SOG, HITS, BLK, FOW, FOL; goalies: GP (or GPI), W, L, OTL, T, SA, GA, SV, SO, MIN (minutes or mm:ss). Imported lines are added to career totals, never to live tournament stats."),
        h("div", { class: "row", style: { marginBottom: "8px" } }, fileLoader(area), field("Source label", source)),
        area,
        h("div", { class: "row" },
          h("label", { class: "inline" }, h("input", { type: "checkbox", id: "hi-create", checked: true }), "Create players that don't exist"),
          h("label", { class: "inline" }, h("input", { type: "checkbox", id: "hi-skip" }), "Skip bad rows")),
        h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { onclick: () => go(true) }, "Dry run"), h("button", { class: "primary", onclick: () => go(false) }, "Import")),
        report),
      h("div", { class: "card" }, h("h2", null, "Previous imports"), batches));
    loadBatches();
  }

  // -------------------------------------------------------------------------
  // Accounts (people who sign in with email + text-message codes)

  async function accountsView() {
    const [list, tournamentsForAccounts] = await Promise.all([get("/admin/accounts"), get("/tournaments")]);
    const roleLabel = { admin: "Admin", scorekeeper: "Scorekeeper", user: "Standard" };
    const edit = async (a) => {
      const v = await formSheet(`Access for ${a.email}`, [
        { name: "role", label: "Access", type: "select", value: a.role, options: [["user", "Standard (no staff access)"], ["scorekeeper", "Scorekeeper"], ["admin", "Global admin"]] },
        { name: "tournament_id", label: "Scorekeeper limited to tournament", type: "select", value: a.tournament_id || "",
          options: [["", "All tournaments"], ...tournamentsForAccounts.map((t) => [t.id, t.name])], hint: "Only applies to scorekeepers." },
      ], { submitLabel: "Save", intro: "Changing access signs this person out everywhere so the new access applies straight away." });
      if (!v) return;
      await run(() => api("PATCH", `/admin/accounts/${a.id}`, { role: v.role, tournament_id: v.tournament_id ? Number(v.tournament_id) : null }), "Access updated");
      accountsView();
    };
    mount(view,
      h("div", { class: "card" }, h("h2", null, "Accounts"),
        h("p", { class: "muted small" }, "Anyone can create a standard account at ", h("a", { href: "/account.html#signup" }, "/account.html"),
          " with their email and mobile number (both confirmed with one-time codes). Give people scorekeeper or admin access here. Every sign-in needs an emailed code and a texted code. Phone numbers are masked; BLST stores nothing else about account holders."),
        table([
          { key: "email", label: "Email", fmt: (a) => h("span", null, a.email, a.id === me.account_id ? h("span", { class: "badge", style: { marginLeft: "6px" } }, "you") : "") },
          { key: "phone", label: "Mobile" },
          { key: "role", label: "Access", fmt: (a) => `${roleLabel[a.role]}${a.role === "scorekeeper" && a.tournament ? ` · ${a.tournament}` : ""}` },
          { key: "last_login_at", label: "Last sign-in", fmt: (a) => (a.last_login_at ? fmtDate(a.last_login_at) : "never") },
          { key: "sessions", label: "Devices", num: true },
          { key: "disabled", label: "", sort: false, fmt: (a) => h("div", { class: "row" },
            a.disabled ? h("span", { class: "badge" }, "disabled") : "",
            h("button", { class: "sm", onclick: () => edit(a) }, "Access"),
            h("button", { class: "sm", onclick: async () => {
              await run(() => api("POST", `/admin/accounts/${a.id}/logout`), "Signed out everywhere");
              accountsView();
            } }, "Sign out"),
            h("button", { class: "sm", onclick: async () => {
              await run(() => api("PATCH", `/admin/accounts/${a.id}`, { disabled: !a.disabled }), a.disabled ? "Enabled" : "Disabled");
              accountsView();
            } }, a.disabled ? "Enable" : "Disable"),
            h("button", { class: "sm danger", onclick: async () => {
              if (!(await confirmSheet(`Delete the account ${a.email}? Their email and phone number are erased.`, { title: "Delete account", confirmLabel: "Delete", danger: true }))) return;
              await run(() => api("DELETE", `/admin/accounts/${a.id}`), "Deleted");
              accountsView();
            } }, "Delete")) },
        ], list, { sortKey: "email", sortDir: 1 })));
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
  // Factions (global)

  async function factionsGlobalView() {
    const s = await get("/factions/status");
    mount(view, h("div", { class: "card" }, h("h2", null, "BLPA Factions connection"),
      h("dl", { class: "kv" },
        h("dt", null, "Configured"), h("dd", null, s.configured ? "yes" : "no — set FACTIONS_BASE_URL"),
        h("dt", null, "Base URL"), h("dd", null, s.base_url || "—"),
        h("dt", null, "Admin token"), h("dd", null, s.has_token ? "set" : "not set (FACTIONS_ADMIN_TOKEN)"),
        h("dt", null, "Reachable"), h("dd", null, s.reachable == null ? "—" : s.reachable ? "yes" : "no"),
        h("dt", null, "Auto-push on final"), h("dd", null, s.auto_sync ? "on" : "off (FACTIONS_AUTO_SYNC)")),
      h("p", { class: "muted small", style: { marginTop: "12px" } }, "Connection settings are server environment variables. Per-tournament linking, player sync and pushing live under Tournaments → Factions sync."),
      h("h3", null, "Recent sync activity"),
      table([
        { key: "created_at", label: "When", fmt: (r) => fmtDate(r.created_at) }, { key: "tournament_id", label: "Tournament", num: true },
        { key: "action", label: "Action" }, { key: "ok", label: "OK", fmt: (r) => (r.ok ? "✓" : "✗") },
        { key: "detail", label: "Detail", sort: false, fmt: (r) => h("code", { class: "small" }, JSON.stringify(r.detail).slice(0, 160)) },
      ], s.recent, { sortKey: "created_at" })));
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
          ok(sec.accounts.admins > 0, sec.accounts.admins > 0 ? `${sec.accounts.admins} admin account(s), all signing in with email + text-message codes` : "No admin account yet: set one up (Account → Set up admin)"),
          sec.accounts.admins > 0
            ? ok(!sec.accounts.admin_token_break_glass, sec.accounts.admin_token_break_glass ? "ADMIN_TOKEN_BREAK_GLASS is on: the admin password works without MFA. Turn it off when you're done." : "Admin password (ADMIN_TOKEN) is retired: admins must use MFA")
            : ok(sec.admin_token_set && sec.admin_token_strong, sec.admin_token_set ? (sec.admin_token_strong ? "Strong setup key (ADMIN_TOKEN) is set" : "ADMIN_TOKEN is too short: use at least 16 random characters") : "No ADMIN_TOKEN set, so no admin can be set up"),
          ok(sec.accounts.email_configured, sec.accounts.email_configured ? "Email codes are sent by SMTP" : "Email isn't set up (SMTP_URL): codes only appear in the server log"),
          ok(sec.accounts.sms_configured, sec.accounts.sms_configured ? `Text-message codes are sent by Twilio (countries: +${sec.accounts.sms_country_codes.join(", +")})` : "Text messages aren't set up (TWILIO_*): codes only appear in the server log"),
          ok(!sec.deployed || !sec.accounts.codes_in_log, sec.accounts.codes_in_log ? "Sign-in codes are printed in the server log (development)" : "Sign-in codes are never logged"),
          ok(!sec.deployed || sec.accounts.auth_secret_set, sec.accounts.auth_secret_set ? "AUTH_SECRET is set" : sec.deployed ? "AUTH_SECRET isn't set: sign-ins in progress are lost on restart" : "AUTH_SECRET isn't set (fine for local development)"),
          ok(!sec.open_dev_mode, sec.open_dev_mode ? "Open development mode is ON: anyone can make changes" : "Changes require an account or key"),
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

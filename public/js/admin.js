(async function () {
  const { h, mount, api, get, $, topbar, tabs, table, toast, setToken, fmtDate, statusBadge, teamDot, debounce } = BLST;
  $("#top").replaceWith(topbar("admin"));
  const app = $("#app");

  const me = await get("/me").catch(() => ({ role: null }));
  if (me.role !== "admin") return renderLogin();

  function renderLogin() {
    const input = h("input", { type: "password", placeholder: "Admin token or admin API key", autocomplete: "off", style: { minWidth: "300px" } });
    mount(app, h("div", { class: "card", style: { maxWidth: "560px" } },
      h("h1", null, "Admin sign-in"),
      h("p", { class: "muted" }, "Paste the server's ADMIN_TOKEN or an API key with the admin role. It's kept in this browser only."),
      h("form", { class: "row", onsubmit: async (e) => {
        e.preventDefault();
        setToken(input.value.trim());
        const who = await get("/me").catch(() => ({ role: null }));
        if (who.role !== "admin") {
          setToken("");
          return toast("Not an admin key", true);
        }
        location.reload();
      } }, input, h("button", { class: "primary" }, "Sign in"))));
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
  const localInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
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
  const mainTabs = tabs([["tournaments", "Tournaments"], ["players", "Players"], ["history", "Historical import"], ["keys", "API keys"], ["webhooks", "Webhooks"], ["factions", "BLPA Factions"]],
    (t) => { history.replaceState(null, "", `#${t}`); show(t); }, location.hash.slice(1).split("/")[0] || "tournaments");
  mount(app,
    h("div", { class: "row between" }, h("h1", null, "Admin"),
      h("span", { class: "muted small" }, `Signed in (${me.via === "dev-open" ? "dev mode — no ADMIN_TOKEN set" : me.key_name || "admin token"}) `,
        h("button", { class: "ghost sm", onclick: () => { setToken(""); location.reload(); } }, "Sign out"))),
    mainTabs.el, view);

  function show(tab) {
    const fn = { tournaments: tournamentsView, players: playersView, history: historyView, keys: keysView, webhooks: webhooksView, factions: factionsGlobalView }[tab];
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
    const subTabs = tabs([["teams", "Teams & rosters"], ["schedule", "Schedule"], ["import", "Roster import"], ["moves", "Moves"], ["settings", "Settings"], ["factions", "Factions sync"]],
      (s) => tournamentSub(s, t, sub), "teams");
    mount(body, subTabs.el, sub);
    tournamentSub("teams", t, sub);
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
      if (tab === "settings") settingsView(t, el);
      if (tab === "factions") await factionsView(t, el);
    } catch (err) {
      mount(el, h("p", { class: "notice error" }, err.message));
    }
  }

  function settingsView(t, el) {
    mount(el, h("div", { class: "card" }, h("h2", null, "Settings"),
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
        if (prompt(`Type the tournament name to delete it and ALL of its games and stats:\n${t.name}`) !== t.name) return;
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
      const others = teams.filter((x) => x.id !== team.id);
      return h("div", { class: "card" },
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
              if (!confirm(`Delete ${team.name}? Players are removed from the roster (not deleted).`)) return;
              await run(() => api("DELETE", `/teams/${team.id}`), "Team deleted");
              refresh();
            } }, "Delete"))),
        h("div", { style: { height: "10px" } }),
        table([
          { key: "jersey_number", label: "#", num: true },
          { key: "last_name", label: "Player", fmt: (r) => h("span", null, `${r.first_name} ${r.last_name}`, r.role ? ` (${r.role})` : "") },
          { key: "position", label: "Pos" },
          { key: "actions", label: "", sort: false, fmt: (r) => h("div", { class: "actions" },
            h("button", { class: "sm", onclick: async () => {
              const n = prompt(`Jersey number for ${r.first_name} ${r.last_name}`, r.jersey_number ?? "");
              if (n === null) return;
              const pos = prompt("Position (C, LW, RW, F, D, G) — blank to keep", r.position || "");
              const body = { jersey_number: n === "" ? null : Number(n) };
              if (pos) body.position = pos.toUpperCase();
              await run(() => api("PATCH", `/roster/${r.roster_entry_id}`, body), "Updated");
              refresh();
            } }, "Edit"),
            others.length ? select("to", [["", "Move to…"], ...others.map((o) => [o.id, o.name])], "", { onchange: async (e) => {
              const to = Number(e.target.value);
              if (!to) return;
              const reason = prompt(`Move ${r.first_name} ${r.last_name} to ${others.find((o) => o.id === to).name}?\nReason (optional):`, "");
              if (reason === null) return (e.target.value = "");
              const number = prompt("Jersey number on the new team (blank = keep current)", r.jersey_number ?? "");
              const body = { player_id: r.id, to_team_id: to, reason: reason || undefined };
              if (number !== null && number !== String(r.jersey_number ?? "")) body.jersey_number = number === "" ? null : Number(number);
              await run(() => api("POST", `/tournaments/${t.id}/roster/move`, body), "Player moved");
              refresh();
            } }) : "",
            h("button", { class: "sm danger", onclick: async () => {
              if (!confirm(`Remove ${r.first_name} ${r.last_name} from ${team.name}?`)) return;
              await run(() => api("DELETE", `/roster/${r.roster_entry_id}`), "Removed");
              refresh();
            } }, "✕")) },
        ], team.roster, { sortKey: "jersey_number", sortDir: 1 }));
    };

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
          { key: "matchup", label: "Game", sort: false, fmt: (g) => h("span", null, teamDot(g.away_color), g.away_team, " @ ", teamDot(g.home_color), g.home_team) },
          { key: "game_type", label: "Type" },
          { key: "status", label: "Status", fmt: (g) => statusBadge(g) },
          { key: "score", label: "Score", sort: false, fmt: (g) => (g.status === "scheduled" ? "" : `${g.away_score}–${g.home_score}`) },
          { key: "actions", label: "", sort: false, fmt: (g) => h("div", { class: "row", style: { justifyContent: "flex-end" } },
            h("a", { class: "btn sm", href: `/scorekeeper.html?game=${g.id}` }, "Score"),
            h("a", { class: "btn sm", href: `/game.html?id=${g.id}`, target: "_blank" }, "View"),
            h("button", { class: "sm", onclick: async () => {
              const v = prompt("Start time (YYYY-MM-DDTHH:MM, local)", localInput(g.scheduled_at));
              if (v === null) return;
              await run(() => api("PATCH", `/games/${g.id}`, { scheduled_at: v ? new Date(v).toISOString() : null }), "Rescheduled");
              refresh();
            } }, "Time"),
            h("button", { class: "sm danger", onclick: async () => {
              const started = g.status !== "scheduled";
              if (!confirm(started ? "This game has events. Delete it and all its stats?" : "Delete this game?")) return;
              await run(() => api("DELETE", `/games/${g.id}${started ? "?force=true" : ""}`), "Deleted");
              refresh();
            } }, "✕")) },
        ], games, { sortKey: "scheduled_at", sortDir: 1 })));
  }

  function rosterImportView(t, el) {
    const area = h("textarea", { placeholder: "first_name,last_name,number,position,team,email\nSam,Sniper,9,C,Wolves,sam@example.com" });
    const report = h("div");
    const opts = h("div", { class: "row" },
      h("label", { class: "inline" }, h("input", { type: "checkbox", id: "ri-teams" }), "Create teams that don't exist"),
      h("label", { class: "inline" }, h("input", { type: "checkbox", id: "ri-skip" }), "Skip bad rows"));
    const go = async (dry) => {
      const body = importPayload(area.value, { dry_run: dry, create_missing_teams: $("#ri-teams").checked, skip_errors: $("#ri-skip").checked });
      try {
        mount(report, importReport(await api("POST", `/import/roster/${t.id}`, body)));
      } catch (err) {
        if (err.data && err.data.errors) mount(report, importReport(err.data));
        else toast(err.message, true);
      }
    };
    mount(el, h("div", { class: "card" }, h("h2", null, "Import roster"),
      h("p", { class: "muted small" }, "CSV (or a JSON array) with a header row. Columns: first_name + last_name (or name), number, position, team (name or short name), and optionally email, external_id, role (C/A). Existing players are matched by external_id, email, then name. Re-importing updates numbers and moves players whose team changed."),
      h("div", { class: "row", style: { marginBottom: "8px" } }, fileLoader(area)), area, opts,
      h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { onclick: () => go(true) }, "Dry run"), h("button", { class: "primary", onclick: () => go(false) }, "Import")),
      report));
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
            if (!confirm(`Delete ${p.first_name} ${p.last_name}?`)) return;
            try {
              await api("DELETE", `/players/${id}`);
            } catch (err) {
              if (!confirm(`${err.message}\n\nDelete anyway?`)) return;
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
          if (!confirm(`Delete all ${b.rows} rows from this import?`)) return;
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
  // API keys

  async function keysView() {
    const keys = await get("/admin/api-keys");
    const created = h("div");
    mount(view,
      h("div", { class: "card" }, h("h2", null, "Create API key"),
        h("p", { class: "muted small" }, "scorekeeper: run games (clock, events, lineups). readonly: export API when PUBLIC_EXPORTS=false. admin: everything, including creating keys."),
        h("form", { class: "form", onsubmit: async (e) => {
          e.preventDefault();
          const k = await run(() => api("POST", "/admin/api-keys", values(e.target)));
          mount(created, h("div", { class: "notice" }, h("strong", null, "Copy this key now — it won't be shown again: "), h("code", { class: "mono" }, k.key)));
          keysView().then(() => view.prepend(created));
        } },
          field("Name", input("name", { required: true, placeholder: "Rink 1 scorekeeper" })),
          field("Role", select("role", ["scorekeeper", "readonly", "admin"], "scorekeeper")),
          h("div", null, h("button", { class: "primary" }, "Create key")))),
      h("div", { class: "card" }, h("h2", null, "Keys"), table([
        { key: "name", label: "Name" }, { key: "role", label: "Role" }, { key: "key_prefix", label: "Key", fmt: (k) => h("code", null, `${k.key_prefix}…`) },
        { key: "created_at", label: "Created", fmt: (k) => fmtDate(k.created_at) },
        { key: "last_used_at", label: "Last used", fmt: (k) => (k.last_used_at ? fmtDate(k.last_used_at) : "never") },
        { key: "revoked_at", label: "", sort: false, fmt: (k) => (k.revoked_at ? h("span", { class: "badge" }, "revoked") : h("button", { class: "sm danger", onclick: async () => {
          if (!confirm(`Revoke ${k.name}?`)) return;
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
          h("button", { class: "sm danger", onclick: async () => { if (confirm(`Delete ${w.name}?`)) { await run(() => api("DELETE", `/admin/webhooks/${w.id}`), "Deleted"); webhooksView(); } } }, "✕")) },
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

  show(mainTabs.current);
})().catch((err) => BLST.toast(err.message, true));

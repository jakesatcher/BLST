/* Shared admin pieces for connecting other systems and importing history:
   used by Admin (Integrations, History) and the league setup wizard. */
(function () {
  const { h, mount, api, get, toast, table, fmtDate } = window.BLST;

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
  const select = (name, options, value, attrs = {}) =>
    h("select", { name, ...attrs }, options.map(([v, l]) => h("option", { value: v, selected: String(v) === String(value ?? "") }, l)));
  const notice = (text, kind = "") => h("div", { class: `notice ${kind}`, style: { marginTop: "10px" } }, text);

  async function fileBase64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // -------------------------------------------------------------------------
  // LeagueApps

  /** LeagueApps connection card: status, connect with the .p12 key file, disconnect. */
  async function leagueAppsCard(el, { onChange } = {}) {
    const st = await get("/integrations/leagueapps").catch((e) => ({ error: e.message }));
    const keyFile = h("input", { type: "file", accept: ".p12,.pfx,.pem,.key,application/x-pkcs12" });
    const form = h("form", { class: "form", onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { site_id: f.site_id.value.trim(), client_id: f.client_id.value.trim(), p12_password: f.p12_password.value || undefined };
      const file = keyFile.files[0];
      if (file) {
        if (/\.(pem|key)$/i.test(file.name)) body.private_key = await file.text();
        else body.p12_base64 = await fileBase64(file);
      } else if (f.private_key.value.trim()) body.private_key = f.private_key.value.trim();
      else if (!st.configured || st.source !== "organization") return toast("Choose the key file LeagueApps gave you (.p12)", true);
      await run(() => api("PUT", "/integrations/leagueapps", body), "LeagueApps connected");
      await leagueAppsCard(el, { onChange });
      if (onChange) onChange();
    } },
      field("Site ID", h("input", { name: "site_id", required: true, inputmode: "numeric", placeholder: "12345", value: st.site_id || "" })),
      field("Client ID", h("input", { name: "client_id", required: true, autocomplete: "off", value: st.client_id || "" })),
      field(st.source === "organization" ? "Key file (blank = keep)" : "Key file (.p12)", keyFile),
      field("Key file password (usually none)", h("input", { name: "p12_password", type: "password", autocomplete: "new-password" })),
      h("details", { class: "wide" }, h("summary", { class: "small muted" }, "Or paste the key as text (PEM)"),
        h("textarea", { name: "private_key", rows: 4, placeholder: "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----", autocomplete: "off" })),
      h("div", null, h("button", { class: "primary" }, st.configured ? "Save and test" : "Connect")));
    mount(el, h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "LeagueApps"),
        h("span", { class: `badge ${st.last_error ? "danger" : ""}` }, st.configured ? "Connected" : "Not connected")),
      h("p", { class: "muted small" }, "Registrations and players (names, emails, birth dates) come from LeagueApps, so stats files match the right people. In LeagueApps: Admin Dashboard → Connect → API Settings → create a Private API key. You get a client ID and a .p12 key file; the site ID is the number in your LeagueApps admin address. The key is stored encrypted."),
      st.configured ? h("p", null, "Site ", h("strong", null, st.site_id), st.source === "server" ? " · set up in the server's settings" : "",
        st.last_run_at ? ` · last sync ${fmtDate(st.last_run_at)}` : "") : "",
      st.error ? notice(st.error, "error") : "",
      form,
      st.source === "organization" ? h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "sm danger", onclick: async () => {
        await run(() => api("DELETE", "/integrations/leagueapps"), "LeagueApps disconnected");
        await leagueAppsCard(el, { onChange });
        if (onChange) onChange();
      } }, "Disconnect")) : ""));
    return st;
  }

  // -------------------------------------------------------------------------
  // SportsEngine (connection only; syncing lives in Admin → Integrations)

  async function sportsEngineCard(el, { onChange } = {}) {
    const st = await get("/integrations/sportsengine").catch((e) => ({ error: e.message }));
    let orgs = null;
    const draw = () => mount(el, h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, "SportsEngine"),
        h("span", { class: `badge ${st.last_error ? "danger" : ""}` }, st.connected ? "Connected" : "Not connected")),
      h("p", { class: "muted small" }, "Teams, rosters, schedules and final scores come from SportsEngine (player stats come from a stats file). In SportsEngine, create an API client for your organization; enter its client ID and secret here. The secret is stored encrypted."),
      st.connected ? h("p", null, "Organization: ", h("strong", null, st.se_organization_name || st.se_organization_id || "— choose below —")) : "",
      st.last_error ? notice(st.last_error, "error") : "",
      h("form", { class: "form", onsubmit: async (e) => {
        e.preventDefault();
        const f = e.target;
        const r = await run(() => api("PUT", "/integrations/sportsengine", {
          client_id: f.client_id.value.trim(), client_secret: f.client_secret.value || undefined,
          se_organization_id: f.se_organization_id ? f.se_organization_id.value || undefined : undefined,
        }), "SportsEngine connected");
        Object.assign(st, r);
        orgs = r.organizations && r.organizations.length > 1 && !r.se_organization_name ? r.organizations : null;
        draw();
        if (onChange) onChange();
      } },
        field("Client ID", h("input", { name: "client_id", required: true, autocomplete: "off", value: st.client_id || "" })),
        field(st.connected ? "Client secret (blank = keep)" : "Client secret", h("input", { name: "client_secret", type: "password", required: !st.connected, autocomplete: "new-password" })),
        orgs ? field("Which SportsEngine organization?", select("se_organization_id", [["", "— choose —"], ...orgs.map((o) => [o.id, o.name])], "")) : "",
        h("div", null, h("button", { class: "primary" }, st.connected ? "Save and test" : "Connect")))));
    draw();
    return st;
  }

  // -------------------------------------------------------------------------
  // History importer

  const GROUP_LABELS = { player: "Player", where: "Season, division, team", skater: "Skater stats", goalie: "Goalie stats" };

  /**
   * The flexible history importer. Sources: a file (CSV, Excel, JSON),
   * pasted text, a link, SportsEngine (past seasons' teams and scores) and
   * LeagueApps (past programs' players). `leagueId` fixes the target league
   * (setup wizard); otherwise the admin chooses a league or a tournament.
   */
  async function historyImporter(el, { leagueId = null, onDone } = {}) {
    await window.BLST.ready;
    const leagues = await get("/leagues").catch(() => []);
    const state = { source: null, preview: null, mapping: {}, sheet: null };
    const srcBox = h("div");
    const mapBox = h("div");
    const targetBox = h("div");
    const resultBox = h("div");
    const bar = window.BLST.tabs([["file", "Upload a file"], ["paste", "Paste"], ["link", "Link"], ["sportsengine", "SportsEngine"], ["leagueapps", "LeagueApps"]],
      (id) => showSource(id), "file", { size: "medium" });
    mount(el, h("div", { class: "card" },
      h("h2", null, "Where are the stats now?"),
      h("p", { class: "muted small" }, "Any spreadsheet or export works: one row per player per season (or per tournament). Column names don't need to match; you'll confirm what each column is before anything is imported."),
      bar.el, srcBox), mapBox, targetBox, resultBox);
    showSource("file");

    function reset() {
      state.preview = null;
      mount(mapBox);
      mount(targetBox);
      mount(resultBox);
    }

    async function load(source, sheet) {
      state.source = source;
      state.sheet = sheet || null;
      mount(mapBox, h("div", { class: "card" }, h("p", { class: "muted" }, "Reading…")));
      try {
        state.preview = await api("POST", "/import/preview", { source, sheet: state.sheet || undefined });
      } catch (err) {
        mount(mapBox, notice(err.message, "error"));
        return;
      }
      state.sheet = state.preview.sheet;
      state.mapping = { ...state.preview.mapping };
      drawMapping();
      drawTarget();
    }

    function showSource(kind) {
      reset();
      if (kind === "file") {
        const input = h("input", { type: "file", accept: ".csv,.tsv,.txt,.json,.xlsx,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          onchange: async () => {
            const f = input.files[0];
            if (!f) return;
            if (f.size > 10 * 1024 * 1024) return toast("That file is larger than 10 MB; split it up", true);
            if (/\.xls$/i.test(f.name)) return toast("Old .xls files can't be read: in Excel, Save As → .xlsx or CSV", true);
            load({ type: "file", name: f.name, data_base64: await fileBase64(f) });
          } });
        mount(srcBox, h("p", { class: "small muted" }, "Excel (.xlsx), CSV, tab-separated or JSON. Exports from stats sites usually work as they are."), input);
      } else if (kind === "paste") {
        const area = h("textarea", { rows: 6, placeholder: "Copy the rows (with the header row) from a spreadsheet or web page and paste them here." });
        mount(srcBox, area, h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "primary", onclick: () => load({ type: "text", text: area.value }) }, "Read")));
      } else if (kind === "link") {
        const url = h("input", { type: "url", placeholder: "https://docs.google.com/spreadsheets/d/…", style: { width: "100%" } });
        mount(srcBox,
          h("p", { class: "small muted" }, "A Google Sheet (Share → Anyone with the link → Viewer), a Dropbox or OneDrive file link, or any https link to a CSV, Excel or JSON file."),
          h("div", { class: "row" }, url, h("button", { class: "primary", onclick: () => load({ type: "url", url: url.value.trim() }) }, "Read")));
      } else if (kind === "sportsengine") {
        sportsEngineSource(srcBox);
      } else if (kind === "leagueapps") {
        leagueAppsSource(srcBox);
      }
    }

    // ---- Column mapping
    function drawMapping() {
      const p = state.preview;
      const byGroup = {};
      for (const f of p.fields) (byGroup[f.group] = byGroup[f.group] || []).push(f);
      const colField = (col) => Object.keys(state.mapping).find((k) => state.mapping[k] === col) || "";
      const examples = (col) => [...new Set(p.sample.map((r) => r[col]).filter((v) => v !== ""))].slice(0, 3).join(", ");
      const picker = (col) => {
        const s = h("select", { "aria-label": `What is “${col}”?`, onchange: (e) => {
          for (const k of Object.keys(state.mapping)) if (state.mapping[k] === col) delete state.mapping[k];
          if (e.target.value) state.mapping[e.target.value] = col;
          refreshPreview();
        } },
        h("option", { value: "" }, "— ignore —"),
        Object.entries(byGroup).map(([g, fs]) => h("optgroup", { label: GROUP_LABELS[g] || g },
          fs.map((f) => h("option", { value: f.field, selected: colField(col) === f.field }, f.label + (state.mapping[f.field] && state.mapping[f.field] !== col ? ` (now: ${state.mapping[f.field]})` : ""))))));
        return s;
      };
      const hasName = state.mapping.name || (state.mapping.first_name && state.mapping.last_name) || state.mapping.email;
      mount(mapBox, h("div", { class: "card" },
        h("h2", null, "What's in each column?"),
        h("p", { class: "muted small" }, `${p.row_count} rows from ${p.label === "pasted" ? "the pasted text" : p.label}${p.header_row > 1 ? ` (column names found on row ${p.header_row})` : ""}. Columns we recognized are filled in; change any that are wrong and ignore the rest.`),
        p.sheets.length > 1 ? field("Sheet", select("sheet", p.sheets.map((s) => [s, s]), p.sheet, { onchange: (e) => load(state.source, e.target.value) })) : "",
        h("div", { class: "table-wrap" }, h("table", { class: "map-table" },
          h("thead", null, h("tr", null, h("th", null, "Column"), h("th", { class: "ex" }, "Examples"), h("th", null, "Is"))),
          h("tbody", null, p.columns.map((c) => h("tr", null,
            h("td", null, h("strong", null, c), h("div", { class: "muted small ex-inline" }, examples(c))),
            h("td", { class: "muted small ex" }, examples(c)), h("td", null, picker(c))))))),
        hasName ? "" : notice("Choose which column has the player's name (or first and last name).", "error"),
        p.seasons.length || p.divisions.length ? h("p", { class: "small", style: { marginTop: "10px" } },
          p.seasons.length ? ["Seasons in the file: ", h("strong", null, p.seasons.map((s) => `${s.value} (${s.rows})`).join(", ")), ". "] : "",
          p.divisions.length ? ["Divisions: ", h("strong", null, p.divisions.map((s) => `${s.value} (${s.rows})`).join(", ")), "."] : "") : ""));
    }

    let refreshTimer = null;
    function refreshPreview() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        try {
          const p = await api("POST", "/import/preview", { source: state.source, sheet: state.sheet || undefined, mapping: state.mapping });
          state.preview = p;
          state.mapping = { ...p.mapping };
        } catch (err) {
          toast(err.message, true);
        }
        drawMapping();
        drawTarget();
      }, 250);
    }

    // ---- Target and import
    function drawTarget() {
      const p = state.preview;
      const types = (window.BLST.org && window.BLST.org.tournament_types) || [];
      const fixedLeague = leagueId ? leagues.find((l) => l.id === leagueId) || { id: leagueId, name: "this league" } : null;
      const choice = fixedLeague ? "league" : drawTarget.kind || (leagues.length ? "league" : "tournament");
      const kind = select("kind", [["league", "A league (seasons and divisions)"], ["tournament", "A tournament"]], choice,
        { onchange: (e) => { drawTarget.kind = e.target.value; drawTarget(); } });
      const leagueSel = fixedLeague ? null : select("league", leagues.map((l) => [l.id, l.name]), drawTarget.league || (leagues[0] && leagues[0].id), { onchange: (e) => { drawTarget.league = Number(e.target.value); } });
      const seasonIn = h("input", { name: "season", placeholder: "e.g. 2023 or Fall 2023", value: drawTarget.season || "", oninput: (e) => { drawTarget.season = e.target.value; } });
      const divisionIn = h("input", { name: "division", placeholder: "e.g. C", value: drawTarget.division || "", oninput: (e) => { drawTarget.division = e.target.value; } });
      const city = h("input", { name: "city", placeholder: "Pittsburgh", maxlength: 60 });
      const series = types.length ? select("series", [["", "Choose…"], ...types.map((x) => [x, x])], "") : h("input", { name: "series", placeholder: "e.g. DEX", maxlength: 30 });
      const year = h("input", { name: "year", type: "number", min: 1950, max: 2100, value: new Date().getFullYear() - 1 });
      const create = h("input", { type: "checkbox", checked: true });
      const skip = h("input", { type: "checkbox" });
      const targetFor = () => (choice === "league"
        ? { kind: "league", league_id: fixedLeague ? fixedLeague.id : Number(leagueSel && leagueSel.value), season: seasonIn.value.trim() || undefined, division: divisionIn.value.trim() || undefined }
        : { kind: "tournament", city: city.value.trim(), series: series.value, year: Number(year.value), format: "team" });
      const go = async (dry, replace = false) => {
        const target = targetFor();
        if (target.kind === "league" && !target.league_id) return toast("Create the league first (Admin → Leagues)", true);
        if (target.kind === "league" && !state.mapping.season && !target.season) return toast("Which season are these stats from?", true);
        if (target.kind === "league" && !state.mapping.division && !target.division) return toast("Which division are these stats from?", true);
        if (target.kind === "tournament" && (!target.city || !target.series || !target.year)) return toast("Fill in the tournament's city, type and year", true);
        mount(resultBox, h("div", { class: "card" }, h("p", { class: "muted" }, dry ? "Checking…" : "Importing…")));
        let out;
        try {
          out = await api("POST", "/import/history", { source: state.source, sheet: state.sheet || undefined, mapping: state.mapping, target,
            dry_run: dry, replace, skip_errors: skip.checked, create_missing_players: create.checked });
        } catch (err) {
          if (err.data && err.data.groups) out = err.data;
          else return mount(resultBox, notice(err.message, "error"));
        }
        drawResult(out, dry, () => go(false, true));
        if (!dry && out.groups.some((g) => g.committed) && onDone) onDone(out);
      };
      mount(targetBox, h("div", { class: "card" },
        h("h2", null, "Where do they go?"),
        h("div", { class: "form" },
          fixedLeague ? h("p", { class: "wide" }, "Into ", h("strong", null, fixedLeague.name), ".") : field("Into", kind),
          choice === "league" ? [
            leagueSel ? field("League", leagueSel) : "",
            state.mapping.season ? "" : field("Season (the file has no season column)", seasonIn),
            state.mapping.division ? "" : field("Division (the file has no division column)", divisionIn),
          ] : [field("City", city), field("Tournament type", series), field("Year", year)]),
        choice === "league"
          ? h("p", { class: "muted small" }, "Each season-division in the file becomes that season's division in the league (added if it's not there yet), with its own standings and stats pages. Players' stats follow them across teams, divisions and seasons.")
          : h("p", { class: "muted small" }, "The Tournament ID (city + type + year) keeps a tournament's stats from being uploaded twice."),
        h("div", { class: "row" },
          h("label", { class: "inline" }, create, "Add players who aren't in BLST yet"),
          h("label", { class: "inline" }, skip, "Skip rows with problems")),
        h("div", { class: "row", style: { marginTop: "10px" } },
          h("button", { onclick: () => go(true) }, "Check first (nothing saved)"),
          h("button", { class: "primary", onclick: () => go(false) }, "Import"))));
    }

    function drawResult(out, dry, replaceAll) {
      const groups = out.groups || [];
      const dup = groups.filter((g) => g.duplicate);
      const ok = groups.filter((g) => g.committed || (dry && !g.errors.length));
      mount(resultBox, h("div", { class: "card" },
        h("h2", null, dry ? "Check" : "Imported"),
        h("p", null, dry
          ? `${groups.length} ${out.kind === "league" ? "season-division" : "upload"}${groups.length === 1 ? "" : "s"}; ${ok.length} ready.`
          : `${groups.filter((g) => g.committed).length} of ${groups.length} imported.`),
        table([
          { key: "label", label: out.kind === "league" ? "Season · division" : "Tournament", fmt: (g) => [g.label, g.new_competition ? h("span", { class: "muted small" }, " (new)") : ""] },
          { key: "rows", label: "Rows", num: true },
          { key: "imported", label: dry ? "OK" : "Imported", num: true },
          { key: "created_players", label: "New players", num: true, fmt: (g) => g.created_players ?? (g.new_competition && dry ? "—" : 0) },
          { key: "x", label: "", sort: false, fmt: (g) => (g.committed ? "✓" : g.duplicate ? "already uploaded" : g.errors && g.errors.length ? h("span", { class: "danger-text" }, `${g.errors.length} problem${g.errors.length === 1 ? "" : "s"}`) : dry ? "ready" : "") },
        ], groups),
        groups.some((g) => g.errors && g.errors.length && !g.duplicate) ? h("details", { open: groups.length === 1 }, h("summary", null, "Problems"),
          h("ul", { class: "small" }, groups.flatMap((g) => (g.duplicate ? [] : g.errors.slice(0, 30).map((e) => h("li", null, `${g.label}${e.row ? `, row ${e.row}` : ""}: ${e.error}`)))))) : "",
        dup.length ? h("div", { class: "notice", style: { marginTop: "10px" } },
          `${dup.map((g) => g.label).join(", ")} already ${dup.length === 1 ? "has" : "have"} uploaded stats. Importing again would count them twice.`,
          h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "primary", onclick: replaceAll }, "Replace the earlier uploads"))) : "",
        out.kind === "league" && !dry && out.league_id ? h("p", { style: { marginTop: "10px" } }, h("a", { href: `/league?id=${out.league_id}`, target: "_blank" }, "See the league's stats ↗")) : ""));
    }

    // ---- SportsEngine: a past season's teams, rosters and final scores
    async function sportsEngineSource(box) {
      const st = await get("/integrations/sportsengine").catch(() => ({ connected: false }));
      if (!st.connected) {
        mount(box, h("p", { class: "small muted" }, "Connect SportsEngine first:"), h("div"));
        return sportsEngineCard(box.lastChild, { onChange: () => sportsEngineSource(box) });
      }
      const L = leagueId || (leagues[0] && leagues[0].id);
      if (!L) return mount(box, notice("Create the league first (Admin → Leagues), then bring its past seasons in from SportsEngine."));
      const league = await get(`/leagues/${L}`);
      let seTeams;
      try {
        seTeams = await get("/integrations/sportsengine/teams");
      } catch (err) {
        return mount(box, notice(err.message, "error"));
      }
      const season = h("input", { list: "se-seasons", placeholder: "e.g. 2024", required: true });
      const division = select("division", league.divisions.map((d) => [d.id, d.name]), "");
      const start = h("input", { type: "date" });
      const end = h("input", { type: "date" });
      const scores = h("input", { type: "checkbox", checked: true });
      const boxes = seTeams.map((t) => ({ t, cb: h("input", { type: "checkbox", value: t.id }) }));
      const out = h("div");
      mount(box,
        h("p", { class: "small muted" }, "Brings one season-division in from SportsEngine: its teams and rosters, its games, and the final scores of games already played (standings and team records). Player stats (goals, assists…) aren't in SportsEngine's API; import those from a stats file."),
        h("datalist", { id: "se-seasons" }, league.seasons.map((s) => h("option", { value: s.name }))),
        h("div", { class: "form" }, field("Season", season), field("Division", division), field("Games from", start), field("Games to", end)),
        h("p", { class: "small" }, "Teams that played in it:"),
        seTeams.length ? h("div", { class: "stack" }, boxes.map(({ t, cb }) => h("label", { class: "inline" }, cb, h("strong", null, t.name), t.program ? h("span", { class: "muted small" }, t.program) : ""))) : notice("No teams found in SportsEngine."),
        h("label", { class: "inline", style: { marginTop: "8px" } }, scores, "Bring in final scores of games already played"),
        h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { class: "primary", onclick: async () => {
          const ids = boxes.filter((b) => b.cb.checked).map((b) => b.t.id);
          if (!season.value.trim()) return toast("Which season is it?", true);
          if (ids.length < 2) return toast("Tick the teams that played in it (at least two)", true);
          mount(out, h("p", { class: "muted" }, "Importing from SportsEngine…"));
          try {
            const fresh = await get(`/leagues/${L}`);
            let s = fresh.seasons.find((x) => x.name.toLowerCase() === season.value.trim().toLowerCase());
            if (!s) s = await api("POST", `/leagues/${L}/seasons`, { name: season.value.trim(), year: Number((/(19|20)\d{2}/.exec(season.value) || [])[0]) || undefined });
            const existing = (s.divisions || []).find((d) => String(d.division_id) === String(division.value));
            const comp = existing ? existing.competition : await api("POST", `/leagues/${L}/seasons/${s.id}/divisions/${division.value}`, {
              team_names: boxes.filter((b) => b.cb.checked).map((b) => b.t.name), num_teams: ids.length });
            const teams = await api("POST", `/tournaments/${comp.id}/sportsengine/teams`, { team_ids: ids });
            // No dates given: the season's year (a fall-to-spring season spans two), else the last three years.
            const y = Number((/(19|20)\d{2}/.exec(season.value) || [])[0]);
            const from = start.value || (y ? `${y - 1}-07-01` : new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10));
            const to = end.value || (y ? `${y + 1}-06-30` : new Date().toISOString().slice(0, 10));
            const sched = await api("POST", `/tournaments/${comp.id}/sportsengine/schedule`, { start: from, end: to, include_results: scores.checked });
            mount(out, notice(`${comp.name}: ${teams.teams} teams, ${teams.players} players (${teams.created_players} new), ${sched.created} games${sched.results ? `, ${sched.results} final scores` : ""}.`));
            if (onDone) onDone({ kind: "sportsengine", competition_id: comp.id });
          } catch (err) {
            mount(out, notice(err.message, "error"));
          }
        } }, "Import from SportsEngine")),
        out);
    }

    // ---- LeagueApps: past programs' players (and emails) into season-divisions
    async function leagueAppsSource(box) {
      const st = await get("/integrations/leagueapps").catch(() => ({ configured: false }));
      if (!st.configured) {
        mount(box, h("p", { class: "small muted" }, "Connect LeagueApps first:"), h("div"));
        return leagueAppsCard(box.lastChild, { onChange: () => leagueAppsSource(box) });
      }
      const comps = (await get("/tournaments")).filter((t) => !leagueId || t.league_id === leagueId);
      const out = h("div");
      const programs = st.programs || [];
      mount(box,
        h("p", { class: "small muted" }, "LeagueApps has registrations, not stats. Linking a past program to its season-division brings in who played (names, emails, birth dates), so stats files and future registrations match the same players."),
        h("div", { class: "row" }, h("button", { onclick: async () => {
          mount(out, h("p", { class: "muted" }, "Reading LeagueApps…"));
          try {
            await api("POST", "/integrations/leagueapps/sync", {});
          } catch (err) {
            return mount(out, notice(err.message, "error"));
          }
          leagueAppsSource(box);
        } }, programs.length ? "Check LeagueApps again" : "Read programs from LeagueApps")),
        programs.length ? table([
          { key: "name", label: "LeagueApps program", fmt: (p) => p.name || `Program ${p.program_id}` },
          { key: "registrations", label: "Registrations", num: true },
          { key: "x", label: "Season-division", sort: false, fmt: (p) => {
            const linked = (p.tournaments || [])[0];
            const sel = select("t", [["", "— choose —"], ...comps.map((c) => [c.id, c.name])], linked ? linked.id : "");
            return h("div", { class: "row" }, sel, h("button", { class: "sm", onclick: async () => {
              if (!sel.value) return toast("Choose the season-division (create it under Admin → Leagues if it isn't there)", true);
              const t = comps.find((c) => String(c.id) === sel.value);
              const ids = [...new Set([...(t.leagueapps_program_ids || []).map(String), String(p.program_id)])];
              await run(() => api("PUT", `/tournaments/${t.id}/leagueapps`, { program_ids: ids }));
              const s = await run(() => api("POST", "/integrations/leagueapps/sync", {}));
              mount(out, notice(`Linked. ${s.created} registrations added, ${s.updated} updated.`));
              if (onDone) onDone({ kind: "leagueapps" });
            } }, linked ? "Sync" : "Link"));
          } },
        ], programs) : h("p", { class: "muted small" }, "No programs read yet."),
        out);
    }
  }

  Object.assign(window.BLST, { leagueAppsCard, sportsEngineCard, historyImporter, fileBase64 });
})();

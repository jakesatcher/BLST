(async function () {
  const { h, mount, api, get, $, param, topbar, stream, toast, fmtClock, fmtSec, fmtDate, statusBadge, teamDot, setToken, confirmSheet, formSheet } = BLST;
  $("#top").replaceWith(topbar("scorekeeper"));
  const app = $("#app");
  const gameId = Number(param("game"));

  // -------------------------------------------------------------------------
  // Access

  let me = await get("/me").catch(() => ({ role: null }));
  if (!me.role || me.role === "readonly") return renderLogin();
  if (!gameId) return renderPicker();

  function renderLogin() {
    const input = h("input", { type: "password", placeholder: "Paste your scorekeeper key", autocomplete: "off", style: { width: "100%" } });
    mount(app, h("div", { class: "card", style: { maxWidth: "520px", margin: "24px auto" } },
      h("h1", null, "Scorekeeper sign-in"),
      h("p", { class: "muted" }, "Use the scorekeeper key your admin gave you (Admin → API keys), or the admin password. This device remembers it until you sign out."),
      h("form", { class: "stack", onsubmit: async (e) => {
        e.preventDefault();
        setToken(input.value.trim());
        me = await get("/me").catch(() => ({ role: null }));
        if (!me.role || me.role === "readonly") {
          setToken("");
          return toast("That key can't score games", true);
        }
        location.reload();
      } }, input, h("button", { class: "primary", style: { width: "100%" } }, "Sign in"))));
  }

  async function renderPicker() {
    const games = await get("/games");
    const card = (g) => h("a", { class: "card", href: `/scorekeeper.html?game=${g.id}` },
      h("div", { class: "row between" }, statusBadge(g), h("span", { class: "muted small" }, fmtDate(g.scheduled_at))),
      h("div", { class: "teams", style: { marginTop: "8px" } }, BLST.gameTeamMark(g, "away"), g.away_team, g.status !== "scheduled" ? ` ${g.away_score}` : ""),
      h("div", { class: "teams" }, BLST.gameTeamMark(g, "home"), g.home_team, g.status !== "scheduled" ? ` ${g.home_score}` : ""),
      h("div", { class: "muted small", style: { marginTop: "6px" } }, [g.tournament_name, g.venue].filter(Boolean).join(" · ")));
    const group = (title, list) => (list.length ? [h("h2", { style: { marginTop: "18px" } }, title), h("div", { class: "pick" }, list.map(card))] : "");
    const live = games.filter((g) => g.status === "live" || g.status === "intermission");
    const next = games.filter((g) => g.status === "scheduled");
    const done = games.filter((g) => g.status === "final");
    mount(app,
      h("h1", null, "Pick a game to score"),
      games.length ? [group("Live now", live), group("Up next", next), group("Finished (tap to correct)", done)]
        : h("div", { class: "card empty" }, "No live or upcoming games. An admin can schedule games in Admin → Tournaments → Schedule."));
  }

  // -------------------------------------------------------------------------
  // State

  let snap = null;
  let raw = [];
  let remaining = () => 0;
  const clockCard = h("div", { class: "card sk-bar" });
  const teamsRow = h("div", { class: "grid two" });
  const logCard = h("div", { class: "card" });
  const lineupCard = h("div", { class: "card" });
  let pill = h("span");

  mount(app, clockCard, teamsRow, logCard, lineupCard);
  BLST.keepAwake();

  const side = (which) => (which === "home" ? snap.home : snap.away);
  const other = (which) => (which === "home" ? "away" : "home");
  const whichOf = (teamId) => (teamId === snap.home.id ? "home" : "away");
  const periodLen = (period) => (period <= snap.tournament.periods ? snap.tournament.period_length_sec : snap.tournament.ot_length_sec);

  async function act(method, path, body, okMsg) {
    try {
      const res = await api(method, `/games/${gameId}${path}`, body);
      const s = res && (res.snapshot || (res.game && res.home ? res : null));
      if (s) await apply(s);
      if (okMsg) toast(okMsg);
      return res;
    } catch (err) {
      toast(err.message === "Failed to fetch" ? "No connection: that wasn't saved. Try again." : err.message, true);
      throw err;
    }
  }
  const quiet = (p) => p.catch(() => {});

  async function apply(s) {
    snap = s;
    remaining = BLST.clockFrom(s.game);
    raw = await get(`/games/${gameId}/events/raw`).catch(() => raw);
    renderClock();
    renderTeams();
    renderLog();
    renderLineups();
  }

  // -------------------------------------------------------------------------
  // Scoreboard + clock bar (sticky on iPad)

  function renderClock() {
    const g = snap.game;
    const running = g.clock_running;
    const inPlay = g.status === "live" || g.status === "intermission";
    const btn = (label, onclick, cls, disabled) => h("button", { type: "button", class: cls, onclick, disabled }, label);
    const sideBox = (which) => {
      const s = side(which);
      return h("div", { class: `side ${which}` },
        h("div", { class: "nm" }, which === "home" ? "" : BLST.teamMark(s), s.short_name || s.name, which === "home" ? [" ", BLST.teamMark(s)] : ""),
        h("div", { class: "sc" }, s.score),
        h("div", { class: "muted small" }, `SOG ${s.shots}`, s.goalie ? "" : h("strong", { style: { color: "var(--danger)" } }, " · EMPTY NET")));
    };
    const periodText = g.status === "intermission" ? `${g.period_label} · INT` : g.status === "final" ? `FINAL${g.decision && g.decision !== "REG" ? `/${g.decision}` : ""}` : g.status === "scheduled" ? "Not started" : g.period_label;

    let controls;
    if (g.status === "scheduled") {
      const pick = (which) => {
        const goalies = snap.lineups[which].filter((p) => p.dressed)
          .sort((a, b) => (a.position === "G" ? -1 : 1) - (b.position === "G" ? -1 : 1));
        return h("label", null, `${side(which).name} goalie`,
          h("select", { id: `start-${which}` }, h("option", { value: "" }, "Auto (first goalie on roster)"),
            goalies.map((p) => h("option", { value: p.player_id }, `#${p.number ?? "?"} ${p.name}${p.position === "G" ? " (G)" : ""}`))));
      };
      controls = h("div", { class: "stack", style: { marginTop: "10px" } },
        h("div", { class: "row", style: { justifyContent: "center" } }, pick("away"), pick("home")),
        h("div", { class: "sk-controls" }, btn("Start game", () => {
          const body = {};
          for (const w of ["home", "away"]) {
            const v = $(`#start-${w}`).value;
            if (v) body[`${w}_goalie_id`] = Number(v);
          }
          quiet(act("POST", "/start", body, "Game started. Tap Start clock at the drop of the puck."));
        }, "primary go")));
    } else {
      const adj = (label, delta) => btn(label, () => quiet(act("POST", "/clock", { action: "adjust", delta_sec: delta })), "", !inPlay || running);
      controls = h("div", { class: "sk-controls" },
        btn(running ? "■ Stop clock" : "▶ Start clock", toggleClock, `go ${running ? "danger solid" : "primary"}`, !inPlay),
        adj("−10s", -10), adj("−1s", -1), adj("+1s", 1), adj("+10s", 10),
        btn("Set…", setClock, "", !inPlay || running),
        btn("↶ Undo last", undoLast, "", !raw.some((e) => !e.voided)),
        g.status === "live" ? btn("End period", endPeriod, "", false) : "",
        g.status === "intermission" || (g.status === "live" && remaining() === 0)
          ? btn(g.period >= snap.tournament.periods ? "Start overtime" : "Next period", () => quiet(act("POST", "/period/next", undefined, "Next period ready")), "primary", false) : "",
        inPlay ? btn("End game", endGame, "danger", false) : "",
        g.status === "final" ? btn("Reopen game", reopen, "", false) : "");
    }

    mount(clockCard,
      h("div", { class: "row between small", style: { marginBottom: "6px" } },
        h("a", { href: "/scorekeeper.html" }, "← Games"),
        h("span", { class: "muted" }, snap.tournament.name),
        h("span", { class: "row" }, pill, h("a", { href: `/game.html?id=${gameId}`, target: "_blank" }, "Public view ↗"))),
      h("div", { class: "sk-score" },
        sideBox("away"),
        h("div", { class: "mid" },
          h("div", { class: "muted", style: { fontWeight: 700 } }, periodText),
          h("div", { class: `clock ${running ? "" : "muted"}`, id: "sk-clock" }, g.status === "final" ? "—" : fmtClock(remaining())),
          h("div", { class: "small", id: "sk-pens" })),
        sideBox("home")),
      controls);
    tickPens();
  }

  function tickPens() {
    const el = $("#sk-pens");
    if (!el || !snap) return;
    const absNow = snap.game.period_start_abs + (snap.game.period_length_sec - remaining() / 1000);
    mount(el, snap.active_penalties.map((p) => {
      const left = p.queued ? p.end_abs - p.start_abs : Math.max(0, p.end_abs - absNow);
      const team = p.team_id === snap.home.id ? snap.home : snap.away;
      return h("span", { class: "badge pp", style: { margin: "2px" } }, `${team.short_name || team.name} ${p.player ? `#${p.player.number ?? "?"}` : "Bench"} ${fmtSec(left)}${p.queued ? " (waiting)" : ""}`);
    }));
  }

  function toggleClock() {
    if (!snap || !["live", "intermission"].includes(snap.game.status)) return;
    quiet(act("POST", "/clock", { action: snap.game.clock_running ? "stop" : "start" }));
  }

  async function setClock() {
    const v = await formSheet("Set the clock", [
      { name: "remaining", label: "Time remaining (mm:ss)", type: "clock", value: fmtSec(remaining() / 1000), required: true },
    ], { submitLabel: "Set clock" });
    if (v) quiet(act("POST", "/clock", { action: "set", remaining_sec: v.remaining }));
  }

  async function endPeriod() {
    if (await confirmSheet(`End the ${snap.game.period_label} period? The clock goes to 0:00 and the game goes to intermission.`, { title: "End period", confirmLabel: "End period" })) {
      quiet(act("POST", "/period/end", undefined, "Period ended"));
    }
  }

  async function reopen() {
    if (await confirmSheet("Reopen this game to correct events? Stats update as soon as you save a change. End the game again when you're done.", { title: "Reopen game", confirmLabel: "Reopen" })) {
      quiet(act("POST", "/reopen", undefined, "Game reopened"));
    }
  }

  async function endGame() {
    const tied = snap.home.score === snap.away.score && !snap.events.some((e) => e.type === "shootout_attempt");
    const msg = tied
      ? "The score is tied. Usually you'd play overtime (Next period) or a shootout first."
      : `Final score: ${snap.away.name} ${snap.away.score}, ${snap.home.name} ${snap.home.score}.`;
    if (!(await confirmSheet(msg, { title: "End game", confirmLabel: tied ? "End anyway" : "Make it final", danger: tied }))) return;
    try {
      await act("POST", "/end", {}, "Final");
    } catch (err) {
      if (err.status === 409 && tied && (await confirmSheet(`${err.message}\n\nRecord it as a tie anyway?`, { title: "Tie game", confirmLabel: "Record tie", danger: true }))) {
        quiet(act("POST", "/end", { allow_tie: true }, "Final (tie)"));
      }
    }
  }

  async function undoLast() {
    const last = [...raw].filter((e) => !e.voided).sort((a, b) => b.id - a.id)[0];
    if (!last) return;
    const team = last.team_id ? side(whichOf(last.team_id)) : null;
    const pub = snap.events.find((e) => e.id === last.id);
    const who = pub && pub.player ? ` ${pub.player.name}` : "";
    if (await confirmSheet(`Void the last event entered?\n\n${TITLES[last.type] || last.type}${team ? ` (${team.short_name || team.name})` : ""}${who}, ${BLST.periodLabel(last.period, snap.tournament.periods)} ${fmtSec(periodLen(last.period) - last.elapsed_sec)}\n\nYou can restore it from the event log.`, { title: "Undo last", confirmLabel: "Void it", danger: true })) {
      quiet(act("DELETE", `/events/${last.id}`, undefined, "Voided"));
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || $("dialog[open]") || ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName)) return;
    e.preventDefault();
    toggleClock();
  });

  setInterval(() => {
    if (!snap || snap.game.status === "final") return;
    const el = $("#sk-clock");
    if (el) el.textContent = fmtClock(remaining());
    if (snap.game.clock_running) tickPens();
  }, 100);

  // -------------------------------------------------------------------------
  // Team panels

  const ACTIONS = [
    ["goal", "Goal", "goal"], ["shot", "Shot"], ["missed_shot", "Miss"], ["penalty", "Penalty", "pen"],
    ["faceoff", "Faceoff win"], ["hit", "Hit"], ["blocked_shot", "Block"], ["giveaway", "Giveaway"], ["takeaway", "Takeaway"],
    ["goalie_change", "Goalie"], ["penalty_shot", "Pen. shot"], ["shootout_attempt", "Shootout"], ["timeout", "Timeout"],
  ];

  function renderTeams() {
    const live = snap.game.status === "live" || snap.game.status === "intermission";
    const panel = (which) => {
      const s = side(which);
      return h("div", { class: "card" },
        h("h2", { style: { margin: 0 } }, BLST.teamMark(s), s.name, h("span", { class: "muted small" }, which === "home" ? " (home)" : " (away)")),
        h("div", { class: "muted small", style: { margin: "4px 0 10px" } },
          `SOG ${s.shots} · PIM ${s.pim} · ${s.skaters_on_ice} skaters · `, s.goalie ? `G: ${s.goalie.name}` : h("strong", { style: { color: "var(--danger)" } }, "EMPTY NET")),
        h("div", { class: "sk-actions" }, ACTIONS.map(([type, label, cls]) =>
          h("button", { class: cls, disabled: !live && !(snap.game.status === "final"), onclick: () => openEntry({ type, team_id: s.id }) }, label))));
    };
    mount(teamsRow, panel("away"), panel("home"));
  }

  // -------------------------------------------------------------------------
  // Event entry dialog

  const SLOTS = {
    goal: [["player_id", "Scorer", "own"], ["assist1_id", "Assist 1", "own"], ["assist2_id", "Assist 2", "own"]],
    shot: [["player_id", "Shooter", "own"]],
    missed_shot: [["player_id", "Shooter", "own"]],
    blocked_shot: [["player_id", "Blocker", "own"], ["secondary_player_id", "Shooter", "opp"]],
    penalty: [["player_id", "Penalized", "own"], ["secondary_player_id", "Drawn by", "opp"]],
    faceoff: [["player_id", "Winner", "own"], ["secondary_player_id", "Loser", "opp"]],
    hit: [["player_id", "Hitter", "own"], ["secondary_player_id", "Player hit", "opp"]],
    giveaway: [["player_id", "Player", "own"]],
    takeaway: [["player_id", "Player", "own"]],
    penalty_shot: [["player_id", "Shooter", "own"]],
    shootout_attempt: [["player_id", "Shooter", "own"]],
    goalie_change: [["goalie_id", "Goalie now in net", "own"]],
    timeout: [],
    note: [],
  };
  const TITLES = Object.fromEntries(ACTIONS.map(([t, l]) => [t, l]));
  const INFRACTIONS = [
    "Boarding", "Charging", "Checking from behind", "Cross-checking", "Delay of game", "Elbowing", "Fighting", "Hi-sticking",
    "Holding", "Holding the stick", "Hooking", "Interference", "Kneeing", "Roughing", "Slashing", "Spearing", "Too many men",
    "Tripping", "Unsportsmanlike conduct", "Abuse of officials", "Head contact",
  ];

  let dialog = null;
  function openEntry(initial, existing) {
    const e = existing ? { ...existing } : { ...initial };
    const ownSide = whichOf(e.team_id);
    const period = existing ? existing.period : snap.game.period;
    const clockSec = existing ? periodLen(existing.period) - existing.elapsed_sec : Math.ceil(remaining() / 1000);
    const values = {};
    for (const [key] of SLOTS[e.type] || []) values[key] = existing ? existing[key] ?? null : null;
    let active = 0;
    const onIce = { home: new Set(existing?.on_ice_home || []), away: new Set(existing?.on_ice_away || []) };

    const slots = SLOTS[e.type] || [];
    const lineup = (which) => snap.lineups[which].filter((p) => p.dressed).sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
    const byId = new Map([...snap.lineups.home, ...snap.lineups.away].map((p) => [p.player_id, p]));
    const label = (pid) => {
      const p = byId.get(pid);
      return p ? `#${p.number ?? "?"} ${p.name.split(" ").slice(-1)[0]}` : `Player ${pid}`;
    };

    const slotBar = h("div", { class: "slots" });
    const grid = h("div");
    const extras = h("div", { class: "form", style: { marginTop: "12px" } });
    const periodInput = h("input", { type: "number", min: 1, max: 20, value: period, style: { width: "80px" } });
    const clockInput = h("input", { value: fmtSec(clockSec), pattern: "\\d{1,3}:[0-5]\\d", style: { width: "90px" }, class: "mono" });

    function renderSlots() {
      mount(slotBar, slots.map(([key, name], i) =>
        h("button", { type: "button", class: i === active ? "active" : null, onclick: () => { active = i; renderSlots(); renderGrid(); } },
          `${name}: `, values[key] == null ? h("span", { class: "muted" }, key === "goalie_id" ? "empty net" : "—") : label(values[key]),
          values[key] != null ? h("span", { class: "muted", onclick: (ev) => { ev.stopPropagation(); values[key] = null; renderSlots(); renderGrid(); } }, "  ✕") : "")));
    }
    function renderGrid() {
      if (!slots.length) return mount(grid);
      const [key, , teamRole] = slots[active];
      const which = teamRole === "own" ? ownSide : other(ownSide);
      let players = lineup(which);
      if (key === "goalie_id") players = players.sort((a, b) => (a.position === "G" ? -1 : 0) - (b.position === "G" ? -1 : 0));
      mount(grid,
        h("div", { class: "muted small", style: { marginBottom: "6px" } }, `${slots[active][1]} — ${side(which).name}`),
        h("div", { class: "numgrid" }, players.map((p) =>
          h("button", { type: "button", class: values[key] === p.player_id ? "sel" : null, onclick: () => {
            values[key] = values[key] === p.player_id ? null : p.player_id;
            // Clear the same player from other slots on this team, then advance.
            for (const [k, , r] of slots) if (k !== key && r === teamRole && values[k] === p.player_id) values[k] = null;
            if (values[key] != null && active < slots.length - 1) active += 1;
            renderSlots();
            renderGrid();
          } }, h("span", { class: "n" }, p.number ?? "–"), h("span", { class: "nm" }, `${p.name.split(" ").slice(-1)[0]}${p.position === "G" ? " (G)" : ""}`))),
          key === "goalie_id" ? h("button", { type: "button", class: values[key] == null ? "sel" : null, onclick: () => { values[key] = null; renderSlots(); renderGrid(); } },
            h("span", { class: "n" }, "∅"), h("span", { class: "nm" }, "Empty net")) : ""));
    }

    // Type-specific fields
    const fields = {};
    if (e.type === "goal") {
      fields.strength = h("select", null, ["", "EV", "PP", "SH"].map((v) => h("option", { value: v }, v || "Auto (from penalties)")));
      fields.strength.value = e.strength || "";
      fields.empty_net = h("select", null, h("option", { value: "" }, "Auto"), h("option", { value: "true" }, "Yes"), h("option", { value: "false" }, "No"));
      if (existing) fields.empty_net.value = String(existing.empty_net);
      const iceGrid = (which) => h("div", null, h("div", { class: "muted small" }, side(which).name),
        h("div", { class: "numgrid" }, lineup(which).map((p) => {
          const b = h("button", { type: "button", class: onIce[which].has(p.player_id) ? "on" : null, onclick: () => {
            if (onIce[which].has(p.player_id)) onIce[which].delete(p.player_id);
            else onIce[which].add(p.player_id);
            b.classList.toggle("on");
          } }, h("span", { class: "n" }, p.number ?? "–"), h("span", { class: "nm" }, p.name.split(" ").slice(-1)[0]));
          return b;
        })));
      mount(extras,
        h("label", null, "Strength", fields.strength),
        h("label", null, "Empty net", fields.empty_net),
        h("details", { class: "wide", open: onIce.home.size + onIce.away.size > 0 },
          h("summary", null, "On ice (optional, for +/-)"), h("div", { class: "stack", style: { marginTop: "8px" } }, iceGrid("away"), iceGrid("home"))));
    } else if (e.type === "penalty") {
      fields.infraction = h("input", { list: "infractions", value: e.infraction || "", placeholder: "e.g. Tripping" });
      fields.severity = h("select", null, [["minor", "Minor (2)"], ["double_minor", "Double minor (4)"], ["major", "Major (5)"], ["misconduct", "Misconduct (10)"],
        ["game_misconduct", "Game misconduct"], ["match", "Match"], ["bench_minor", "Bench minor (2)"]].map(([v, l]) => h("option", { value: v }, l)));
      fields.severity.value = e.penalty_severity || "minor";
      fields.minutes = h("input", { type: "number", min: 0, max: 60, value: e.penalty_minutes ?? "", placeholder: "auto", style: { width: "90px" } });
      fields.coincidental = h("input", { type: "checkbox", checked: Boolean(e.coincidental) });
      mount(extras,
        h("label", null, "Infraction", fields.infraction, h("datalist", { id: "infractions" }, INFRACTIONS.map((i) => h("option", { value: i })))),
        h("label", null, "Type", fields.severity),
        h("label", null, "Minutes", fields.minutes),
        h("label", { class: "inline" }, fields.coincidental, "Coincidental (no power play)"));
    } else if (e.type === "penalty_shot" || e.type === "shootout_attempt") {
      fields.result = h("select", null, [["goal", "Goal"], ["save", "Saved"], ["miss", "Missed net"]].map(([v, l]) => h("option", { value: v }, l)));
      fields.result.value = e.result || "goal";
      mount(extras, h("label", null, "Result", fields.result));
    } else {
      mount(extras);
    }
    fields.notes = h("input", { value: e.notes || "", placeholder: "optional" });
    extras.appendChild(h("label", { class: "wide" }, "Notes", fields.notes));

    async function save() {
      const m = /^(\d{1,3}):([0-5]\d)$/.exec(clockInput.value.trim());
      if (!m) return toast("Time must be mm:ss remaining", true);
      const body = { type: e.type, team_id: e.team_id, period: Number(periodInput.value), clock: clockInput.value.trim(), notes: fields.notes.value || null };
      for (const [key] of slots) body[key] = values[key];
      if (e.type === "goal") {
        body.strength = fields.strength.value || null;
        if (fields.empty_net.value) body.empty_net = fields.empty_net.value === "true";
        if (onIce.home.size || onIce.away.size || existing) {
          body.on_ice_home = onIce.home.size ? [...onIce.home] : null;
          body.on_ice_away = onIce.away.size ? [...onIce.away] : null;
        }
      }
      if (e.type === "penalty") {
        body.infraction = fields.infraction.value || null;
        body.penalty_severity = fields.severity.value;
        if (fields.minutes.value !== "") body.penalty_minutes = Number(fields.minutes.value);
        else if (existing && existing.penalty_severity !== fields.severity.value) body.penalty_minutes = { minor: 2, bench_minor: 2, double_minor: 4, major: 5, misconduct: 10, game_misconduct: 10, match: 5 }[fields.severity.value];
        body.coincidental = fields.coincidental.checked;
      }
      if (fields.result) body.result = fields.result.value;
      try {
        if (existing) await act("PATCH", `/events/${existing.id}`, body, "Event updated");
        else await act("POST", "/events", body, `${TITLES[e.type] || e.type} recorded`);
        dialog.close();
      } catch {
        /* toast already shown */
      }
    }

    if (dialog) dialog.remove();
    dialog = h("dialog", null,
      h("div", { class: "dlg-head" }, h("strong", null, `${existing ? "Edit" : ""} ${TITLES[e.type] || e.type} — ${side(ownSide).name}`),
        h("button", { class: "ghost sm", onclick: () => dialog.close() }, "✕")),
      h("div", { class: "dlg-body" },
        slotBar, grid, extras,
        h("div", { class: "row", style: { marginTop: "12px" } }, h("label", null, "Period", periodInput), h("label", null, "Clock (remaining)", clockInput))),
      h("div", { class: "dlg-foot" },
        h("button", { onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "primary", onclick: save }, existing ? "Save changes" : "Record")));
    const mine = dialog;
    mine.addEventListener("close", () => mine.remove());
    document.body.appendChild(dialog);
    renderSlots();
    renderGrid();
    dialog.showModal();
  }

  // -------------------------------------------------------------------------
  // Event log with corrections

  function renderLog() {
    const pub = new Map(snap.events.map((e) => [e.id, e]));
    const byId = new Map([...snap.lineups.home, ...snap.lineups.away].map((p) => [p.player_id, p]));
    const nm = (pid) => (pid == null ? "" : byId.has(pid) ? `#${byId.get(pid).number ?? "?"} ${byId.get(pid).name}` : `Player ${pid}`);
    const rows = [...raw].reverse();
    mount(logCard,
      h("h2", null, "Event log"),
      rows.length
        ? h("div", { class: "table-wrap" }, h("table", null,
            h("thead", null, h("tr", null, ["Per", "Clock", "Team", "Event", "Detail", ""].map((x) => h("th", null, x)))),
            h("tbody", null, rows.map((e) => {
              const team = e.team_id ? side(whichOf(e.team_id)) : null;
              const p = pub.get(e.id);
              const detail = [
                nm(e.player_id),
                e.type === "goal" && (e.assist1_id || e.assist2_id) ? `(${[e.assist1_id, e.assist2_id].filter(Boolean).map(nm).join(", ")})` : "",
                e.type === "goal" && p ? `${p.strength}${e.empty_net ? " EN" : ""}` : "",
                e.type === "penalty" ? `${e.infraction || ""} ${e.penalty_minutes}m${e.coincidental ? " coinc." : ""}` : "",
                e.type === "goalie_change" ? (e.goalie_id ? `${nm(e.goalie_id)} in` : "pulled") : "",
                e.secondary_player_id ? `vs ${nm(e.secondary_player_id)}` : "",
                e.result || "",
              ].filter(Boolean).join(" ");
              return h("tr", { class: e.voided ? "voided" : null },
                h("td", null, BLST.periodLabel(e.period, snap.tournament.periods)),
                h("td", { class: "mono" }, fmtSec(periodLen(e.period) - e.elapsed_sec)),
                h("td", null, team ? team.short_name || team.name : ""),
                h("td", null, TITLES[e.type] || e.type),
                h("td", { class: "small" }, detail),
                h("td", { class: "num" },
                  e.voided
                    ? h("button", { class: "sm", onclick: () => quiet(act("POST", `/events/${e.id}/restore`, undefined, "Restored")) }, "Restore")
                    : [h("button", { class: "sm", onclick: () => openEntry(null, e) }, "Edit"), " ",
                       h("button", { class: "sm danger", onclick: async () => (await confirmSheet("Void this event? It stays in the log and can be restored.", { title: "Void event", confirmLabel: "Void", danger: true })) && quiet(act("DELETE", `/events/${e.id}`, undefined, "Voided")) }, "Void")]));
            }))))
        : h("p", { class: "empty" }, "No events yet"));
  }

  // -------------------------------------------------------------------------
  // Lineups: scratch/dress players, late additions

  function renderLineups() {
    const block = (which) => {
      const s = side(which);
      const search = h("input", { placeholder: "Add player: search name…" });
      const results = h("div", { class: "stack small" });
      search.addEventListener("input", BLST.debounce(async () => {
        const q = search.value.trim();
        if (q.length < 2) return mount(results);
        const found = await get(`/players?q=${encodeURIComponent(q)}&limit=8`);
        mount(results, found.map((p) => h("div", { class: "row between" }, `${p.first_name} ${p.last_name}${p.position ? ` (${p.position})` : ""}`,
          h("button", { class: "sm", onclick: async () => {
            const v = await formSheet(`Add ${p.first_name} ${p.last_name} to ${s.name}`, [
              { name: "jersey_number", label: "Jersey number for this game", type: "number", min: 0, max: 99, value: p.preferred_number ?? "" },
            ], { submitLabel: "Add to lineup" });
            if (v) quiet(act("PATCH", "/lineup", { player_id: p.id, team_id: s.id, jersey_number: v.jersey_number ?? undefined }, "Added to lineup"));
          } }, "Add"))));
      }, 250));
      return h("div", null,
        h("h3", null, BLST.teamMark(s), s.name),
        h("table", null, h("tbody", null, snap.lineups[which].map((p) =>
          h("tr", null,
            h("td", { class: "num mono" }, p.number ?? ""),
            h("td", null, p.name, p.position ? h("span", { class: "muted small" }, ` ${p.position}`) : ""),
            h("td", { class: "num" }, h("label", { class: "inline" },
              h("input", { type: "checkbox", checked: p.dressed, disabled: snap.game.status === "scheduled",
                onchange: (ev) => quiet(act("PATCH", "/lineup", { player_id: p.player_id, dressed: ev.target.checked })) }), "Dressed")))))),
        snap.game.status === "scheduled" ? h("p", { class: "muted small" }, "The lineup is copied from the team roster when the game starts.") : [search, results]);
    };
    mount(lineupCard, h("details", null, h("summary", null, h("strong", null, "Lineups")), h("div", { class: "grid two", style: { marginTop: "12px" } }, block("away"), block("home"))));
  }

  // -------------------------------------------------------------------------

  const es = stream({ game_id: gameId }, { snapshot: (s) => apply(s) });
  pill = BLST.connectionPill(es);
})().catch((err) => BLST.toast(err.message, true));

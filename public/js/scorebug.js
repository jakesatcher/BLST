/*
 * Broadcast-style score overlay ("scorebug") driven by BLST's live feed.
 * Used by the watch page, the pop-out scorebug window and overlay.html
 * (OBS browser source).
 *
 * Video streams run behind real time (LiveBarn is typically 10–30s), so the
 * bug can hold every update back by `delay` seconds: snapshots are queued as
 * they arrive and each is shown `delay` seconds later, with the clock and
 * penalty timers wound back to match. That way a goal never shows on the
 * overlay before it happens on the video.
 */
(function () {
  const { stream, fmtClock, fmtSec, logoUrl } = window.BLST;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const abbr = (t) => (t.short_name || t.name || "").slice(0, 4).toUpperCase() || "—";

  const DEFAULTS = { position: "bl", size: "m", shots: true, penalties: true, animations: true, tournamentLogo: true };

  function create(root, { gameId, delaySec = 0, options = {} } = {}) {
    let opts = { ...DEFAULTS, ...options };
    let delayMs = Math.max(0, delaySec * 1000);
    const queue = []; // { t, snap } in arrival order
    let shown = null; // entry currently displayed
    let shownIds = null; // event ids in the displayed snapshot
    const firstSeen = new Map(); // event id -> performance.now() when it first arrived
    let initialIds = null;
    const banners = [];
    let bannerBusy = false;

    root.classList.add("sb-root");
    const bug = el("div", "sb");
    const row = el("div", "sb-row");
    const tlogo = el("img", "sb-tlogo");
    tlogo.alt = "";
    const team = (side) => {
      const box = el("div", `sb-team sb-${side}`);
      const chip = el("div", "sb-chip");
      const img = el("img");
      img.alt = "";
      const chipText = el("span");
      chip.append(img, chipText);
      const name = el("span", "sb-abbr");
      const score = el("span", "sb-score");
      box.append(chip, name, score);
      return { box, chip, img, chipText, name, score, last: null };
    };
    const away = team("away");
    const home = team("home");
    const clock = el("div", "sb-clock");
    const per = el("span", "sb-per");
    const time = el("span", "sb-time");
    clock.append(per, time);
    row.append(tlogo, away.box, home.box, clock);
    const strip = el("div", "sb-strip");
    bug.append(row, strip);
    const banner = el("div", "sb-banner");
    root.append(bug, banner);
    applyOptions();

    function applyOptions() {
      root.dataset.pos = opts.position;
      root.dataset.size = opts.size;
      root.classList.toggle("sb-hidden", opts.hidden === true);
    }

    // ---- feed -----------------------------------------------------------
    const es = stream({ game_id: gameId }, {
      snapshot: (snap) => {
        const t = performance.now();
        for (const e of snap.events) if (!firstSeen.has(e.id)) firstSeen.set(e.id, t);
        if (!initialIds) initialIds = new Set(snap.events.map((e) => e.id));
        queue.push({ t, snap });
        // The very first snapshot shows straight away so the bug isn't blank
        // while the delay fills up.
        if (!shown) display(queue[queue.length - 1], { quiet: true });
      },
    });

    function pickEntry(now) {
      const target = now - delayMs;
      let pick = null;
      for (const q of queue) if (q.t <= target) pick = q;
      if (!pick) return shown;
      // Forget anything older than what's on screen.
      while (queue.length && queue[0] !== pick) queue.shift();
      return pick;
    }

    function remainingMs(entry, now) {
      const g = entry.snap.game;
      if (!g.clock_running) return g.clock_remaining_ms;
      const elapsed = now - delayMs - entry.t; // may be negative right after load
      return Math.min(g.period_length_sec * 1000, Math.max(0, g.clock_remaining_ms - elapsed));
    }

    // ---- rendering --------------------------------------------------------
    function setTeam(view, t, score, other) {
      view.box.style.setProperty("--c", t.color || "#56627a");
      const url = logoUrl("teams", t.id, t.logo_version);
      if (url) {
        if (view.img.getAttribute("src") !== url) view.img.src = url;
        view.img.hidden = false;
        view.chipText.textContent = "";
      } else {
        view.img.hidden = true;
        view.chipText.textContent = abbr(t).slice(0, 1);
      }
      view.name.textContent = abbr(t);
      if (view.last !== null && score > view.last && opts.animations) {
        view.score.classList.remove("bump");
        void view.score.offsetWidth;
        view.score.classList.add("bump");
      }
      view.last = score;
      view.score.textContent = score;
      view.box.classList.toggle("sb-pp", Boolean(other));
    }

    function display(entry, { quiet = false } = {}) {
      const prev = shown;
      shown = entry;
      const s = entry.snap;
      const ppAway = s.away.skaters_on_ice > s.home.skaters_on_ice && s.game.status !== "final";
      const ppHome = s.home.skaters_on_ice > s.away.skaters_on_ice && s.game.status !== "final";
      setTeam(away, s.away, s.away.score, ppAway);
      setTeam(home, s.home, s.home.score, ppHome);
      const tUrl = opts.tournamentLogo && s.tournament.logo_version ? logoUrl("tournaments", s.tournament.id, s.tournament.logo_version) : null;
      tlogo.hidden = !tUrl;
      if (tUrl && tlogo.getAttribute("src") !== tUrl) tlogo.src = tUrl;

      const ids = new Set(s.events.map((e) => e.id));
      if (!quiet && prev && opts.animations) {
        const fresh = s.events.filter((e) => !shownIds.has(e.id) && !initialIds?.has(e.id));
        for (const e of fresh.slice(-3)) {
          if (e.type === "goal" || (e.type === "penalty_shot" && e.result === "goal")) banners.push(goalBanner(s, e));
          else if (e.type === "penalty" && opts.penalties) banners.push(penaltyBanner(s, e));
        }
        if (prev.snap.game.status !== "final" && s.game.status === "final") banners.push(finalBanner(s));
        runBanners();
      }
      shownIds = ids;
      tick();
    }

    function stripText(s, now) {
      const g = s.game;
      if (g.status === "final") {
        return { text: `FINAL${g.decision && g.decision !== "REG" ? ` / ${g.decision}` : ""}${opts.shots ? ` · SOG ${s.away.shots}–${s.home.shots}` : ""}`, cls: "final" };
      }
      if (g.status === "scheduled") return { text: s.tournament.name, cls: "" };
      if (g.status === "intermission") return { text: `END OF ${g.period_label.toUpperCase()}${opts.shots ? ` · SOG ${s.away.shots}–${s.home.shots}` : ""}`, cls: "" };
      const absNow = g.period_start_abs + (g.period_length_sec - remainingMs(shown, now) / 1000);
      for (const [side, other] of [["away", "home"], ["home", "away"]]) {
        if (s[side].skaters_on_ice > s[other].skaters_on_ice) {
          const theirs = s.active_penalties.filter((p) => p.team_id === s[other].id && p.affects_strength && !p.queued);
          const left = theirs.length ? Math.max(0, Math.min(...theirs.map((p) => p.end_abs - absNow))) : null;
          const strength = `${s[side].skaters_on_ice}-ON-${s[other].skaters_on_ice}`;
          return { text: `POWER PLAY · ${abbr(s[side])}${left != null ? ` ${fmtSec(left)}` : ""} · ${strength}`, cls: "pp", color: s[side].color };
        }
      }
      for (const side of ["away", "home"]) {
        if (!s[side].goalie) return { text: `${abbr(s[side])} EMPTY NET`, cls: "en", color: s[side].color };
      }
      if (opts.shots) return { text: `SHOTS ${abbr(s.away)} ${s.away.shots} · ${abbr(s.home)} ${s.home.shots}`, cls: "" };
      return null;
    }

    function tick() {
      const now = performance.now();
      const next = pickEntry(now);
      if (next && next !== shown) display(next);
      if (!shown) return;
      const s = shown.snap;
      const g = s.game;
      if (g.status === "scheduled") {
        per.textContent = "";
        time.textContent = g.scheduled_at ? new Date(g.scheduled_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "SOON";
      } else if (g.status === "final") {
        per.textContent = "";
        time.textContent = "FINAL";
      } else {
        per.textContent = g.status === "intermission" ? "INT" : g.period_label.toUpperCase();
        time.textContent = g.status === "intermission" ? fmtSec(0) : fmtClock(remainingMs(shown, now));
      }
      clock.classList.toggle("stopped", !g.clock_running);
      const st = stripText(s, now);
      strip.hidden = !st;
      if (st) {
        if (strip.textContent !== st.text) strip.textContent = st.text;
        strip.className = `sb-strip ${st.cls}`;
        strip.style.setProperty("--c", st.color || "");
      }
    }
    const timer = setInterval(tick, 100);

    // ---- banners ----------------------------------------------------------
    function teamOf(s, id) {
      return id === s.home.id ? s.home : s.away;
    }
    function goalBanner(s, e) {
      const t = teamOf(s, e.team_id);
      const tags = [e.strength === "PP" ? "POWER-PLAY GOAL" : e.strength === "SH" ? "SHORTHANDED GOAL" : null, e.empty_net ? "EMPTY NET" : null, e.type === "penalty_shot" ? "PENALTY SHOT" : null].filter(Boolean);
      const assists = (e.assists || []).map((a) => a.name.replace(/^#\d+\s/, "")).join(", ");
      return { kind: "goal", ms: 7000, color: t.color, team: t, title: "GOAL!", line1: e.player ? e.player.name : t.name, line2: [assists ? `Assists: ${assists}` : e.player ? "Unassisted" : "", tags.join(" · ")].filter(Boolean).join("  ·  "), score: `${abbr(s.away)} ${s.away.score} – ${s.home.score} ${abbr(s.home)}` };
    }
    function penaltyBanner(s, e) {
      const t = teamOf(s, e.team_id);
      return { kind: "pen", ms: 5000, color: t.color, team: t, title: "PENALTY", line1: e.player ? e.player.name : `${t.name} bench`, line2: `${e.infraction || e.penalty_severity} · ${e.penalty_minutes} min` };
    }
    function finalBanner(s) {
      const w = s.game.winner_team_id ? teamOf(s, s.game.winner_team_id) : null;
      return { kind: "final", ms: 9000, color: w ? w.color : "#222", team: w, title: "FINAL", line1: `${s.away.name} ${s.away.score} – ${s.home.score} ${s.home.name}`, line2: w ? `${w.name} win${s.game.decision && s.game.decision !== "REG" ? ` in ${s.game.decision}` : ""}` : "Tie game" };
    }
    function runBanners() {
      if (bannerBusy || !banners.length) return;
      const b = banners.shift();
      bannerBusy = true;
      banner.replaceChildren();
      banner.className = `sb-banner show ${b.kind}`;
      banner.style.setProperty("--c", b.color || "#0b63ce");
      const logo = b.team && logoUrl("teams", b.team.id, b.team.logo_version);
      if (logo) {
        const i = el("img", "sb-banner-logo");
        i.src = logo;
        i.alt = "";
        banner.append(i);
      }
      const text = el("div", "sb-banner-text");
      text.append(el("div", "sb-banner-title", b.title), el("div", "sb-banner-l1", b.line1));
      if (b.line2) text.append(el("div", "sb-banner-l2", b.line2));
      banner.append(text);
      if (b.score) banner.append(el("div", "sb-banner-score", b.score));
      setTimeout(() => {
        banner.className = "sb-banner";
        setTimeout(() => {
          bannerBusy = false;
          runBanners();
        }, 450);
      }, b.ms);
    }

    // ---- controls ---------------------------------------------------------
    return {
      setDelay(sec) {
        delayMs = Math.max(0, Math.min(300, sec)) * 1000;
        tick();
      },
      getDelay: () => delayMs / 1000,
      setOptions(o) {
        opts = { ...opts, ...o };
        applyOptions();
        tick();
      },
      /** Sets the delay so the newest goal shows now: tap it when the goal happens on the video. */
      syncToLastGoal() {
        const latest = queue.length ? queue[queue.length - 1].snap : shown?.snap;
        if (!latest) return null;
        const goals = latest.events.filter((e) => (e.type === "goal" || (e.type === "penalty_shot" && e.result === "goal")) && !initialIds?.has(e.id));
        const last = goals.sort((a, b) => firstSeen.get(b.id) - firstSeen.get(a.id))[0];
        if (!last) return null;
        const sec = Math.round((performance.now() - firstSeen.get(last.id)) / 1000);
        this.setDelay(sec);
        return sec;
      },
      latest: () => (queue.length ? queue[queue.length - 1].snap : shown?.snap) || null,
      eventSource: es,
      destroy() {
        clearInterval(timer);
        es.close();
      },
    };
  }

  window.BLSTScorebug = { create, DEFAULTS };
})();

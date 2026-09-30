/* Shared client helpers for every BLST page. No framework, no build step. */
(function () {
  const TOKEN_KEY = "blst.token";

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }
  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: token lasts for this page only */
    }
  }

  async function api(method, path, body) {
    const headers = {};
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return null;
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  const get = (path) => api("GET", path);

  /** h("div", {class: "x", onclick}, "text", child, [more]) — text is never parsed as HTML. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "class") el.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k === "value") el.value = v;
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  function mount(el, ...children) {
    el.replaceChildren();
    append(el, children);
    return el;
  }
  const $ = (sel, root = document) => root.querySelector(sel);
  const param = (name) => new URLSearchParams(location.search).get(name);

  function fmtClock(ms) {
    const total = Math.max(0, ms);
    if (total < 60000 && total > 0) {
      const tenths = Math.floor(total / 100);
      return `${Math.floor(tenths / 10)}.${tenths % 10}`;
    }
    const s = Math.ceil(total / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function fmtSec(sec) {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function fmtPct(v, places = 3) {
    if (v === null || v === undefined) return "—";
    return places === 3 ? v.toFixed(3).replace(/^0/, "") : `${(v * 100).toFixed(1)}%`;
  }
  function fmtDate(v, opts) {
    if (!v) return "TBD";
    return new Date(v).toLocaleString(undefined, opts || { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function fmtDay(v) {
    if (!v) return "Unscheduled";
    return new Date(v).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }

  /**
   * Local clock for a snapshot: the server sends remaining ms at send time,
   * so we count down from when it arrived instead of trusting device time.
   */
  function clockFrom(game) {
    const receivedAt = performance.now();
    return () => (game.clock_running ? Math.max(0, game.clock_remaining_ms - (performance.now() - receivedAt)) : game.clock_remaining_ms);
  }

  /** EventSource wrapper; the browser reconnects on its own after drops. */
  function stream(query, handlers) {
    const es = new EventSource(`/api/v1/stream?${new URLSearchParams(query)}`);
    for (const [event, fn] of Object.entries(handlers)) {
      es.addEventListener(event, (e) => {
        try {
          fn(JSON.parse(e.data));
        } catch (err) {
          console.error(err);
        }
      });
    }
    return es;
  }

  let toastTimer;
  function toast(message, isError) {
    let el = $(".toast");
    if (!el) {
      el = h("div", { class: "toast", role: "status" });
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle("error", Boolean(isError));
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), isError ? 5000 : 2200);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function statusBadge(g) {
    if (g.status === "live") return h("span", { class: "badge live" }, "Live");
    if (g.status === "intermission") return h("span", { class: "badge live" }, "Int");
    if (g.status === "final") return h("span", { class: "badge final" }, g.decision && g.decision !== "REG" ? `Final/${g.decision}` : "Final");
    return h("span", { class: "badge" }, "Sched");
  }

  function teamDot(color) {
    return h("span", { class: "dot", style: { background: color || "var(--muted)" } });
  }

  /**
   * Sortable table. columns: [{key, label, num?, fmt?(row), sort?: false}]
   */
  function table(columns, rows, { sortKey, sortDir = -1, rowClass, onRow } = {}) {
    let key = sortKey;
    let dir = sortDir;
    const wrap = h("div", { class: "table-wrap" });
    function render() {
      const sorted = key
        ? [...rows].sort((a, b) => {
            const av = a[key];
            const bv = b[key];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return typeof av === "string" ? dir * av.localeCompare(bv) : dir * (av - bv);
          })
        : rows;
      const thead = h(
        "thead",
        null,
        h(
          "tr",
          null,
          columns.map((c) =>
            h(
              "th",
              {
                class: [c.num ? "num" : "", c.sort === false ? "" : "sortable", key === c.key ? "sorted" : ""].join(" "),
                title: c.title,
                onclick:
                  c.sort === false
                    ? null
                    : () => {
                        if (key === c.key) dir = -dir;
                        else {
                          key = c.key;
                          dir = c.num ? -1 : 1;
                        }
                        render();
                      },
              },
              c.label,
              key === c.key ? (dir < 0 ? " ▾" : " ▴") : "",
            ),
          ),
        ),
      );
      const tbody = h(
        "tbody",
        null,
        sorted.length
          ? sorted.map((r) =>
              h(
                "tr",
                { class: rowClass ? rowClass(r) : null, onclick: onRow ? () => onRow(r) : null, style: onRow ? { cursor: "pointer" } : null },
                columns.map((c) => h("td", { class: c.num ? "num" : null }, c.fmt ? c.fmt(r) : r[c.key] ?? "")),
              ),
            )
          : h("tr", null, h("td", { colspan: columns.length, class: "empty" }, "Nothing here yet")),
      );
      mount(wrap, h("table", null, thead, tbody));
    }
    render();
    return wrap;
  }

  function topbar(active) {
    const links = [
      ["index", "/", "Scores"],
      ["scorekeeper", "/scorekeeper.html", "Scorekeeper"],
      ["admin", "/admin.html", "Admin"],
      ["docs", "/api.html", "API"],
    ];
    return h(
      "header",
      { class: "topbar" },
      h("a", { class: "brand", href: "/" }, "BLST"),
      h("nav", null, links.map(([id, href, label]) => h("a", { href, class: id === active ? "active" : null }, label))),
    );
  }

  function tabs(names, onChange, initial) {
    const bar = h("div", { class: "tabs", role: "tablist" });
    let current = initial || names[0][0];
    function render() {
      mount(
        bar,
        names.map(([id, label]) =>
          h("button", { role: "tab", class: id === current ? "active" : null, "aria-selected": id === current ? "true" : "false",
            onclick: () => { current = id; render(); onChange(id); } }, label),
        ),
      );
    }
    render();
    return { el: bar, get current() { return current; }, set(id) { current = id; render(); onChange(id); } };
  }

  window.BLST = {
    api, get, getToken, setToken, h, mount, append, $, param, fmtClock, fmtSec, fmtPct, fmtDate, fmtDay,
    clockFrom, stream, toast, debounce, statusBadge, teamDot, table, topbar, tabs,
  };
})();

/* Game list cards, shared by the home and tournament pages. */
(function () {
  const { h, mount, statusBadge, teamDot, fmtClock, fmtDate } = window.BLST;

  function periodLabel(period, periods) {
    if (period <= periods) return ["1st", "2nd", "3rd", "4th"][period - 1] || `P${period}`;
    const ot = period - periods;
    return ot === 1 ? "OT" : `${ot}OT`;
  }

  /** Keeps a list of games live: call update(summary) with SSE game.summary payloads. */
  function gameCards(games, { showTournament } = {}) {
    const root = h("div", { class: "games" });
    const byId = new Map();
    const cards = new Map();
    const clocks = new Map();

    function setClock(g, remainingMs, running) {
      const at = performance.now();
      clocks.set(g.id, () => (running ? Math.max(0, remainingMs - (performance.now() - at)) : remainingMs));
    }
    function initialRemaining(g) {
      if (!g.clock_running || !g.clock_started_at) return g.clock_remaining_ms;
      return Math.max(0, g.clock_remaining_ms - (Date.now() - new Date(g.clock_started_at).getTime()));
    }
    function render(g) {
      const live = g.status === "live" || g.status === "intermission";
      const card = h(
        "a",
        { class: "card game-card", href: `/game.html?id=${g.id}` },
        h("div", { class: "line" }, h("span", null, teamDot(g.away_color), g.away_team), h("span", { class: "score" }, g.status === "scheduled" ? "" : g.away_score)),
        h("div", { class: "line" }, h("span", null, teamDot(g.home_color), g.home_team), h("span", { class: "score" }, g.status === "scheduled" ? "" : g.home_score)),
        h(
          "div",
          { class: "meta" },
          h("span", null, statusBadge(g), " ",
            live ? h("span", { class: "mono", "data-clock": g.id }, `${periodLabel(g.period, g.periods || 3)} ${g.status === "intermission" ? "INT" : ""}`) : fmtDate(g.scheduled_at)),
          h("span", null, showTournament ? g.tournament_name : g.venue || (g.game_type !== "pool" ? g.game_type : "")),
        ),
      );
      return card;
    }
    function draw() {
      mount(root, games.length ? games.map((g) => {
        const c = render(g);
        cards.set(g.id, c);
        return c;
      }) : h("div", { class: "empty" }, "No games"));
    }
    for (const g of games) {
      byId.set(g.id, g);
      setClock(g, initialRemaining(g), g.clock_running);
    }
    draw();

    const ticker = setInterval(() => {
      for (const g of games) {
        if (g.status !== "live" && g.status !== "intermission") continue;
        const el = root.querySelector(`[data-clock="${g.id}"]`);
        if (!el) continue;
        const label = periodLabel(g.period, g.periods || 3);
        el.textContent = g.status === "intermission" ? `${label} INT` : `${label} ${fmtClock(clocks.get(g.id)())}`;
      }
    }, 200);

    return {
      el: root,
      has: (id) => byId.has(id),
      update(s) {
        const g = byId.get(s.game_id);
        if (!g) return false;
        Object.assign(g, {
          status: s.status, period: s.period, decision: s.decision, clock_running: s.clock_running,
          home_score: s.home.score, away_score: s.away.score,
        });
        setClock(g, s.clock_remaining_ms, s.clock_running);
        const fresh = render(g);
        cards.get(g.id).replaceWith(fresh);
        cards.set(g.id, fresh);
        return true;
      },
      stop: () => clearInterval(ticker),
    };
  }

  Object.assign(window.BLST, { gameCards, periodLabel });
})();

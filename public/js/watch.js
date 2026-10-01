(async function () {
  const { h, mount, get, $, param, topbar, toast, fmtDate } = BLST;
  $("#top").replaceWith(topbar("index"));
  const app = $("#app");
  const id = Number(param("game"));
  if (!id) return mount(app, h("p", { class: "notice error" }, "Missing game id"));

  const snap = await get(`/games/${id}`);
  const stream = snap.stream;

  // Per-viewer settings, remembered on this device.
  const load = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v ?? d;
    } catch {
      return d;
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  };
  const prefs = { position: "bl", size: "m", shots: true, penalties: true, animations: true, overlay: true, ...load("blst.watch.prefs", {}) };
  let delay = load(`blst.watch.delay.${id}`, stream?.delay_sec ?? 0);

  document.title = `${snap.away.short_name || snap.away.name} @ ${snap.home.short_name || snap.home.name} · Watch · BLST`;

  // ---- stage: video + overlay ---------------------------------------------
  const stage = h("div", { class: "watch-stage" });
  const media = h("div", { class: "watch-media" });
  const overlayHost = h("div", { class: "watch-overlay" });
  const exitTheater = h("button", { class: "watch-exit", type: "button", onclick: () => setTheater(false) }, "✕ Exit full screen");
  stage.append(media, overlayHost, exitTheater);

  if (stream && stream.embed_url) mountPlayer(stream);
  else mountPlaceholder();

  function mountPlayer(s) {
    if (s.kind === "iframe") {
      media.append(h("iframe", {
        src: s.embed_url, title: "Live stream", allow: "autoplay; fullscreen; picture-in-picture; encrypted-media",
        allowfullscreen: true, referrerpolicy: "strict-origin-when-cross-origin",
      }));
      return;
    }
    const video = h("video", { controls: true, autoplay: true, muted: true, playsinline: true });
    media.append(video);
    if (s.kind === "video" || video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = s.embed_url;
      return;
    }
    // HLS outside Safari: load hls.js on demand.
    const script = h("script", { src: "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js" });
    script.onload = () => {
      if (!window.Hls || !window.Hls.isSupported()) return toast("This browser can't play the stream", true);
      const hls = new window.Hls({ liveSyncDurationCount: 3 });
      hls.loadSource(s.embed_url);
      hls.attachMedia(video);
    };
    script.onerror = () => toast("Couldn't load the video player", true);
    document.head.append(script);
  }

  function mountPlaceholder() {
    const lb = stream && stream.livebarn_url;
    mount(media, h("div", { class: "watch-placeholder" },
      lb
        ? [
            h("div", { class: "watch-ph-title" }, "This rink streams on LiveBarn"),
            h("p", null, "LiveBarn video needs your own LiveBarn subscription, so it plays in LiveBarn. BLST adds the live score next to it."),
            h("div", { class: "row", style: { justifyContent: "center" } },
              h("a", { class: "btn primary", href: lb, target: "_blank", rel: "noopener" }, "Watch on LiveBarn ↗"),
              h("button", { type: "button", onclick: popOut }, "Pop out live scorebug")),
          ]
        : [
            h("div", { class: "watch-ph-title" }, "No video linked for this game yet"),
            h("p", null, "The live scorebug below works on its own. Admins can add a stream under Admin & setup → Streams."),
          ]));
  }

  // ---- overlay -------------------------------------------------------------
  const bug = BLSTScorebug.create(overlayHost, {
    gameId: id,
    delaySec: delay,
    options: { position: prefs.position, size: prefs.size, shots: prefs.shots, penalties: prefs.penalties, animations: prefs.animations, hidden: !prefs.overlay },
  });
  const setPref = (k, v) => {
    prefs[k] = v;
    save("blst.watch.prefs", prefs);
    bug.setOptions({ [k]: v, hidden: !prefs.overlay });
  };

  // ---- full screen (keeps the overlay; falls back to "theater" on iPhone) --
  function setTheater(on) {
    stage.classList.toggle("theater", on);
    document.body.classList.toggle("no-scroll", on);
  }
  function fullscreen() {
    const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (req && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
      Promise.resolve(req.call(stage)).catch(() => setTheater(true));
    } else setTheater(true);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setTheater(false);
  });

  // ---- pop-out scorebug ----------------------------------------------------
  let pipBug = null;
  async function popOut() {
    const d = bug.getDelay();
    if ("documentPictureInPicture" in window) {
      try {
        const pip = await window.documentPictureInPicture.requestWindow({ width: 560, height: 120 });
        const link = pip.document.createElement("link");
        link.rel = "stylesheet";
        link.href = `${location.origin}/css/overlay.css`;
        pip.document.head.append(link);
        pip.document.title = "BLST scorebug";
        pip.document.body.className = "sb-page dark fill";
        const host = pip.document.createElement("div");
        host.className = "sb-stage";
        pip.document.body.append(host);
        pipBug = BLSTScorebug.create(host, { gameId: id, delaySec: d, options: { position: "fill", size: prefs.size, shots: prefs.shots, penalties: prefs.penalties, animations: prefs.animations } });
        pip.addEventListener("pagehide", () => {
          pipBug?.destroy();
          pipBug = null;
        });
        return;
      } catch {
        /* fall through to a normal window */
      }
    }
    const url = `/overlay.html?game=${id}&pos=fill&bg=dark&delay=${d}&size=${prefs.size}${prefs.shots ? "" : "&shots=0"}`;
    const w = window.open(url, `blst-scorebug-${id}`, "popup,width=560,height=140");
    if (!w) location.href = url;
  }

  // ---- controls ------------------------------------------------------------
  const delayOut = h("strong", { class: "mono" });
  const showDelay = () => (delayOut.textContent = `${bug.getDelay()} s`);
  const setDelay = (v) => {
    delay = Math.max(0, Math.min(300, Math.round(v)));
    bug.setDelay(delay);
    if (pipBug) pipBug.setDelay(delay);
    save(`blst.watch.delay.${id}`, delay);
    showDelay();
  };
  showDelay();
  const sel = (value, options, onchange) =>
    h("select", { onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
  const check = (key, label) => h("label", { class: "inline" }, h("input", { type: "checkbox", checked: prefs[key], onchange: (e) => setPref(key, e.target.checked) }), label);
  const overlayToggle = h("button", { type: "button", onclick: () => {
    setPref("overlay", !prefs.overlay);
    overlayToggle.textContent = prefs.overlay ? "Hide overlay" : "Show overlay";
  } }, prefs.overlay ? "Hide overlay" : "Show overlay");
  const obsUrl = `${location.origin}/overlay.html?game=${id}`;

  mount(app,
    h("div", { class: "row between", style: { marginBottom: "10px" } },
      h("div", null,
        h("h1", { style: { margin: 0 } }, `${snap.away.name} @ ${snap.home.name}`),
        h("div", { class: "muted small" }, [snap.tournament.name, snap.game.venue, snap.game.scheduled_at ? fmtDate(snap.game.scheduled_at) : null].filter(Boolean).join(" · "))),
      h("a", { href: `/game.html?id=${id}` }, "Box score & play-by-play →")),
    stage,
    h("div", { class: "card watch-controls" },
      h("div", { class: "row" },
        h("button", { type: "button", class: "primary", onclick: fullscreen }, "⛶ Full screen"),
        overlayToggle,
        h("button", { type: "button", onclick: popOut }, "Pop out scorebug"),
        stream && stream.livebarn_url ? h("a", { class: "btn", href: stream.livebarn_url, target: "_blank", rel: "noopener" }, "Watch on LiveBarn ↗") : ""),
      h("div", { class: "row", style: { marginTop: "12px" } },
        h("label", null, "Position", sel(prefs.position, [["bl", "Bottom left"], ["br", "Bottom right"], ["tl", "Top left"], ["tr", "Top right"], ["top", "Top center"], ["bottom", "Bottom center"]], (v) => setPref("position", v))),
        h("label", null, "Size", sel(prefs.size, [["s", "Small"], ["m", "Medium"], ["l", "Large"]], (v) => setPref("size", v))),
        h("div", { class: "stack" }, check("shots", "Shots on goal"), check("penalties", "Penalty banners"), check("animations", "Goal animations"))),
      h("div", { class: "watch-delay" },
        h("div", null, h("strong", null, "Stream delay "), delayOut,
          h("div", { class: "muted small" }, "Video runs behind live scoring, so the overlay waits this long before showing updates. When you see the latest goal go in on the video, tap “Sync to last goal”.")),
        h("div", { class: "row" },
          h("button", { type: "button", onclick: () => setDelay(bug.getDelay() - 5) }, "−5s"),
          h("button", { type: "button", onclick: () => setDelay(bug.getDelay() - 1) }, "−1s"),
          h("button", { type: "button", onclick: () => setDelay(bug.getDelay() + 1) }, "+1s"),
          h("button", { type: "button", onclick: () => setDelay(bug.getDelay() + 5) }, "+5s"),
          h("button", { type: "button", class: "primary", onclick: () => {
            const s = bug.syncToLastGoal();
            if (s == null) return toast("No goal since you opened this page yet. Use the +/− buttons, or tap this right as the next goal goes in.", true);
            setDelay(s);
            toast(`Synced: overlay now ${s}s behind live`);
          } }, "⚡ Sync to last goal"))),
      h("details", { style: { marginTop: "12px" } },
        h("summary", null, "Watching LiveBarn on an iPad?"),
        h("ol", { class: "small" },
          h("li", null, "Open the LiveBarn app (or livebarn.com) on this rink's camera."),
          h("li", null, "Swipe up from the bottom to show the Dock, then drag Safari onto the side of the screen (Split View or Slide Over)."),
          h("li", null, "In that Safari window open the compact scorebug: ", h("a", { href: `/overlay.html?game=${id}&pos=fill&bg=dark&delay=${delay}`, target: "_blank" }, "open scorebug"), "."),
          h("li", null, "Adjust the delay above (or add &delay=20 to the scorebug link) so the score changes when the puck goes in on the video."))),
      h("details", { style: { marginTop: "8px" } },
        h("summary", null, "Broadcast overlay for OBS / streaming software"),
        h("p", { class: "small muted" }, "Add a Browser Source at 1920×1080 with this URL. The background is transparent. Options: &pos=bl|br|tl|tr|top|bottom, &size=s|m|l, &delay=seconds, &shots=0, &pens=0, &bg=green for chroma key. Re-broadcasting LiveBarn video needs LiveBarn's permission; this is meant for your own camera or a licensed feed."),
        h("input", { value: obsUrl, readonly: true, style: { width: "100%" }, onclick: (e) => e.target.select() }))));
})().catch((err) => BLST.toast(err.message, true));

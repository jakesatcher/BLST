/*
 * Standalone scorebug.
 *   /overlay.html?game=12                     transparent, bottom-left (OBS browser source, 1920×1080)
 *   &pos=bl|br|tl|tr|top|bottom|fill          placement ("fill" = scorebug fills a small window)
 *   &size=s|m|l  &delay=20  &bg=transparent|dark|green  &shots=0  &pens=0  &anim=0  &tlogo=0
 */
(function () {
  const q = new URLSearchParams(location.search);
  const gameId = Number(q.get("game"));
  const stage = document.getElementById("stage");
  if (!gameId) {
    stage.textContent = "Add ?game=<id> to the URL";
    stage.style.cssText = "color:#fff;font:16px system-ui;padding:16px";
    return;
  }
  const pos = q.get("pos") || "bl";
  document.body.classList.add(q.get("bg") || "transparent");
  if (pos === "fill") document.body.classList.add("fill");
  const off = (k) => q.get(k) === "0" || q.get(k) === "false";
  BLSTScorebug.create(stage, {
    gameId,
    delaySec: Number(q.get("delay")) || 0,
    options: { position: pos, size: q.get("size") || "m", shots: !off("shots"), penalties: !off("pens"), animations: !off("anim"), tournamentLogo: !off("tlogo") },
  });
})();

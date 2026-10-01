const { badRequest } = require("./http");
const { safeFetch } = require("./netguard");

/**
 * Cleans up a pasted video link so it can be played on the watch page:
 * YouTube watch/live/short links become embed links; .m3u8/.mp4 play in a
 * <video>; anything else is used as an iframe embed as-is.
 */
function normalizeEmbedUrl(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === "") return null;
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw badRequest("embed URL is not a valid link");
  }
  if (u.protocol !== "https:") throw badRequest("embed URL must start with https:// (browsers block insecure video on secure pages)");
  const host = u.hostname.replace(/^www\.|^m\./, "");
  let id = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = /^\/(live|shorts|embed)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[2];
    }
  }
  if (id && /^[\w-]{6,20}$/.test(id)) return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1`;
  return u.toString();
}

function embedKind(url) {
  if (!url) return null;
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".m3u8")) return "hls";
  if (/\.(mp4|webm|mov)$/.test(path)) return "video";
  return "iframe";
}

function normalizeLinkUrl(raw, name) {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === "") return null;
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw badRequest(`${name} is not a valid link`);
  }
  if (!["http:", "https:"].includes(u.protocol)) throw badRequest(`${name} must be an http(s) link`);
  return u.toString();
}

function isLiveBarn(url) {
  try {
    return /(^|\.)livebarn\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Asks the site whether it may be shown inside another page. Only the
 * response headers are looked at; nothing from the page is returned.
 * embeddable: true | false | null (couldn't tell).
 */
async function checkEmbeddable(url, { timeoutMs = 8000, allowPrivate } = {}) {
  const kind = embedKind(url);
  if (kind === "hls" || kind === "video") return { embeddable: true, kind, reason: "Direct video file: plays in the built-in player (the host must allow cross-site playback)." };
  let res;
  try {
    // SSRF-safe: only public addresses, every redirect hop re-checked.
    res = await safeFetch(url, { method: "GET", headers: { "user-agent": "BLST-embed-check/1.0" }, signal: AbortSignal.timeout(timeoutMs) }, { maxRedirects: 3, allowPrivate });
  } catch (err) {
    if (err.status === 400) return { embeddable: false, kind, reason: err.message };
    return { embeddable: null, kind, reason: "Couldn't reach the link. It may still work in a browser." };
  }
  res.body?.cancel().catch(() => {});
  const xfo = (res.headers.get("x-frame-options") || "").toLowerCase();
  const csp = (res.headers.get("content-security-policy") || "").toLowerCase();
  const fa = /frame-ancestors\s+([^;]+)/.exec(csp);
  if (xfo.includes("deny") || xfo.includes("sameorigin")) {
    return { embeddable: false, kind, reason: `The site forbids being shown inside other pages (X-Frame-Options: ${xfo}).${isLiveBarn(url) ? " Use it as the LiveBarn link instead, so viewers open it with their own subscription." : ""}` };
  }
  if (fa) {
    const sources = fa[1].trim();
    if (sources === "'none'" || sources === "'self'") {
      return { embeddable: false, kind, reason: `The site only allows itself to be framed (frame-ancestors ${sources}).${isLiveBarn(url) ? " Use it as the LiveBarn link instead." : ""}` };
    }
    if (!sources.includes("*")) return { embeddable: null, kind, reason: `The site limits which pages may embed it (frame-ancestors ${sources}). Try it on the watch page.` };
  }
  if (!res.ok) return { embeddable: null, kind, reason: `The link answered HTTP ${res.status}. Check it's the public player link.` };
  return { embeddable: true, kind, reason: "Looks embeddable." };
}

/** Effective stream for a game: per-game overrides win over the rink's default. */
function resolveStream(game, venueStream) {
  const embed = game.stream_embed_url || venueStream?.embed_url || null;
  const livebarn = game.livebarn_url || venueStream?.livebarn_url || null;
  if (!embed && !livebarn) return null;
  return {
    venue: game.venue || null,
    embed_url: embed,
    kind: embedKind(embed),
    livebarn_url: livebarn,
    delay_sec: game.stream_delay_sec ?? venueStream?.delay_sec ?? (livebarn && !embed ? 20 : 0),
  };
}

module.exports = { normalizeEmbedUrl, normalizeLinkUrl, embedKind, isLiveBarn, checkEmbeddable, resolveStream };

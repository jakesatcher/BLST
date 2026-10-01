const dns = require("dns").promises;
const net = require("net");
const config = require("../config");
const { badRequest } = require("./http");

// SSRF protection for every request BLST makes to an admin-supplied URL
// (webhooks, the stream embed check). Targets must be http(s) and resolve
// only to public addresses: no loopback, private ranges, link-local (cloud
// metadata at 169.254.169.254), CGNAT, multicast or reserved space.

const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4ToInt(ip) {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIp(mapped[1]);
    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower) || lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8");
  }
  return true;
}

/**
 * Throws 400 unless `raw` is an http(s) URL whose host resolves only to
 * public addresses. Returns the parsed URL.
 */
async function assertPublicUrl(raw, { allowPrivate = config.allowPrivateUrls, label = "URL" } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest(`${label} is not valid`);
  }
  if (!["http:", "https:"].includes(u.protocol)) throw badRequest(`${label} must be http(s)`);
  if (u.username || u.password) throw badRequest(`${label} must not contain credentials`);
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw badRequest(`${label}: host ${host} could not be resolved`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw badRequest(`${label} points to a private or internal network address, which isn't allowed`);
  }
  return u;
}

/**
 * fetch() that re-checks every redirect hop against the SSRF rules
 * (a public URL may otherwise redirect to an internal one).
 */
async function safeFetch(url, init = {}, { maxRedirects = 3, allowPrivate } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current, { allowPrivate });
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      res.body?.cancel().catch(() => {});
      current = new URL(res.headers.get("location"), current).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

module.exports = { isPrivateIp, assertPublicUrl, safeFetch };

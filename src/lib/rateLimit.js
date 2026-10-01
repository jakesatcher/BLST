const { HttpError } = require("./http");

/**
 * Fixed-window rate limiter kept in memory (BLST runs as a single web
 * dyno; see README). Sets the standard RateLimit-* headers and answers 429
 * with Retry-After when the window's budget is spent.
 */
function rateLimit({ windowMs, max, key = (req) => req.ip, name = "requests", skip = () => false }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  function middleware(req, res, next) {
    if (skip(req)) return next();
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    const resetSec = Math.ceil((entry.reset - now) / 1000);
    res.set("RateLimit-Limit", String(max));
    res.set("RateLimit-Remaining", String(remaining));
    res.set("RateLimit-Reset", String(resetSec));
    if (entry.count > max) {
      res.set("Retry-After", String(resetSec));
      return next(new HttpError(429, `too many ${name}; try again in ${resetSec}s`));
    }
    next();
  }
  middleware.reset = () => hits.clear();
  return middleware;
}

/** Counter without middleware semantics (used for failed sign-in attempts). */
function failureCounter({ windowMs, max }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();
  return {
    blocked(k) {
      const e = hits.get(k);
      return e && e.reset > Date.now() && e.count >= max ? Math.ceil((e.reset - Date.now()) / 1000) : 0;
    },
    fail(k) {
      const now = Date.now();
      let e = hits.get(k);
      if (!e || e.reset <= now) {
        e = { count: 0, reset: now + windowMs };
        hits.set(k, e);
      }
      e.count += 1;
      return e.count;
    },
    reset: () => hits.clear(),
  };
}

module.exports = { rateLimit, failureCounter };

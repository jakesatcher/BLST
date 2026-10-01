require("dotenv").config({ quiet: true });

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));

// DYNO is set on every Heroku dyno — same "are we deployed" signal the
// BLPA Factions app uses.
const deployed = Boolean(process.env.DYNO) || process.env.NODE_ENV === "production";

module.exports = {
  port: Number(process.env.PORT || 3000),
  deployed,
  databaseUrl: process.env.DATABASE_URL || "postgresql://blst:blst@localhost:5432/blst",
  databaseSsl: bool(process.env.DATABASE_SSL, Boolean(process.env.DYNO)),
  adminToken: process.env.ADMIN_TOKEN || "",
  publicExports: bool(process.env.PUBLIC_EXPORTS, true),
  // Local development only: with no ADMIN_TOKEN, writes are refused unless
  // this is set, so a misconfigured deploy fails closed instead of open.
  allowOpenDev: !deployed && bool(process.env.ALLOW_OPEN_DEV, false),
  // Comma-separated origins allowed to call the API from a browser
  // ("*" = any; bearer tokens, not cookies, so this isn't a CSRF control).
  corsOrigins: (process.env.CORS_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean),
  // Lets webhooks / stream checks reach localhost and private networks
  // (tests, on-prem). Off by default to prevent SSRF.
  allowPrivateUrls: bool(process.env.ALLOW_PRIVATE_NETWORK_URLS, false),
  securityContact: process.env.SECURITY_CONTACT || "",
  rateLimits: {
    readsPerMinute: Number(process.env.RATE_LIMIT_READS_PER_MIN || 600),
    writesPerMinute: Number(process.env.RATE_LIMIT_WRITES_PER_MIN || 240),
    importsPerMinute: Number(process.env.RATE_LIMIT_IMPORTS_PER_MIN || 20),
    authFailuresPer15Min: Number(process.env.RATE_LIMIT_AUTH_FAILURES || 10),
    streamsPerIp: Number(process.env.MAX_STREAMS_PER_IP || 12),
    streamsTotal: Number(process.env.MAX_STREAMS_TOTAL || 5000),
  },
  factions: {
    baseUrl: (process.env.FACTIONS_BASE_URL || "").replace(/\/+$/, ""),
    adminToken: process.env.FACTIONS_ADMIN_TOKEN || "",
    autoSync: bool(process.env.FACTIONS_AUTO_SYNC, false),
  },
};

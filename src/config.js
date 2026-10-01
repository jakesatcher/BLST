require("dotenv").config({ quiet: true });

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));

// "Are we deployed?": DYNO is set on every Heroku dyno, RAILWAY_ENVIRONMENT_ID
// on every Railway service (same signals the BLPA Factions app uses).
const onHeroku = Boolean(process.env.DYNO);
const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_ID);
const deployed = onHeroku || onRailway || process.env.NODE_ENV === "production";

module.exports = {
  port: Number(process.env.PORT || 3000),
  deployed,
  platform: onHeroku ? "heroku" : onRailway ? "railway" : deployed ? "production" : "local",
  databaseUrl: process.env.DATABASE_URL || "postgresql://blst:blst@localhost:5432/blst",
  // Heroku Postgres requires TLS. Railway's private network (*.railway.internal)
  // is already encrypted and its Postgres doesn't use TLS there; set
  // DATABASE_SSL=true if you point at Railway's public proxy URL instead.
  databaseSsl: bool(process.env.DATABASE_SSL, onHeroku),
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
  auth: {
    // Keys the one-time-code hashes. Set it in production so codes survive
    // restarts; otherwise a random key is used per process.
    secret: process.env.AUTH_SECRET || require("crypto").randomBytes(32).toString("hex"),
    // Once an admin account exists, ADMIN_TOKEN stops granting admin access
    // (every admin must sign in with MFA) unless this break-glass is on.
    adminTokenBreakGlass: bool(process.env.ADMIN_TOKEN_BREAK_GLASS, false),
    sessionHours: { admin: 12, scorekeeper: 24, user: 24 * 30 },
    // Comma-separated calling codes SMS may go to (blocks SMS-pumping fraud).
    smsCountryCodes: (process.env.SMS_ALLOWED_COUNTRY_CODES || "1").split(",").map((s) => s.trim().replace(/^\+/, "")).filter(Boolean),
    smsMaxPerHour: Number(process.env.SMS_MAX_PER_HOUR || 300),
    // Development: print codes to the server log instead of sending them.
    // Never on a deployed server unless explicitly allowed.
    logCodes: bool(process.env.AUTH_LOG_CODES, !deployed),
    // Host name for the WebOTP line in texts ("@blst.example.com #123456"),
    // which lets phones offer the code automatically. Optional.
    appHost: (process.env.APP_HOST || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME || "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
  },
  email: {
    smtpUrl: process.env.SMTP_URL || "",
    from: process.env.EMAIL_FROM || "BLST <no-reply@localhost>",
  },
  sms: {
    twilioSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioToken: process.env.TWILIO_AUTH_TOKEN || "",
    twilioFrom: process.env.TWILIO_FROM_NUMBER || "",
    twilioMessagingService: process.env.TWILIO_MESSAGING_SERVICE_SID || "",
  },
  rateLimits: {
    readsPerMinute: Number(process.env.RATE_LIMIT_READS_PER_MIN || 600),
    writesPerMinute: Number(process.env.RATE_LIMIT_WRITES_PER_MIN || 240),
    importsPerMinute: Number(process.env.RATE_LIMIT_IMPORTS_PER_MIN || 20),
    authFailuresPer15Min: Number(process.env.RATE_LIMIT_AUTH_FAILURES || 10),
    // Sign-in / sign-up starts and code checks per IP (rinks share Wi-Fi, so
    // these allow a crowd; per-address caps stop targeting one person).
    authStartsPer15Min: Number(process.env.RATE_LIMIT_AUTH_STARTS || 30),
    authVerifiesPer15Min: Number(process.env.RATE_LIMIT_AUTH_VERIFIES || 90),
    streamsPerIp: Number(process.env.MAX_STREAMS_PER_IP || 12),
    streamsTotal: Number(process.env.MAX_STREAMS_TOTAL || 5000),
  },
};

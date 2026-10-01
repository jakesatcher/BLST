const crypto = require("crypto");
const config = require("../config");
const db = require("../db");

// Zero-config first boot (Railway "Deploy" button, dashboard deploys):
// nothing secret has to be typed into the platform. Each value below is
// used from its config var when set, and otherwise generated here.

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function getSetting(key) {
  const r = await db.one("SELECT value FROM integration_settings WHERE key = $1", [key]);
  return r ? r.value : null;
}
async function putSetting(key, value) {
  await db.query(
    "INSERT INTO integration_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
    [key, JSON.stringify(value)],
  );
}

/**
 * AUTH_SECRET keys the one-time-code hashes. Without the config var it is
 * generated once and kept in the database, so sign-ins in progress survive
 * restarts and every instance agrees on it.
 */
async function ensureAuthSecret() {
  if (process.env.AUTH_SECRET) return "config";
  let stored = await getSetting("auth_secret");
  if (!stored) {
    await db.query(
      "INSERT INTO integration_settings (key, value) VALUES ('auth_secret', $1) ON CONFLICT (key) DO NOTHING",
      [JSON.stringify(crypto.randomBytes(32).toString("hex"))],
    );
    stored = await getSetting("auth_secret");
  }
  config.auth.secret = stored;
  return "database";
}

const SETUP_KEY_TTL_MS = 7 * 24 * 3600e3;

/**
 * Without ADMIN_TOKEN, a one-time setup key for the first admin account is
 * generated on each boot while no admin exists, and printed to the server
 * log (only people with access to the hosting project can read it). Only
 * its hash is stored. It can do nothing except start the admin setup, and
 * stops working once an admin account exists.
 */
async function ensureSetupKey({ log = console.log } = {}) {
  const accounts = require("./accounts");
  if (config.adminToken) return null;
  if (!(await accounts.setupStatus()).needed) {
    await db.query("DELETE FROM integration_settings WHERE key = 'setup_keys'");
    return null;
  }
  const key = `setup-${crypto.randomBytes(18).toString("base64url")}`;
  // Keep a few recent keys, so instances that overlap during a deploy don't
  // invalidate each other's printed key.
  const now = Date.now();
  const keys = ((await getSetting("setup_keys")) || []).filter((k) => now - k.at < SETUP_KEY_TTL_MS).slice(-4);
  keys.push({ hash: sha256(key), at: now });
  await putSetting("setup_keys", keys);
  log("");
  log("==============================================================");
  log(` Setup key: ${key}`);
  log(" Open the site -> Admin & setup -> Set up the admin account,");
  log(" and enter this key. It works only until the first admin exists.");
  log("==============================================================");
  log("");
  return key;
}

/** True when `candidate` is a current generated setup key. */
async function checkSetupKey(candidate) {
  if (!candidate) return false;
  const keys = (await getSetting("setup_keys")) || [];
  const h = sha256(String(candidate).trim());
  return keys.some((k) => Date.now() - k.at < SETUP_KEY_TTL_MS && crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(h)));
}

module.exports = { ensureAuthSecret, ensureSetupKey, checkSetupKey };

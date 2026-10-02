const crypto = require("crypto");
const config = require("../config");
const db = require("../db");
const { HttpError, badRequest } = require("../lib/http");

// Second factor for staff (admins and scorekeepers): an authenticator app
// (TOTP, RFC 6238) and/or passkeys (WebAuthn), plus one-time backup codes.
// Ordinary accounts sign in with the emailed code alone.

const TOTP_STEP_S = 30;
const TOTP_DIGITS = 6;
const BACKUP_CODES = 10;
const ISSUER = "Beer League Stats";

const hmac = (s) => crypto.createHmac("sha256", config.auth.secret).update(s).digest("hex");

// ---------------------------------------------------------------------------
// Encryption of authenticator secrets at rest (AES-256-GCM)

function encKey() {
  return crypto.createHash("sha256").update(`blst-mfa-v1:${config.auth.secret}`).digest();
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}
function decrypt(stored) {
  const [v, iv, tag, ct] = String(stored).split(":");
  if (v !== "v1") throw new Error("unknown secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// TOTP

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_STEP_S);

/** The TOTP code for a base32 secret at a time step. */
function totpCode(secret, step = currentStep()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(n).padStart(TOTP_DIGITS, "0");
}

/** The step a code matches (now ±1 step, for clock drift), or null. */
function matchStep(secret, code) {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep();
  for (const step of [now, now - 1, now + 1]) {
    const expect = totpCode(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(code))) return step;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status

async function status(accountId) {
  const a = await db.one("SELECT totp_secret_enc IS NOT NULL AS totp FROM accounts WHERE id = $1", [accountId]);
  const passkeys = await db.many(
    "SELECT id, name, created_at, last_used_at FROM account_passkeys WHERE account_id = $1 ORDER BY created_at", [accountId]);
  const backup = await db.one(
    "SELECT count(*) FILTER (WHERE used_at IS NULL)::int AS left FROM account_backup_codes WHERE account_id = $1", [accountId]);
  return { totp: Boolean(a && a.totp), passkeys, backup_codes_left: backup ? backup.left : 0 };
}

async function hasSecondFactor(accountId) {
  const r = await db.one(
    `SELECT (SELECT totp_secret_enc IS NOT NULL FROM accounts WHERE id = $1)
            OR EXISTS (SELECT 1 FROM account_passkeys WHERE account_id = $1) AS has`, [accountId]);
  return Boolean(r && r.has);
}

/** Methods offered at sign-in (only revealed after the email code). */
async function methods(accountId) {
  const s = await status(accountId);
  return { totp: s.totp, passkey: s.passkeys.length > 0, backup_code: s.backup_codes_left > 0 };
}

// ---------------------------------------------------------------------------
// Authenticator app

async function startTotp(accountId, email) {
  const secret = base32Encode(crypto.randomBytes(20));
  await db.query("UPDATE accounts SET totp_pending_enc = $2 WHERE id = $1", [accountId, encrypt(secret)]);
  const label = encodeURIComponent(`${ISSUER}:${email}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`;
  const svg = await require("qrcode").toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { secret: secret.replace(/(.{4})/g, "$1 ").trim(), uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
}

/** Confirms the pending secret with a code from the app. Returns new backup codes if there were none. */
async function confirmTotp(accountId, rawCode) {
  const code = String(rawCode || "").replace(/\s/g, "");
  const a = await db.one("SELECT totp_pending_enc FROM accounts WHERE id = $1", [accountId]);
  if (!a || !a.totp_pending_enc) throw badRequest("Start the authenticator setup again.");
  const step = matchStep(decrypt(a.totp_pending_enc), code);
  if (step === null) throw badRequest("That code isn't right. Check the app shows Beer League Stats and try the current code.");
  await db.query(
    "UPDATE accounts SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last_step = $2 WHERE id = $1",
    [accountId, step],
  );
  return ensureBackupCodes(accountId);
}

/** Checks an authenticator code at sign-in; each code works once. */
async function verifyTotp(accountId, code) {
  const a = await db.one("SELECT totp_secret_enc FROM accounts WHERE id = $1", [accountId]);
  if (!a || !a.totp_secret_enc) return false;
  const step = matchStep(decrypt(a.totp_secret_enc), code);
  if (step === null) return false;
  const used = await db.query("UPDATE accounts SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2", [accountId, step]);
  return used.rowCount === 1;
}

async function removeTotp(accountId) {
  await db.query("UPDATE accounts SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = 0 WHERE id = $1", [accountId]);
}

// ---------------------------------------------------------------------------
// Backup codes

const newBackupCode = () => {
  const s = base32Encode(crypto.randomBytes(5)).toLowerCase(); // 8 chars
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
};
const normBackup = (c) => String(c || "").toLowerCase().replace(/[^a-z2-7]/g, "");

async function regenerateBackupCodes(accountId) {
  const codes = Array.from({ length: BACKUP_CODES }, newBackupCode);
  await db.tx(async (c) => {
    await c.query("DELETE FROM account_backup_codes WHERE account_id = $1", [accountId]);
    for (const code of codes) {
      await c.query("INSERT INTO account_backup_codes (account_id, code_hash) VALUES ($1, $2)", [accountId, hmac(`backup:${normBackup(code)}`)]);
    }
  });
  return codes;
}

async function ensureBackupCodes(accountId) {
  const r = await db.one("SELECT count(*) FILTER (WHERE used_at IS NULL)::int AS n FROM account_backup_codes WHERE account_id = $1", [accountId]);
  return r.n > 0 ? null : regenerateBackupCodes(accountId);
}

async function useBackupCode(accountId, raw) {
  const code = normBackup(raw);
  if (code.length !== 8) return false;
  const r = await db.query(
    "UPDATE account_backup_codes SET used_at = now() WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL",
    [accountId, hmac(`backup:${code}`)],
  );
  return r.rowCount === 1;
}

// ---------------------------------------------------------------------------
// Passkeys (WebAuthn). The relying party is the app's domain, so a passkey
// made on one organization's address works on every other one.

function relyingParty(req) {
  const host = String(req.hostname || "").toLowerCase();
  const apex = config.appDomain;
  // "localhost" isn't a registrable domain, so locally each address has its own passkeys.
  const rpID = apex && apex !== "localhost" && (host === apex || host.endsWith(`.${apex}`)) ? apex : host;
  return { rpID, origin: `${req.protocol}://${req.get("host")}` };
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

async function passkeyRegistrationOptions(req, acct) {
  const { generateRegistrationOptions } = require("@simplewebauthn/server");
  const { rpID } = relyingParty(req);
  const existing = await db.many("SELECT id, transports FROM account_passkeys WHERE account_id = $1", [acct.id]);
  const options = await generateRegistrationOptions({
    rpName: ISSUER, rpID, userName: acct.email, userDisplayName: acct.email,
    userID: Buffer.from(`blst-account-${acct.id}`),
    attestationType: "none",
    excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  await db.query(
    `INSERT INTO webauthn_registrations (account_id, challenge, expires_at) VALUES ($1, $2, now() + interval '5 minutes')
     ON CONFLICT (account_id) DO UPDATE SET challenge = EXCLUDED.challenge, expires_at = EXCLUDED.expires_at`,
    [acct.id, options.challenge],
  );
  return options;
}

async function finishPasskeyRegistration(req, acct, response, rawName) {
  const { verifyRegistrationResponse } = require("@simplewebauthn/server");
  const pending = await db.one("DELETE FROM webauthn_registrations WHERE account_id = $1 AND expires_at > now() RETURNING challenge", [acct.id]);
  if (!pending) throw badRequest("The passkey request expired. Try again.");
  const { rpID, origin } = relyingParty(req);
  let result;
  try {
    result = await verifyRegistrationResponse({ response, expectedChallenge: pending.challenge, expectedOrigin: origin, expectedRPID: rpID });
  } catch (err) {
    throw badRequest(`That passkey couldn't be added (${String(err.message).slice(0, 120)}).`);
  }
  if (!result.verified || !result.registrationInfo) throw badRequest("That passkey couldn't be verified.");
  const cred = result.registrationInfo.credential;
  const name = String(rawName || "").trim().slice(0, 60) || "Passkey";
  try {
    await db.query(
      "INSERT INTO account_passkeys (id, account_id, public_key, counter, transports, name) VALUES ($1, $2, $3, $4, $5, $6)",
      [cred.id, acct.id, Buffer.from(cred.publicKey), cred.counter || 0, cred.transports || [], name],
    );
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, "That passkey is already added.");
    throw err;
  }
  return ensureBackupCodes(acct.id);
}

async function passkeyAuthenticationOptions(req, accountId) {
  const { generateAuthenticationOptions } = require("@simplewebauthn/server");
  const keys = await db.many("SELECT id, transports FROM account_passkeys WHERE account_id = $1", [accountId]);
  if (!keys.length) throw badRequest("This account has no passkeys.");
  return generateAuthenticationOptions({
    rpID: relyingParty(req).rpID, userVerification: "preferred",
    allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports })),
  });
}

/** Verifies a passkey assertion for this account against the issued challenge. */
async function verifyPasskey(req, accountId, response, expectedChallenge) {
  const { verifyAuthenticationResponse } = require("@simplewebauthn/server");
  if (!response || typeof response.id !== "string" || !expectedChallenge) return false;
  const key = await db.one("SELECT * FROM account_passkeys WHERE id = $1 AND account_id = $2", [response.id, accountId]);
  if (!key) return false;
  const { rpID, origin } = relyingParty(req);
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: Number(key.counter), transports: key.transports },
    });
  } catch {
    return false;
  }
  if (!result.verified) return false;
  await db.query("UPDATE account_passkeys SET counter = $2, last_used_at = now() WHERE id = $1", [key.id, result.authenticationInfo.newCounter]);
  return true;
}

async function removePasskey(accountId, id) {
  const r = await db.query("DELETE FROM account_passkeys WHERE account_id = $1 AND id = $2", [accountId, String(id)]);
  if (!r.rowCount) throw new HttpError(404, "passkey not found");
}

/** Platform admin recovery: removes every second factor and signs the account out. */
async function resetAll(accountId) {
  await db.tx(async (c) => {
    await c.query("UPDATE accounts SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = 0 WHERE id = $1", [accountId]);
    await c.query("DELETE FROM account_passkeys WHERE account_id = $1", [accountId]);
    await c.query("DELETE FROM account_backup_codes WHERE account_id = $1", [accountId]);
    await c.query("DELETE FROM auth_sessions WHERE account_id = $1", [accountId]);
  });
}

module.exports = {
  totpCode, base32Encode, b64u, status, hasSecondFactor, methods,
  startTotp, confirmTotp, verifyTotp, removeTotp,
  regenerateBackupCodes, useBackupCode,
  passkeyRegistrationOptions, finishPasskeyRegistration, passkeyAuthenticationOptions, verifyPasskey, removePasskey,
  resetAll,
};

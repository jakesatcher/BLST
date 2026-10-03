const crypto = require("crypto");
const config = require("../config");

// Small authenticated encryption for secrets kept in the database
// (integration credentials and tokens): AES-256-GCM with a key derived from
// AUTH_SECRET and a purpose label, so each use has its own key.

function key(purpose) {
  return crypto.createHash("sha256").update(`blst-secretbox-v1:${purpose}:${config.auth.secret}`).digest();
}

function seal(purpose, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(purpose), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

function open(purpose, sealed) {
  const [v, iv, tag, ct] = String(sealed || "").split(":");
  if (v !== "v1") throw new Error("unknown secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", key(purpose), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

module.exports = { seal, open };

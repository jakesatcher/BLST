const config = require("../config");
const { HttpError } = require("../lib/http");

// Outbound email: Resend's HTTPS API or any SMTP provider. Without one,
// codes are printed to the server log; tests read them from `outbox`.

const outbox = [];
let transport = null;

function emailConfigured() {
  return Boolean(config.email.resendApiKey || config.email.smtpUrl);
}

const maskTo = (to) => String(to).replace(/^(.).*?(@.*)$/, "$1•••$2");

/** For the start-up log: which email provider is in use (no secrets). */
function describeEmail() {
  const from = `from ${config.email.from}`;
  if (config.email.resendApiKey) return `Resend API, ${from}`;
  if (config.email.smtpUrl) {
    try {
      const u = new URL(config.email.smtpUrl);
      return `SMTP ${u.hostname}:${u.port || (u.protocol === "smtps:" ? 465 : 587)}, ${from}`;
    } catch {
      return "SMTP_URL is set but isn't a valid URL (smtps://USER:PASS@host:465)";
    }
  }
  return "not set up (codes go to this log)";
}

/**
 * SMTP_URL parsed here (never by nodemailer's legacy URL parser, which
 * prints the whole URL, password included, to the log when it's malformed).
 */
function smtpOptions() {
  let u;
  try {
    u = new URL(config.email.smtpUrl);
  } catch {
    u = null;
  }
  if (!u || !/^smtps?:$/.test(u.protocol) || !u.hostname || u.hostname.startsWith("re_")) {
    console.error("email send failed: SMTP_URL isn't valid. Use smtps://USER:PASSWORD@HOST:465 (for Resend: smtps://resend:re_KEY@smtp.resend.com:465), or set RESEND_API_KEY instead.");
    throw new HttpError(503, "Email sending isn't set up correctly on this server. Ask the site admin.");
  }
  const port = Number(u.port) || (u.protocol === "smtps:" ? 465 : 587);
  return {
    host: u.hostname, port, secure: u.protocol === "smtps:" || port === 465,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
  };
}

async function sendViaResend(to, subject, text) {
  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${config.email.resendApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: config.email.from, to: [to], subject, text }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error("email send failed:", err.message);
    throw new HttpError(502, "Couldn't send the email. Try again in a minute.");
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`email send failed: Resend ${res.status} ${detail}`);
    throw new HttpError(502, "Couldn't send the email. Try again in a minute.");
  }
  console.log(`email sent via Resend to ${maskTo(to)}`);
}
/** Throws 503 when a channel has no provider and dev logging is off. */
function assertCanSend() {
  if (!emailConfigured() && !config.auth.logCodes) {
    throw new HttpError(503, "Email sending isn't set up on this server yet. Ask the site admin.");
  }
}

function devDeliver(channel, to, text) {
  assertCanSend(channel);
  outbox.push({ channel, to, text, at: Date.now() });
  if (outbox.length > 200) outbox.shift();
  if (process.env.NODE_ENV !== "test") console.log(`[dev ${channel} to ${to}] ${text.split("\n")[0]}`);
}

async function sendEmail(to, subject, text) {
  if (!emailConfigured()) return devDeliver("email", to, `${subject}\n${text}`);
  if (config.email.resendApiKey) return sendViaResend(to, subject, text);
  if (!transport) transport = require("nodemailer").createTransport(smtpOptions());
  try {
    await transport.sendMail({ from: config.email.from, to, subject, text });
    console.log(`email sent via SMTP to ${maskTo(to)}`);
  } catch (err) {
    console.error("email send failed:", err.message);
    throw new HttpError(502, "Couldn't send the email. Try again in a minute.");
  }
}

module.exports = { describeEmail, assertCanSend, sendEmail, emailConfigured, outbox };

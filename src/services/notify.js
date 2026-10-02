const config = require("../config");
const { HttpError } = require("../lib/http");

// Outbound email (any SMTP provider: Postmark, SendGrid, Mailgun, SES…)
// and SMS (Twilio). Without providers, development prints messages to the
// server log; tests read them from `outbox`.

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
function smsConfigured() {
  const s = config.sms;
  return Boolean(s.twilioSid && s.twilioToken && (s.twilioFrom || s.twilioMessagingService || s.twilioVerifyService));
}

/** Twilio Verify sends and checks sign-in codes itself. */
function smsVerifyConfigured() {
  const s = config.sms;
  return Boolean(s.twilioSid && s.twilioToken && s.twilioVerifyService);
}

function describeSms() {
  const s = config.sms;
  if (!smsConfigured()) return "not set up (codes go to this log)";
  return smsVerifyConfigured() ? `Twilio Verify (${s.twilioVerifyService.slice(0, 6)}…)` : "Twilio Messaging";
}

async function twilioVerify(path, form) {
  const s = config.sms;
  let res;
  try {
    res = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(s.twilioVerifyService)}/${path}`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${s.twilioSid}:${s.twilioToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error("sms send failed (Twilio Verify):", err.message);
    throw new HttpError(502, "Couldn't reach the text-message service. Try again in a minute.");
  }
  return { res, body: await res.json().catch(() => ({})) };
}

/** Asks Twilio Verify to text a code to `to` (E.164). */
async function startSmsVerification(to) {
  const { res, body } = await twilioVerify("Verifications", { To: to, Channel: "sms" });
  if (!res.ok) {
    console.error("sms send failed (Twilio Verify):", res.status, body.code, body.message);
    throw new HttpError(502, [60200, 60205, 21211, 21614].includes(body.code) ? "That phone number can't receive text messages." : "Couldn't send the text message. Try again in a minute.");
  }
  console.log(`sms sent via Twilio Verify to ${String(to).slice(0, -4).replace(/\d/g, "•")}${String(to).slice(-4)}`);
}

/** True when Twilio Verify approves `code` for `to`. Expired or already-used checks are false. */
async function checkSmsVerification(to, code) {
  const { res, body } = await twilioVerify("VerificationCheck", { To: to, Code: code });
  if (res.status === 404) return false; // expired, approved already, or too many checks
  if (!res.ok) {
    console.error("sms check failed (Twilio Verify):", res.status, body.code, body.message);
    if (body.code === 60202) return false; // max check attempts reached
    throw new HttpError(502, "Couldn't check the code. Try again in a minute.");
  }
  return body.status === "approved";
}

/** Throws 503 when a channel has no provider and dev logging is off. */
function assertCanSend(channel) {
  const ok = channel === "email" ? emailConfigured() : smsConfigured();
  if (!ok && !config.auth.logCodes) {
    throw new HttpError(503, `${channel === "email" ? "Email" : "Text message"} sending isn't set up on this server yet. Ask the site admin.`);
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

async function sendSms(to, body) {
  if (!smsConfigured()) return devDeliver("sms", to, body);
  const s = config.sms;
  const form = new URLSearchParams({ To: to, Body: body });
  if (s.twilioMessagingService) form.set("MessagingServiceSid", s.twilioMessagingService);
  else form.set("From", s.twilioFrom);
  let res;
  try {
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.twilioSid)}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${s.twilioSid}:${s.twilioToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error("sms send failed:", err.message);
    throw new HttpError(502, "Couldn't send the text message. Try again in a minute.");
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    console.error("sms send failed:", res.status, detail.code, detail.message);
    throw new HttpError(502, detail.code === 21211 || detail.code === 21614 ? "That phone number can't receive text messages." : "Couldn't send the text message. Try again in a minute.");
  }
}

module.exports = { describeEmail, describeSms, smsVerifyConfigured, startSmsVerification, checkSmsVerification, assertCanSend, sendEmail, sendSms, emailConfigured, smsConfigured, outbox };

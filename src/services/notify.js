const config = require("../config");
const { HttpError } = require("../lib/http");

// Outbound email (any SMTP provider: Postmark, SendGrid, Mailgun, SES…)
// and SMS (Twilio). Without providers, development prints messages to the
// server log; tests read them from `outbox`.

const outbox = [];
let transport = null;

function emailConfigured() {
  return Boolean(config.email.smtpUrl);
}
function smsConfigured() {
  const s = config.sms;
  return Boolean(s.twilioSid && s.twilioToken && (s.twilioFrom || s.twilioMessagingService));
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
  if (!transport) transport = require("nodemailer").createTransport(config.email.smtpUrl);
  try {
    await transport.sendMail({ from: config.email.from, to, subject, text });
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

module.exports = { assertCanSend, sendEmail, sendSms, emailConfigured, smsConfigured, outbox };

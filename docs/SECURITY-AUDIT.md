# BLST security audit, October 2026

**Scope:** the whole application, including BLPA Factions, which is now built in.
- Web: OWASP Top 10 (2021).
- API: OWASP API Security Top 10 (2023).
- Database: OWASP Database Security Cheat Sheet.

**Method:**
- **Code review:**
  - all 131 API routes and their access rules;
  - the authentication and session code;
  - every SQL statement built from strings;
  - all 8 database migrations and their triggers;
  - outbound calls (webhooks, LeagueApps, email/SMS);
  - file uploads;
  - the browser code: every place data reaches the page, and every link or
    frame built from data.
- **Checks against a running instance:** headers, a real boot as a
  least-privilege database login, and the Factions import against data from
  the real Factions app.
- **Dependencies:** `npm audit`.

**Result:**
- 12 findings, all fixed, plus one hardening change. None were critical or high.
- Each fix has a regression test.
- Test suite: 75 tests passing (was 67).
- `npm audit`: 0 known vulnerabilities.
- The accepted, remaining risks are listed at the end and in [SECURITY.md](../SECURITY.md).

## Findings

| # | Finding | OWASP | Severity | Status |
|---|---|---|---|---|
| F1 | Client IP behind Railway's proxy | API4, A04, A07 | Medium | Fixed |
| F2 | Admin API keys could hand out access without MFA | API5, A01, A07 | Medium | Fixed |
| F3 | App ran as the database owner/superuser | DB least privilege, A05 | Medium | Fixed (opt-in) |
| F4 | No database timeouts | API4, DB availability | Medium | Fixed |
| F5 | Overlapping deploys could run migrations twice | DB integrity, A05 | Low | Fixed |
| F6 | Changing your phone left other sessions signed in | A07, API2 | Low | Fixed |
| F7 | No idle timeout for admin sessions | A07, API2 | Low | Fixed |
| F8 | Successful sign-ins weren't attributed in the audit log | A09 | Low | Fixed |
| F9 | Public tournament data included integration settings | API3, A01 | Low | Fixed |
| F10 | Public player data used a deny-list | API3, A01 | Low (hardening) | Fixed |
| F11 | HTTPS redirect built from the raw Host header | A01, A05 | Low | Fixed |
| F12 | Embedded stream player could redirect the page | A05 | Low | Fixed |
| F13 | Database integrity errors returned 500 | A05, A09 | Info | Fixed |

### F1: Client IP behind Railway's proxy (Medium)

**Problem.** Rate limits, the brute-force lockout, the live-stream caps and
the audit log all key on the client's IP address.
- On Heroku that comes from `X-Forwarded-For`.
- Railway's edge documents only `X-Real-IP`.
- Without it, every visitor appears to come from the proxy's address. A single
  person sending 10 bad keys would lock **everyone** out for 15 minutes, and
  all users would share one rate limit.

**Fix.**
- On Railway (detected through `RAILWAY_ENVIRONMENT_ID`), the client address is
  read from `X-Real-IP`. The edge sets that header itself, so a client can't
  fake it.
- `CLIENT_IP_HEADER` overrides the header for other proxies.
- Values that aren't IP addresses are ignored.

**Test:** `security.test.js` › *Audit F1*.

### F2: Admin API keys could hand out access without MFA (Medium)

**Problem.** Admin *accounts* need an email code and a text code, but an admin
*API key* (made for automation) could:
- create more admin keys;
- promote accounts to admin;
- point webhooks, which carry every score and roster change, at any URL.

A leaked key could therefore entrench itself or send data off-site.

**Fix.** These actions now need an admin who signed in with MFA:
- creating API keys;
- changing, signing out or deleting accounts;
- creating or retargeting webhooks.

An admin API key gets `403`; reading and normal admin work still succeed with
a key.

**Test:** *Audit F2*.

### F3: App ran as the database owner/superuser (Medium)

**Problem.**
- On Railway the database login is the `postgres` superuser; on Heroku it is
  the database owner.
- A superuser can read server files and run programs (`COPY … TO PROGRAM`).
  Any future injection bug would reach the whole database server.

**Fix.**
- `npm run db:app-role` creates `blst_app`:
  - it isn't a superuser and can't create roles or databases;
  - it has no right to create objects in the schema;
  - it can only read and write rows;
  - default privileges cover tables that future migrations add.
- The app runs as `blst_app`, and migrations run as the owner through the new
  `DATABASE_MIGRATION_URL`.
- Admin → Security shows ✗ until this is done.
- The steps for Railway are in [RAILWAY.md](RAILWAY.md) and SECURITY.md.

**Tests:** `database.test.js`. The role can read and write rows and fire
triggers. It can't create, alter, drop or truncate tables, run `COPY … PROGRAM`,
read server files, or make itself superuser. Also verified on a real server
boot.

### F4: No database timeouts (Medium)

**Problem.** A slow query or a stuck transaction could hold a connection
indefinitely. With a pool of 10, a few slow requests could make the whole site
hang.

**Fix.**
- `statement_timeout`: 20 s, configurable with `DB_STATEMENT_TIMEOUT_MS`.
- `idle_in_transaction_session_timeout`: 60 s.
- Waiting for a free connection: at most 10 s.
- Migrations lift the statement timeout for their own connection only.

**Test:** `database.test.js`.

### F5: Overlapping deploys could run migrations twice (Low)

**Problem.** Railway starts the new deploy before stopping the old one. Two
instances starting together could both try to apply the same migration, and
one would crash on boot.

**Fix.** Migrations take a Postgres advisory lock and check what is already
applied once they hold it.

### F6: Changing your phone left other sessions signed in (Low)

**Fix.** Changing your mobile number (your second factor) now ends every other
session. The session that made the change stays signed in.

**Test:** `auth.test.js`.

### F7: No idle timeout for admin sessions (Low)

**Fix.** Admin sessions now end after 2 hours without use
(`ADMIN_IDLE_MINUTES`), on top of the 12-hour maximum.

**Test:** `auth.test.js`.

### F8: Successful sign-ins weren't attributed in the audit log (Low)

**Fix.** The audit row for a completed sign-in now records `account:<id>`, never
the email.

### F9: Public tournament data included integration settings (Low)

**Problem.** `GET /tournaments` showed anonymous callers the LeagueApps program
ids, the registration prefix and counter, and the Factions point values.

**Fix.** These are now admin-only.

**Test:** *Audit F3*.

### F10: Public player data used a deny-list (Low, hardening)

**Problem.** Public player objects removed private fields one by one. A future
private column would have been public by default.

**Fix.** Public player objects are now built from an allow-list.

**Test:** *Audit F3*.

### F11: HTTPS redirect built from the raw Host header (Low)

**Problem.** The HTTP-to-HTTPS redirect used the `Host` header unchecked, a
possible open redirect if a proxy passes odd hosts through.

**Fix.** Only a plain `host[:port]` is accepted; anything else gets `400`.

### F12: Embedded stream player could redirect the page (Low)

**Problem.** The watch page's third-party video `<iframe>` had no sandbox, so a
compromised or malicious player page could navigate the whole tab to a lookalike
site (tabnabbing).

**Fix.** The player is sandboxed. It can still play video and open pop-ups, but
can't navigate the page.

### F13: Database integrity errors returned 500 (Info)

**Fix.** Errors raised by BLST's own integrity triggers (for example, "a Factions
member's Order is permanent") now return `409` with that fixed message instead of
a generic 500.

**Test:** *Audit F4*.

## Checked and found sound

**A01 / API1 / API5: access control**
- Every write route requires a role; the test suite walks all of them as an
  anonymous caller.
- Scorekeeper keys and accounts limited to one tournament are checked on every
  game route.
- Event edits are tied to their game (`WHERE id = $1 AND game_id = $2`).
- Factions member data is admin-only.

**A02: cryptography**
- Keys and session tokens are stored as SHA-256 hashes; one-time codes as
  HMAC-SHA256 keyed with `AUTH_SECRET`.
- Comparisons are constant-time.
- TLS and HSTS are on.
- Webhooks are signed.

**A03: injection**
- Every value goes into SQL as a bind parameter. All 36 places that build SQL from
  strings use column or table names from fixed lists in code.
- The browser builds every page with `textContent` (no `innerHTML`), with a
  strict CSP: no inline or third-party scripts.
- CSV exports neutralize spreadsheet formulas.
- The live stream forwards only event names to anonymous viewers.

**A04 / API6: abuse**
- Sign-in can't be used to find out who has an account: unknown emails get a
  look-alike flow that never completes.
- Codes are capped per IP, per address, and globally for SMS.
- Texts only go to allowed countries.
- Imports have a dry run.

**A05: configuration**
- Security headers: CSP, HSTS, `nosniff`, COOP, CORP, frame-ancestors and
  Permissions-Policy.
- No `X-Powered-By`; generic 500 errors.
- Fails closed without `ADMIN_TOKEN`.
- Admin → Security shows the live posture, now including the database login,
  timeout and TLS.

**A06: components**
- 6 runtime dependencies plus hls.js; `npm audit` reports 0 vulnerabilities.
- Dependabot and CI audit every push.

**A07 / API2: authentication**
- MFA on every account; no passwords.
- Short admin sessions.
- The setup key is retired once an admin exists.
- Lockout after repeated bad keys.
- Keys in URLs are refused.

**A08: integrity**
- Uploads are identified from their bytes.
- SVGs are served with a sandbox CSP.
- Factions Orders are permanent, enforced by the database.

**A09: logging**
- Every change and every denied request is in the audit log, without tokens,
  bodies, emails or Factions member ids.

**A10 / API7: server-side request forgery**
- Webhook and stream-check URLs must resolve to public addresses, checked when
  saved and again when sent.
- Webhooks don't follow redirects.

**API3: data exposure**
- Emails, birth dates, LeagueApps ids and Factions member ids are admin-only
  everywhere: players, rosters, exports, webhooks and the live stream.
- Phone numbers are always masked.

**API4: resource limits**
- Body size limits; capped list sizes; caps on live-stream connections.

**API9 / API10: inventory and third-party APIs**
- One versioned API, documented at `/api.html`.
- Factions is local now: no remote calls.
- LeagueApps responses are mapped defensively.
- Outbound calls have timeouts.

**Database**
- Constraints and triggers back the business rules.
- Migrations run in transactions.
- Retention: challenges are deleted after 1 hour, the code-send log after
  1 day, and audit rows after 180 days.
- Only email and phone are stored for accounts.

## Accepted risks (unchanged)

See SECURITY.md → *Residual risks* for detail.
- Tokens live in `localStorage`. There are no cookies, so no CSRF; a strict CSP
  limits XSS.
- Rate limits are kept in memory (one instance by design).
- `style-src 'unsafe-inline'`, and `https:` for media and frames, which the
  watch page needs.
- Heroku's database TLS certificate isn't verified (Heroku's documented setup).
- Phone numbers and webhook secrets are stored readable, because they're needed
  to send texts and sign webhooks.
- Admin API keys can still change tournament data without MFA. They can no
  longer grant access (F2).
- SMS is the weaker second factor; the email code is always required too.

**Informational, no change:**
- A request with the retired setup key gets a distinct message. The key is
  192-bit random, so this doesn't help guessing, and the message helps a real
  admin.
- `AUTH_LOG_CODES=true` only affects channels with no email or SMS provider.
  Once SMTP and Twilio are configured, codes are never logged even if the flag
  is left on.

## Operator actions

1. **Least-privilege database login** (F3): `railway ssh --service blst npm run db:app-role`,
   then set the two values it prints.
2. Make sure Admin → Security shows ✓ everywhere after the next deploy.
3. If you wrote automation that creates API keys or webhooks with an admin API
   key, do those steps while signed in instead (F2).

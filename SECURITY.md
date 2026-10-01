# BLST security

This document maps BLST's controls to:
- the **OWASP Top 10 (2021)** for web applications;
- the **OWASP API Security Top 10 (2023)**;
- the **OWASP Database Security Cheat Sheet**.

It also lists what operators must do and the known residual risks. The latest
audit, with each finding and its fix, is in
[docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).

Every control below has a regression test:
- `test/security.test.js` covers most of them;
- `test/auth.test.js` covers accounts and sessions;
- `test/database.test.js` covers database privileges and timeouts;
- `test/factions.test.js` covers Factions data;
- the rest are in `test/api.test.js` and `test/media-draft.test.js`. Run them with `npm test`. CI runs the tests and `npm audit` on every push (`.github/workflows/ci.yml`).

## Threat model in one paragraph

Most of BLST is **public by design**: scores, rosters, stats and exports are meant to be seen. The assets to protect are:
- **integrity**: only scorekeepers and admins may change games, rosters and settings;
- **players' personal data**: email addresses and the Factions member id, which is a reversible encoding of the email;
- **account holders' personal data**: only their email address and mobile number;
- **secrets**: sign-in sessions, the setup key (`ADMIN_TOKEN`), API keys and webhook secrets;
- **the server itself**: availability, and not being used as a proxy into internal networks.

People sign in to **accounts** with two one-time codes: one emailed (proves the address), then one texted (proves the phone). That is MFA for every account, admins included, with no passwords to steal or reuse. Signing in returns a bearer session token. Machines and shared rink devices use **API keys**. Both are sent in the `Authorization` header; there are no cookies, so there's no CSRF.

## OWASP API Security Top 10 (2023)

| Risk | How BLST handles it |
|---|---|
| **API1 Broken object-level authorization** | Roles are `readonly`, `scorekeeper` and `admin`. A key can be limited to **one tournament**: a scoped scorekeeper key gets `403` on any game outside its tournament (`assertTournamentScope`), and scoped keys can't be admin. Public objects carry no private fields. |
| **API2 Broken authentication** | **Accounts (MFA for everyone):** every sign-in needs a 6-digit code emailed to the address **and** a 6-digit code texted to the phone on file. Codes are random, stored only as HMAC-SHA256 hashes (`AUTH_SECRET`), single-use, expire after 10 minutes and allow 5 guesses (counted atomically). A resend issues a new code, with a 30 s cooldown and at most 5 per sign-in.<br>**No account enumeration:** sign-in for an unknown or disabled email gets an identical response and a flow that can never complete, and goes through the same send caps. Sign-up with a taken email quietly becomes a sign-in, with the text going to the phone on file.<br>**Abuse:** per-IP limits on starts (30/15 min) and code checks (90/15 min); per-address caps (6 codes an hour per email or phone, stored as keyed hashes); a global hourly SMS cap; an SMS country allow-list (`SMS_ALLOWED_COUNTRY_CODES`) against SMS-pumping fraud.<br>**Sessions:** 256-bit random tokens stored only as SHA-256 hashes. Admins 12 h, scorekeepers 24 h, users 30 days, checked against the account's *current* role, so a promotion to admin gets the admin limit at once. Admin sessions also end after 2 hours without use (`ADMIN_IDLE_MINUTES`). Changing a role or disabling an account ends its sessions, and changing your mobile number ends every other session. Sign out, sign out everywhere, and account deletion are self-service.<br>**Global admin bootstrap:** the first admin is created with the setup key (`ADMIN_TOKEN`) plus both codes, only while no admin account exists. After that `ADMIN_TOKEN` is **retired** (401) so every human admin goes through MFA; `ADMIN_TOKEN_BREAK_GLASS=true` re-enables it for recovery. The last admin can't be demoted, disabled or deleted.<br>**Keys:** 192-bit random keys, stored only as SHA-256 hashes and shown once at creation. Keys can **expire** and be **revoked**.<br>**Setup key** (`ADMIN_TOKEN`): compared in constant time without leaking its length. It must be ≥16 characters when deployed, or the server refuses to start.<br>**Brute force:** 10 bad keys from one IP in 15 minutes locks that IP out with `429` and `Retry-After`.<br>**Keys in URLs** are refused (`400`), so they can't leak into logs or browser history.<br>**Fails closed:** with no `ADMIN_TOKEN`, nothing can be changed; the open mode needs `ALLOW_OPEN_DEV=true` and only works on a machine that isn't deployed. |
| **API3 Broken object-property-level authorization** | **Allow-lists:** public player and tournament objects are built from explicit allow-lists, so a new private column can't leak by default. Integration settings (LeagueApps programs, registration counters, Factions point values) are admin-only.<br>**Accounts:** only email and phone are stored (a test pins the table's columns). Phone numbers are masked (`•••• 1234`) in every response, including to admins. Audit rows identify people as `account:<id>`, never by email.<br>**Responses:** emails, birth dates, LeagueApps user IDs and Factions player IDs are stripped for non-admins everywhere: player endpoints, rosters, stats, exports, webhooks and the live stream. Registration lists are admin-only; the scorekeeper check-in lookup returns names and teams only, limited to the key's tournament. Anonymous search can't match on email. Webhook secrets are masked after creation, and key hashes are never returned. **Factions:** public standings show Order totals and display names only; member records, emails and member ids are admin-only, and member ids are masked (`/factions/members/:id`) in the audit and server logs. An Order is permanent: a database trigger refuses any change to a member's Order or email.<br>**Requests (mass assignment):** every write accepts an explicit allow-list of fields with type, range and length checks. |
| **API4 Unrestricted resource consumption** | **Client address:** behind Railway's edge the client is read from `X-Real-IP` (Railway documents no `X-Forwarded-For`), so one abuser can't exhaust everyone's rate limit or lock everyone out (`CLIENT_IP_HEADER` to override).<br>**Database:** statements time out after 20 s, idle transactions after 60 s, and waiting for a connection after 10 s.<br>**Per-IP rate limits:** 600 reads and 240 writes a minute, 20 imports a minute; sign-in limits and SMS caps (API2); all configurable. Responses carry `RateLimit-*` headers.<br>**Body size:** 1 MB, 10 MB for imports, 2 MB for logos. Imports are capped at 20,000 rows, list endpoints are paginated with a maximum page size, and live-stream connections are capped per IP (12) and in total (5,000).<br>**Caching:** heavy stats and exports are cached for 3 s and cleared on any change. |
| **API5 Broken function-level authorization** | **Access-granting actions need MFA:** creating API keys, changing accounts and creating or retargeting webhooks need an admin who signed in with email + text code. An admin API key gets `403`, so a leaked key can't mint more access or send data off-site. Only the setup key (before setup or break-glass) and local dev mode count as people.<br>Standard accounts (`user`) rank below every staff role and can only manage themselves; account self-service routes refuse API keys. Every write route and every private read declares its required role. A test walks **every** registered write route and checks an anonymous call gets `401`, then checks each private read the same way. |
| **API6 Unrestricted access to sensitive business flows** | Sign-up and sign-in (which send email and paid SMS) are capped per IP, per address and globally (API2). Scoring, roster changes, imports and Factions awards need scorekeeper or admin access, can be limited to a tournament, are rate-limited and are audit-logged. Imports have a dry run, and replace mode never removes players when the file has errors. |
| **API7 Server-side request forgery** | Admin-supplied URLs (webhooks, the stream embed check) must be http(s) with no embedded credentials. They must resolve only to **public** addresses: loopback, private ranges, link-local (cloud metadata at 169.254.169.254), carrier-grade NAT, multicast and reserved space are all refused. The check runs when the URL is saved **and** again at send time. Webhooks don't follow redirects; the embed check re-validates each redirect hop. Only response headers or status codes are used; remote content is never returned. |
| **API8 Security misconfiguration** | **Headers:** strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'self'`), HSTS for 1 year, `nosniff`, Referrer-Policy and Permissions-Policy, and no `X-Powered-By`.<br>**Transport:** HTTP is redirected to HTTPS when deployed.<br>**Caching:** responses to signed-in callers are `no-store`.<br>**CORS** can be restricted with `CORS_ORIGINS`.<br>**Errors:** unexpected errors return a generic 500; details go to the server log only. |
| **API9 Improper inventory management** | One versioned API (`/api/v1`) documented at `/api.html`. Export payloads carry `schema_version`. No hidden or debug endpoints. |
| **API10 Unsafe consumption of APIs** | BLPA Factions is built in (no remote calls). The one-time import from a standalone Factions database reads fixed columns only and validates each Order against the known list. Remote error text (LeagueApps) is only shown to admins and is truncated. Outbound calls have timeouts. hls.js is **self-hosted** from the pinned npm package, with no third-party scripts. |

## OWASP Top 10 (2021)

| Risk | How BLST handles it |
|---|---|
| **A01 Broken access control** | See API1, API3 and API5. Static files are served without dotfiles, and no path parameter ever reaches the filesystem. |
| **A02 Cryptographic failures** | **In transit:** HTTPS is enforced in production, with HSTS.<br>**At rest:** API keys and session tokens are stored as SHA-256 hashes; one-time codes as HMAC-SHA256. Webhooks are signed with HMAC-SHA256 over `timestamp.body`; receivers should reject timestamps older than 5 minutes.<br>**Database:** TLS on Heroku (see residual risks about certificate validation). |
| **A03 Injection** | **SQL:** all values are parameterized; the only interpolated SQL pieces are fixed column and table names from code.<br>**XSS:** the UI builds the page with `textContent` and never uses `innerHTML`. The CSP blocks inline and third-party scripts.<br>**CSV/formula injection:** export cells starting with `= + - @` are prefixed with `'`.<br>**Headers:** the download file name is sanitized. Tested with SQL- and HTML-shaped input. |
| **A04 Insecure design** | Passwordless MFA for every account, enumeration-safe sign-in, fails closed by default, scoped and expiring keys, imports with dry run and preview, events voided (not deleted) so the history survives, rate limits and brute-force lockout. |
| **A05 Security misconfiguration** | Hardened headers (API8). The server won't start deployed without a strong `ADMIN_TOKEN`. The Admin → Security tab shows the live security posture. |
| **A06 Vulnerable and outdated components** | Six runtime dependencies plus hls.js, with `npm audit` clean (0 vulnerabilities). CI runs `npm audit --omit=dev --audit-level=high` on every push, and Dependabot opens weekly update PRs. |
| **A07 Identification and authentication failures** | See API2. MFA for every account; no passwords, so nothing to stuff or spray. API keys are per device, so they can be revoked individually. |
| **A08 Software and data integrity failures** | **Uploads:** logos are identified from their bytes; the `Content-Type` header isn't trusted. SVGs are served with `Content-Security-Policy: sandbox` so they can't run scripts.<br>**Webhooks:** signed.<br>**Scripts:** no third-party scripts; hls.js is self-hosted from the pinned npm package.<br>**Dependencies:** pinned by `package-lock.json`. |
| **A09 Security logging and monitoring failures** | **Audit log:** every change and every rejected request (401, 403, 429) is written to `audit_log` with who, what path, status, IP and time. Successful sign-ins are attributed to the account (`account:<id>`). It never stores tokens, codes or request bodies, and is kept for 180 days. Admins see it under **Admin → Security**.<br>**Server log:** rejected requests also go to the server log (`[security] …`), which feeds Heroku logs and any log drain. |
| **A10 Server-side request forgery** | See API7. |

## Database (OWASP Database Security Cheat Sheet)

| Area | How BLST handles it |
|---|---|
| **Injection** | Every value is a bind parameter. The only SQL built from strings are column and table names taken from fixed lists in code (audited: none come from requests or CSV headers). |
| **Least privilege** | `npm run db:app-role` creates `blst_app`. It is not a superuser, can't create roles or databases, and has no `CREATE` on the schema; it can only read and write rows. Run the app as it, with `DATABASE_MIGRATION_URL` (the owner login) used for migrations only. Default privileges give it rights on tables future migrations add. The Security tab flags a superuser or schema-changing login. |
| **Authentication and secrets** | Credentials come only from config vars (`DATABASE_URL`, `DATABASE_MIGRATION_URL`), never from code or logs. API keys and session tokens are stored as SHA-256 hashes; one-time codes as HMAC-SHA256. |
| **Transport** | Heroku: TLS (certificate not verified, see residual risks). Railway: the private network is WireGuard-encrypted and never leaves Railway; `DATABASE_SSL=true` for the public proxy. The Security tab shows whether the connection is encrypted. |
| **Integrity** | Constraints and triggers enforce rules the app relies on: unique emails, permanent Factions Orders, player/member links. Migrations run in transactions under an advisory lock, so overlapping deploys can't both migrate. |
| **Availability** | Statement, idle-transaction and connection timeouts; a fixed pool of 10 connections; heavy reads cached for 3 s. |
| **Data minimization and retention** | Accounts hold only email and phone. Sign-in challenges are deleted after an hour, expired sessions are pruned, the code-send log is kept 1 day, and the audit log 180 days. Personal fields are never returned to non-admins. |
| **Backups and encryption at rest** | Provided by the platform (Heroku Postgres and Railway volumes are encrypted at rest and backed up). Turn on scheduled backups for your plan; see residual risks. |

## Operator checklist (production)

1. Set a strong `ADMIN_TOKEN` (`openssl rand -hex 24`) and `AUTH_SECRET` (`openssl rand -hex 32`); the Heroku Deploy button generates both. Use `ADMIN_TOKEN` once to **set up the global admin account**; it is retired automatically after that.
2. **Least-privilege database login:** run `npm run db:app-role` once with the owner login (Railway: `railway ssh --service blst npm run db:app-role`). Then set the printed `DATABASE_URL` and `DATABASE_MIGRATION_URL`. Admin → Security should then show ✓ for the database login.
3. Configure **email** (`SMTP_URL`, `EMAIL_FROM`) and **SMS** (`TWILIO_*`), then set `AUTH_LOG_CODES=false` so codes never reach the log. Keep `SMS_ALLOWED_COUNTRY_CODES` to the countries you need.
4. Give people access under **Admin → Accounts** rather than sharing keys. Leave `ADMIN_TOKEN_BREAK_GLASS` off except during recovery.
5. For shared rink devices, create one **scorekeeper key per device**, limited to the tournament and set to expire after the event. Revoke keys when devices are lost or people leave.
6. Leave `ALLOW_OPEN_DEV` and `ALLOW_PRIVATE_NETWORK_URLS` **unset** in production.
7. Optional: `CORS_ORIGINS=https://your-site.example` if only known sites should call the API from a browser. Set `PUBLIC_EXPORTS=false` if exports shouldn't be public.
8. Optional: `SECURITY_CONTACT=mailto:…` to publish `/.well-known/security.txt`.
9. Webhook receivers: verify `X-BLST-Signature` and reject `X-BLST-Timestamp` values more than 5 minutes old (replay protection).
10. Check **Admin → Security** after deploys and periodically: everything should show ✓, and the audit log should show no unexpected denied requests.
11. Keep dependencies updated (merge Dependabot PRs once CI is green).

## Residual risks and trade-offs

- **Session tokens and API keys live in the browser's `localStorage`** on devices that sign in. With no cookies there's no CSRF risk, and the strict CSP (no inline or third-party scripts) mitigates XSS. Admin sessions expire after 12 hours. Still, sign out on shared devices, and use short-lived scoped keys for rink iPads.
- **SMS is a weaker second factor** than an authenticator app or passkey (SIM swap). It's what was asked for and suits occasional users; the email code is always required as well, so a SIM swap alone isn't enough.
- **The email code proves the inbox, not a password.** Whoever controls an admin's email *and* phone can sign in as them. Admins should protect their email with its own MFA.
- **Admin-role API keys** don't go through MFA. They can't create keys, change accounts or set webhooks (those need a signed-in admin), but they can still change tournament data. Prefer scorekeeper or read-only keys, with expiry.
- **The Factions Order guard** (a database trigger) is an integrity check against application bugs. A session holding database credentials could bypass it with `SET blst.factions_import`; only the app and the one-time import hold those credentials.
- **Webhook secrets and phone numbers are stored in plain text** in the database: webhooks must be signed and texts sent, so they have to be readable. Protect database access and backups accordingly (least-privilege login, platform encryption at rest).
- **The app's default database login is the platform's owner/superuser** until you run `npm run db:app-role`. The Security tab shows ✗ until then.
- **The database TLS certificate isn't validated** (`rejectUnauthorized: false`). Heroku Postgres uses certificates that can't be verified this way; this is Heroku's documented setup. The connection is still encrypted.
- **Rate limits and stream caps are per process (in memory).** That's correct for the single-dyno setup this app is designed for. Running multiple dynos would need a shared store such as Redis.
- **DNS rebinding:** SSRF checks resolve the hostname before connecting, which leaves a small time-of-check/time-of-use window. The guard also re-checks at send time, and only response status and headers are ever used.
- **`style-src 'unsafe-inline'`** is allowed because the UI sets element styles from script. Scripts themselves are `'self'` only.
- **Embedded video** (`frame-src https:`) lets admins embed any HTTPS player on the watch page. Only admins can set stream links, and players are sandboxed by the browser's cross-origin rules.
- **LeagueApps private key:** keep it only in the `LEAGUEAPPS_PRIVATE_KEY` config var. BLST signs short-lived (5-minute) assertions with it and never logs or returns it. Registration data pulled from LeagueApps (emails, birth dates) is stored only for identity matching and shown only to admins.
- **Public reads** (scores, rosters, stats) are intentional. Player names and jersey numbers are public; emails are not.

## Reporting a vulnerability

Contact the maintainers privately; if `SECURITY_CONTACT` is set, the address is published at `/.well-known/security.txt`. Please don't open public issues for security problems.

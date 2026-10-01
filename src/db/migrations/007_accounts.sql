-- People who sign in. By design the only personal data kept is the email
-- address and phone number: no names, no passwords. Sign-in is an emailed
-- one-time code plus a texted one-time code (two factors).
CREATE TABLE accounts (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  phone         TEXT NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'scorekeeper', 'admin')),
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  disabled_at   TIMESTAMPTZ
);

-- Opaque bearer sessions, stored hashed. No IP or device details kept.
CREATE TABLE auth_sessions (
  id           SERIAL PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_account_idx ON auth_sessions (account_id);

-- In-flight sign-up / sign-in / phone-change verifications (10 minutes).
CREATE TABLE auth_challenges (
  id           TEXT PRIMARY KEY,
  purpose      TEXT NOT NULL CHECK (purpose IN ('signup', 'login', 'setup_admin', 'change_phone')),
  email        TEXT,
  phone        TEXT,
  account_id   INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  ghost        BOOLEAN NOT NULL DEFAULT FALSE,
  step         TEXT NOT NULL CHECK (step IN ('email', 'sms')),
  code_hash    TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  sends        INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Send counters for abuse limits; targets are stored only as HMACs.
CREATE TABLE auth_send_log (
  id          BIGSERIAL PRIMARY KEY,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  target_hash TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_send_log_idx ON auth_send_log (channel, target_hash, at);
CREATE INDEX auth_send_log_at_idx ON auth_send_log (channel, at);

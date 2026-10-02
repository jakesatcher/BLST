-- Second factor: an authenticator app (TOTP) and/or passkeys (WebAuthn)
-- instead of text messages. Required for admins and scorekeepers; ordinary
-- accounts sign in with the emailed code alone. Phone numbers are no longer
-- collected, so they're erased.

DELETE FROM auth_challenges;
ALTER TABLE auth_challenges DROP COLUMN phone;
ALTER TABLE auth_challenges DROP CONSTRAINT IF EXISTS auth_challenges_purpose_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_purpose_check CHECK (purpose IN ('signup', 'login', 'setup_admin'));
ALTER TABLE auth_challenges DROP CONSTRAINT IF EXISTS auth_challenges_step_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_step_check CHECK (step IN ('email', 'mfa'));
-- Passkey sign-in: the WebAuthn challenge issued for this sign-in.
ALTER TABLE auth_challenges ADD COLUMN webauthn_challenge TEXT;

DELETE FROM auth_send_log WHERE channel = 'sms';

ALTER TABLE accounts DROP COLUMN phone;
-- Authenticator secret, encrypted (AES-256-GCM, key derived from AUTH_SECRET).
ALTER TABLE accounts ADD COLUMN totp_secret_enc TEXT;
-- A secret being set up (until its first code is confirmed).
ALTER TABLE accounts ADD COLUMN totp_pending_enc TEXT;
-- Last accepted 30-second step: a code can't be used twice.
ALTER TABLE accounts ADD COLUMN totp_last_step BIGINT NOT NULL DEFAULT 0;

-- Whether this session passed the second factor. Staff access needs it.
ALTER TABLE auth_sessions ADD COLUMN mfa BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE account_passkeys (
  id           TEXT PRIMARY KEY,               -- credential id (base64url)
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key   BYTEA NOT NULL,
  counter      BIGINT NOT NULL DEFAULT 0,
  transports   TEXT[] NOT NULL DEFAULT '{}',
  name         TEXT NOT NULL DEFAULT 'Passkey',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX account_passkeys_account_idx ON account_passkeys (account_id);

-- One-time backup codes (HMACs only).
CREATE TABLE account_backup_codes (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  PRIMARY KEY (account_id, code_hash)
);

-- Passkey registration in progress (5 minutes).
CREATE TABLE webauthn_registrations (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

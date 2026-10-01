#!/usr/bin/env bash
# One-command Railway setup: BLST and BLPA Factions side by side.
#
# Creates a new Railway project with three services:
#   Postgres  - one database; BLST uses the "public" schema, Factions "factions"
#   factions  - github.com/jakesatcher/blpafactions
#   blst      - github.com/jakesatcher/BLST
# BLST reaches Factions over Railway's private network (encrypted, never
# leaves Railway). Secrets are generated here and stored only in Railway.
#
# Needs: the Railway CLI (npm i -g @railway/cli, or brew install railway),
# openssl, and the Railway GitHub app allowed to read both repositories
# (railway.com -> Account -> Integrations -> GitHub).
#
# Usage:  scripts/railway-setup.sh            (asks before creating anything)
#         scripts/railway-setup.sh --yes
# Override with env vars: PROJECT_NAME, BLST_REPO, BLST_BRANCH,
# FACTIONS_REPO, FACTIONS_BRANCH.
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-blpa}"
BLST_REPO="${BLST_REPO:-jakesatcher/BLST}"
BLST_BRANCH="${BLST_BRANCH:-claude/great-bardeen-wfd39q}"
FACTIONS_REPO="${FACTIONS_REPO:-jakesatcher/blpafactions}"
FACTIONS_BRANCH="${FACTIONS_BRANCH:-claude/great-bardeen-wfd39q}"
# Railway names the first Postgres it adds to a project "Postgres".
PG="${PG_SERVICE:-Postgres}"
PORT=8080

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

command -v railway >/dev/null || die "install the Railway CLI first: npm i -g @railway/cli (or: brew install railway)"
command -v openssl >/dev/null || die "openssl is required to generate secrets"
railway whoami >/dev/null 2>&1 || railway login

cat <<INFO

This creates a NEW Railway project "${PROJECT_NAME}" with:
  ${PG}     (one database for both apps)
  factions  ${FACTIONS_REPO} @ ${FACTIONS_BRANCH}
  blst      ${BLST_REPO} @ ${BLST_BRANCH}
Railway bills usage for all three services.
INFO
if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || die "cancelled"
fi

hex() { openssl rand -hex "$1"; }
FACTIONS_ADMIN_TOKEN="$(hex 24)"
BLST_ADMIN_TOKEN="$(hex 24)"
AUTH_SECRET="$(hex 32)"

say "1/5 Creating project ${PROJECT_NAME}"
railway init --name "$PROJECT_NAME"

say "2/5 Adding Postgres"
railway add --database postgres

# ${{...}} are Railway reference variables, resolved by Railway at deploy
# time; the single quotes keep this shell from touching them.
say "3/5 Adding the factions service"
railway add --service factions --repo "$FACTIONS_REPO" --branch "$FACTIONS_BRANCH" \
  --variables "PORT=${PORT}" \
  --variables "ADMIN_TOKEN=${FACTIONS_ADMIN_TOKEN}" \
  --variables 'DATABASE_URL=${{'"$PG"'.DATABASE_URL}}?schema=factions'

say "4/5 Adding the blst service"
railway add --service blst --repo "$BLST_REPO" --branch "$BLST_BRANCH" \
  --variables "PORT=${PORT}" \
  --variables 'DATABASE_URL=${{'"$PG"'.DATABASE_URL}}' \
  --variables "ADMIN_TOKEN=${BLST_ADMIN_TOKEN}" \
  --variables "AUTH_SECRET=${AUTH_SECRET}" \
  --variables "AUTH_LOG_CODES=true" \
  --variables "SEED_DEMO=true" \
  --variables 'FACTIONS_BASE_URL=http://${{factions.RAILWAY_PRIVATE_DOMAIN}}:${{factions.PORT}}' \
  --variables 'FACTIONS_ADMIN_TOKEN=${{factions.ADMIN_TOKEN}}' \
  --variables "FACTIONS_AUTO_SYNC=false"

say "5/5 Creating public web addresses"
railway domain --service blst --port "$PORT"
railway domain --service factions --port "$PORT"

cat <<DONE

Done. Railway is building both apps now (a few minutes): watch with
  railway logs --service blst      or      railway logs --service factions

Next:
  1. Open the blst address above -> Admin & setup -> "Set up the admin account".
     Setup key (BLST's ADMIN_TOKEN):  ${BLST_ADMIN_TOKEN}
     Until email/SMS are configured, sign-in codes appear in: railway logs --service blst
  2. The Factions admin token (for its own web page) is:  ${FACTIONS_ADMIN_TOKEN}
  Both stay available later in each service's Variables tab, or:
     railway variable list --service blst --kv
  3. Real email and text messages for sign-in (then turn off code logging):
     railway variable set --service blst SMTP_URL='smtps://USER:PASS@smtp.example.com:465' EMAIL_FROM='BLST <no-reply@example.org>'
     railway variable set --service blst TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+15551234567
     railway variable set --service blst AUTH_LOG_CODES=false
See docs/RAILWAY.md for details.
DONE

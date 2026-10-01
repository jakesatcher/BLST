#!/usr/bin/env bash
# Deploy BLST (with BLPA Factions built in) to Railway in one command:
#
#   npm run railway
#
# Creates a new Railway project with Postgres and one "blst" service,
# generates the secrets and gives it a public address. The same script is
# in the blpafactions repo; run it from either one.
#
# Before running: let Railway's GitHub app read jakesatcher/BLST
# (railway.com -> Account -> Integrations -> GitHub). You'll be asked to log
# in to Railway if you aren't already. Uses the Railway CLI if installed,
# otherwise runs it with npx (nothing to install).
set -euo pipefail

# Which code to deploy. Change to "main" once the branch is merged.
BLST_BRANCH="${BLST_BRANCH:-claude/great-bardeen-wfd39q}"
PROJECT_NAME="${PROJECT_NAME:-blpa}"

if command -v railway >/dev/null; then rw() { railway "$@"; }; else rw() { npx -y @railway/cli@5 "$@"; }; fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
rw whoami >/dev/null 2>&1 || rw login

echo "Creates Railway project \"$PROJECT_NAME\": Postgres + blst ($BLST_BRANCH, with BLPA Factions built in)."
if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Continue? [y/N] " ok
  [[ "$ok" =~ ^[Yy] ]] || exit 1
fi

SETUP_KEY="$(openssl rand -hex 24)"

rw init --name "$PROJECT_NAME"
rw add --database postgres
# ${{...}} is a Railway reference, filled in by Railway; single quotes keep
# the shell from expanding it.
rw add --service blst --repo jakesatcher/BLST --branch "$BLST_BRANCH" \
  --variables PORT=8080 \
  --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --variables "ADMIN_TOKEN=$SETUP_KEY" \
  --variables "AUTH_SECRET=$(openssl rand -hex 32)" \
  --variables AUTH_LOG_CODES=true \
  --variables SEED_DEMO=true
rw domain --service blst --port 8080

cat <<DONE

Done. Railway is building BLST (a few minutes).

  Setup key: $SETUP_KEY
  (Also in the blst service's Variables tab on railway.com.)

Open the address above -> Admin & setup -> "Set up the admin account".
Sign-in codes show in the blst logs until email/SMS are set up; see docs/RAILWAY.md.
DONE

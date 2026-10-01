#!/usr/bin/env bash
# Deploy BLST + BLPA Factions to Railway, side by side, in one command:
#
#   npm run railway
#
# The same script lives in both repos (jakesatcher/BLST and
# jakesatcher/blpafactions); run it from either one. It creates a new
# Railway project with Postgres, a "factions" service and a "blst" service,
# generates the secrets, connects BLST to Factions over Railway's private
# network and gives both apps a public address.
#
# Before running: let Railway's GitHub app read both repos
# (railway.com -> Account -> Integrations -> GitHub). You'll be asked to log
# in to Railway if you aren't already. Uses the Railway CLI if installed,
# otherwise runs it with npx (nothing to install).
set -euo pipefail

# Which code to deploy. Change these to "main" once the branches are merged.
BLST_BRANCH="${BLST_BRANCH:-claude/great-bardeen-wfd39q}"
FACTIONS_BRANCH="${FACTIONS_BRANCH:-claude/great-bardeen-wfd39q}"
PROJECT_NAME="${PROJECT_NAME:-blpa}"

if command -v railway >/dev/null; then rw() { railway "$@"; }; else rw() { npx -y @railway/cli@5 "$@"; }; fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
rw whoami >/dev/null 2>&1 || rw login

echo "Creates Railway project \"$PROJECT_NAME\": Postgres + factions ($FACTIONS_BRANCH) + blst ($BLST_BRANCH)."
if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Continue? [y/N] " ok
  [[ "$ok" =~ ^[Yy] ]] || exit 1
fi

FACTIONS_TOKEN="$(openssl rand -hex 24)"
SETUP_KEY="$(openssl rand -hex 24)"

rw init --name "$PROJECT_NAME"
rw add --database postgres

# ${{...}} are Railway references, filled in by Railway; single quotes keep
# the shell from expanding them. Factions keeps its tables in the "factions"
# schema of the shared database; BLST uses "public".
rw add --service factions --repo jakesatcher/blpafactions --branch "$FACTIONS_BRANCH" \
  --variables PORT=8080 \
  --variables "ADMIN_TOKEN=$FACTIONS_TOKEN" \
  --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}?schema=factions'

rw add --service blst --repo jakesatcher/BLST --branch "$BLST_BRANCH" \
  --variables PORT=8080 \
  --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --variables "ADMIN_TOKEN=$SETUP_KEY" \
  --variables "AUTH_SECRET=$(openssl rand -hex 32)" \
  --variables AUTH_LOG_CODES=true \
  --variables SEED_DEMO=true \
  --variables 'FACTIONS_BASE_URL=http://${{factions.RAILWAY_PRIVATE_DOMAIN}}:${{factions.PORT}}' \
  --variables 'FACTIONS_ADMIN_TOKEN=${{factions.ADMIN_TOKEN}}'

rw domain --service blst --port 8080
rw domain --service factions --port 8080

cat <<DONE

Done. Railway is building both apps (a few minutes).

  BLST setup key:        $SETUP_KEY
  Factions admin token:  $FACTIONS_TOKEN
  (Both are also in each service's Variables tab on railway.com.)

Open the blst address above -> Admin & setup -> "Set up the admin account".
Sign-in codes show in the blst logs until email/SMS are set up; see docs/RAILWAY.md.
DONE

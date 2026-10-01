#!/usr/bin/env bash
# Deploy BLST (with BLPA Factions built in) to Railway in one command:
#
#   npm run railway                 # asks once, then does everything
#   npm run railway -- --template   # also makes a "Deploy on Railway" button
#
# Creates a Railway project with Postgres and one "blst" service and gives
# it a public address. Nothing secret is configured: on first start BLST
# generates its own secrets, switches to a least-privilege database role
# and prints a one-time setup key, which this script reads back and shows.
# The same script is in the blpafactions repo; run it from either one.
#
# Before running: let Railway's GitHub app read jakesatcher/BLST
# (railway.com -> Account -> Integrations -> GitHub). You'll be asked to log
# in to Railway if you aren't already. Uses the Railway CLI if installed,
# otherwise runs it with npx (nothing to install).
set -euo pipefail

# Which code to deploy. Change to "main" once the branch is merged.
BLST_BRANCH="${BLST_BRANCH:-claude/great-bardeen-wfd39q}"
PROJECT_NAME="${PROJECT_NAME:-blpa}"
YES=0; TEMPLATE=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --template) TEMPLATE=1 ;;
    *) echo "unknown option: $a (use --yes, --template)" >&2; exit 2 ;;
  esac
done

if command -v railway >/dev/null; then rw() { railway "$@"; }; else rw() { npx -y @railway/cli@5 "$@"; }; fi
rw whoami >/dev/null 2>&1 || rw login

echo "Creates Railway project \"$PROJECT_NAME\": Postgres + blst ($BLST_BRANCH, with BLPA Factions built in)."
if [[ $YES -eq 0 ]]; then
  read -r -p "Continue? [y/N] " ok
  [[ "$ok" =~ ^[Yy] ]] || exit 1
fi

rw init --name "$PROJECT_NAME"
rw add --database postgres
# ${{...}} is a Railway reference, filled in by Railway; single quotes keep
# the shell from expanding it. These are the only settings BLST needs.
rw add --service blst --repo jakesatcher/BLST --branch "$BLST_BRANCH" \
  --variables PORT=8080 \
  --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --variables SEED_DEMO=true
rw domain --service blst --port 8080

echo
echo "Railway is building BLST. Waiting for the first start to read the setup key (usually 2-4 minutes)…"
KEY=""
for _ in $(seq 1 40); do
  KEY="$(rw logs --service blst --lines 400 2>/dev/null | grep -oE 'setup-[A-Za-z0-9_-]{20,}' | tail -1 || true)"
  [[ -n "$KEY" ]] && break
  sleep 15
done

if [[ $TEMPLATE -eq 1 ]]; then
  echo
  echo "Making a one-click template from this project…"
  rw templates create || echo "Couldn't create the template; do it in the dashboard instead (see docs/RAILWAY.md)."
fi

echo
if [[ -n "$KEY" ]]; then
  echo "Done. Setup key: $KEY"
else
  echo "Done. BLST is still starting; get the setup key with:"
  echo "  railway logs --service blst --lines 400 | grep 'Setup key'"
fi
cat <<'DONE'
Open the address above -> Admin & setup -> "Set up the admin account" and enter
the setup key. Sign-in codes show in the blst logs until email/SMS are set up
(see docs/RAILWAY.md).
DONE

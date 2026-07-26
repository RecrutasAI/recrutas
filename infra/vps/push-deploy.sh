#!/usr/bin/env bash
# Deploy the current main to the VPS. Run this from the DEV MACHINE:
#   infra/vps/push-deploy.sh
#
# Why not deploy.sh / git pull on the server: the repo is private, deploy keys
# are disabled at the org level, and the box has no GitHub credentials. Rather
# than park a long-lived token on the cron host, code is pushed TO it over the
# SSH access the dev machine already has — the VPS needs no GitHub access at all.
#
# This exists because the previous "ship it by hand with scp" workflow let
# /opt/recrutas/app drift 16 commits behind main for ~4 weeks, with
# server/lib/db-capacity.ts missing on the box that actually runs ingestion,
# while infra/vps/* looked current. One command, and it verifies the result.
set -euo pipefail

HOST="${VPS_HOST:-178.156.193.183}"
KEY="${VPS_SSH_KEY:-$HOME/.ssh/recrutas_cron}"
APP="${VPS_APP_DIR:-/opt/recrutas/app}"
BRANCH="${DEPLOY_BRANCH:-main}"
SSH=(ssh -o ConnectTimeout=10 -i "$KEY" "root@$HOST")

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking local tree"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is dirty — commit or stash before deploying." >&2
  exit 1
fi
LOCAL="$(git rev-parse "$BRANCH")"
if git rev-parse "origin/$BRANCH" >/dev/null 2>&1; then
  if [ "$(git rev-parse "origin/$BRANCH")" != "$LOCAL" ]; then
    echo "WARNING: $BRANCH differs from origin/$BRANCH — deploying code that is not pushed." >&2
  fi
fi
echo "local $BRANCH = $(git rev-parse --short "$BRANCH") $(git log -1 --format=%s "$BRANCH")"

say "Checking VPS"
REMOTE="$("${SSH[@]}" "git -C $APP rev-parse HEAD")"
echo "vps HEAD    = ${REMOTE:0:8}"
if [ "$REMOTE" = "$LOCAL" ]; then
  echo "Already up to date."
  exit 0
fi
if ! git cat-file -e "$REMOTE^{commit}" 2>/dev/null; then
  echo "VPS is at $REMOTE which does not exist locally — fetch first, or reclone the box." >&2
  exit 1
fi
echo "shipping $(git rev-list --count "$REMOTE..$LOCAL") commit(s)"

say "Building bundle"
BUNDLE="$(mktemp -t recrutas-deploy-XXXXXX.bundle)"
trap 'rm -f "$BUNDLE"' EXIT
git bundle create "$BUNDLE" "^$REMOTE" "$BRANCH" >/dev/null 2>&1
echo "bundle: $(du -h "$BUNDLE" | cut -f1)"

say "Applying on VPS"
scp -o ConnectTimeout=10 -i "$KEY" "$BUNDLE" "root@$HOST:/tmp/deploy.bundle" >/dev/null
"${SSH[@]}" bash -s <<EOF
set -e
cd "$APP"
# Discard any hand-edits on the box; main is the source of truth. (.env and the
# .env.*.bak rollback copies are untracked and are left alone.)
git checkout -- . 2>/dev/null || true
git fetch /tmp/deploy.bundle "$BRANCH"
git reset --hard FETCH_HEAD
rm -f /tmp/deploy.bundle
# Reinstall deps only when the lockfile actually moved.
if ! git diff --quiet "$REMOTE" HEAD -- package-lock.json; then
  echo "lockfile changed — npm ci"
  npm ci --omit=dev
fi
chmod +x infra/vps/*.sh
crontab infra/vps/crontab
EOF

say "Verifying"
NEW="$("${SSH[@]}" "git -C $APP rev-parse HEAD")"
DRIFT="$("${SSH[@]}" "git -C $APP status --porcelain | grep -v '\.bak' | wc -l")"
CRONS="$("${SSH[@]}" "crontab -l | grep -c '^[0-9*]'")"
echo "vps HEAD  = ${NEW:0:8}"
echo "drift     = $DRIFT"
echo "crons     = $CRONS"

if [ "$NEW" != "$LOCAL" ]; then
  echo "FAILED: VPS did not reach $LOCAL" >&2
  exit 1
fi
if [ "$DRIFT" != "0" ]; then
  echo "FAILED: VPS has uncommitted drift after deploy" >&2
  "${SSH[@]}" "git -C $APP status --short" >&2
  exit 1
fi
say "Deployed $(git log -1 --format='%h %s' "$BRANCH")"

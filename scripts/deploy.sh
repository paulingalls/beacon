#!/usr/bin/env bash
#
# Runs ON the droplet as the `beacon` user. Invoked by ~/deploy.sh after it
# fast-forwards ~/app to origin/main. Installs deps, runs DB migrations, restarts
# the systemd service, health-checks, and rolls back to the previous commit if
# the new one is unhealthy.
#
# Beacon does NOT migrate on server startup (decision 6d348d2d0cec keeps /health
# DB-free), so migrations run here, before the restart. The runner is idempotent
# and transaction-advisory-locked, so running it on every deploy is safe.
#
# SECURITY: never echo the environment and never enable `set -x` — DATABASE_URL
# (a managed-PG connection string with a password) is sourced below and must not
# reach logs/journald. migrate.ts itself logs only applied filenames.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/app}"
SERVICE="${SERVICE:-beacon}"
HEALTH_URL="${HEALTH_URL:-http://localhost:8080/health}"
ENV_FILE="${ENV_FILE:-$HOME/.env.production}"
BUN="${BUN:-$HOME/.bun/bin/bun}"

cd "$APP_DIR"

# Where we'd roll back to: the commit HEAD pointed at before ~/deploy.sh reset it.
PREV="$(git rev-parse 'HEAD@{1}' 2>/dev/null || git rev-parse HEAD)"
HEAD_NOW="$(git rev-parse --short HEAD)"
echo "Deploying ${HEAD_NOW} (rollback target: ${PREV:0:7})"

install_deps() {
  "$BUN" install --frozen-lockfile --production --ignore-scripts
}

run_migrations() {
  # Source the env in a subshell so DATABASE_URL never persists in this shell's
  # environment beyond the migrate call. `set +x` is implied (never enabled).
  # shellcheck source=/dev/null  # runtime-only file on the droplet, not in repo
  ( set -a; . "$ENV_FILE"; set +a; "$BUN" run migrate )
}

restart_and_check() {
  sudo systemctl restart "$SERVICE"
  for _ in $(seq 1 20); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

install_deps

# Migrate before restart. A migration failure aborts the deploy (set -e) BEFORE
# the running service is touched, leaving the old version up.
run_migrations

if restart_and_check; then
  echo "✅ Deploy healthy at ${HEAD_NOW}"
  exit 0
fi

echo "❌ Health check failed after restart — rolling back to ${PREV:0:7}"
git reset --hard "$PREV"
install_deps
# NOTE: migrations are deliberately NOT re-run here. The runner is forward-only
# (no down-migrations; see migrate.ts), so any migration the failed deploy applied
# is already in place and re-running it would be a no-op — it cannot restore an
# older schema. This rollback restores CODE only. It is safe iff migrations are
# backward-compatible (expand/contract: additive, no destructive change the old
# code can't tolerate). A breaking migration cannot be auto-recovered — the old
# code will run against the migrated schema and likely fail the health check
# below, landing on the exit-2 manual-intervention path.
if restart_and_check; then
  echo "↩️  Rolled back to ${PREV:0:7} and healthy. Investigate ${HEAD_NOW}."
  exit 1
fi

echo "🔥 Rollback is ALSO unhealthy — service is down, manual intervention required."
echo "   Check: sudo journalctl -u ${SERVICE} -n 100 --no-pager"
exit 2

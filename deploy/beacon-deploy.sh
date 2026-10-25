#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/app}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/beacon-deploy}"
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/lock"
if ! flock -n 9; then
  echo 'Another deploy holds the lock; skipping.'
  exit 0
fi

cd "$APP_DIR"
git fetch origin \
  '+refs/heads/release:refs/remotes/origin/release' \
  '+refs/heads/main:refs/remotes/origin/main'
TARGET="$(git rev-parse refs/remotes/origin/release)"
if [ "$TARGET" = "$(git rev-parse HEAD)" ]; then
  echo "Already at release $TARGET; skipping."
  exit 0
fi
if [ -e "$STATE_DIR/last-failed" ]; then
  FAILED="$(cat "$STATE_DIR/last-failed")"
  if [ "$TARGET" = "$FAILED" ]; then
    echo "Release $TARGET previously failed; skipping."
    exit 0
  fi
fi

if ! git merge-base --is-ancestor "$TARGET" refs/remotes/origin/main; then
  printf '%s\n' "$TARGET" > "$STATE_DIR/last-failed"
  echo "Release $TARGET is not on main; refusing." >&2
  exit 1
fi
# Release only moves forward: an older main commit would pass the main check and
# silently downgrade prod. A deliberate rollback is an operator action, by hand.
if ! git merge-base --is-ancestor HEAD "$TARGET"; then
  printf '%s\n' "$TARGET" > "$STATE_DIR/last-failed"
  echo "Release $TARGET is behind HEAD; refusing." >&2
  exit 1
fi

git reset --hard "$TARGET"
if bash scripts/deploy.sh; then
  echo "Deployed $TARGET."
else
  STATUS=$?
  printf '%s\n' "$TARGET" > "$STATE_DIR/last-failed"
  echo "Release $TARGET failed (exit $STATUS)." >&2
  exit "$STATUS"
fi

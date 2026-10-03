#!/usr/bin/env sh
set -eu
root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --absolute-git-dir)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
if [ "$git_dir" = "$common_dir" ]; then
  echo 'Refusing worktree teardown from the primary checkout' >&2
  exit 1
fi
cd "$root"
docker compose rm -fsv
docker compose down

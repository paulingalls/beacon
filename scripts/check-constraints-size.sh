#!/bin/sh
# xp wall: refuse a commit when .xp/constraints.md exceeds constraints_chars_cap in .xp/config.yml.
# Copied from the xp-plugin templates/hook-lib.sh constraints_size; lefthook pre-commit runs it.
cd "$(git rev-parse --show-toplevel)" || exit 1
constraints_size() {
  cap="$(sed -n 's/^constraints_chars_cap:[[:space:]]*//p' .xp/config.yml | head -1 | sed 's/[[:space:]][[:space:]]*#.*$//')"
  if [ -z "$cap" ]; then
    echo "xp wall: constraints_chars_cap is missing in .xp/config.yml — refusing." >&2
    echo "  Add \`constraints_chars_cap: 4500\` to .xp/config.yml, then retry." >&2
    exit 1
  fi
  case "$cap" in *[!0-9]*|0)
    echo "xp wall: constraints_chars_cap '$cap' is invalid in .xp/config.yml — use a positive integer." >&2
    exit 1;;
  esac
  if [ ! -f .xp/constraints.md ]; then
    echo "xp wall: .xp/constraints.md is missing — refusing." >&2
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "xp wall: python3 not installed — refusing to pass a commit nothing measured." >&2
    echo "  Install python3 (every xp script needs it), then retry." >&2
    exit 1
  fi
  # encoding PINNED: read_text defaults to the LOCALE's encoding, so under a C
  # locale with PEP 538 coercion off every non-ASCII BYTE decodes to its own
  # replacement char and the count becomes the byte length (measured: 11 chars
  # counted 44). A cap that changes with $LC_ALL is not a cap.
  count="$(python3 -c 'from pathlib import Path; print(len(Path(".xp/constraints.md").read_text(encoding="utf-8", errors="replace")))')"
  # An EMPTY count is `[ "" -gt N ]`, which errors and reads as "under cap": the
  # measurement failing must refuse, not pass (the rule this file opens with).
  case "$count" in ""|*[!0-9]*)
    echo "xp wall: could not measure .xp/constraints.md — refusing to pass a commit nothing measured." >&2
    echo "  The error above is python3's: make .xp/constraints.md readable, then retry." >&2
    exit 1;;
  esac
  if [ "$count" -gt "$cap" ]; then
    echo "xp wall: .xp/constraints.md is $count characters against constraints_chars_cap $cap." >&2
    echo "  retire or shorten a constraint, then retry." >&2
    exit 1
  fi
}
constraints_size

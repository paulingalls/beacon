#!/usr/bin/env bash
set -uo pipefail
export LC_ALL=C
umask 077
ROOT=${INTEGRITY_ROOT:-}
APP=${INTEGRITY_APP:-/home/beacon/app}
POLICY=${INTEGRITY_POLICY:-/etc/beacon-integrity}
CACHE=${INTEGRITY_CACHE:-/var/cache/beacon-integrity}
LOCK=${INTEGRITY_LOCK:-/home/beacon/.local/state/beacon-deploy/lock}
BUN=${INTEGRITY_BUN:-/home/beacon/.bun/bin/bun}
ALERT_ENV=${INTEGRITY_ALERT_ENV:-/etc/beacon-integrity/alert.env}
RELEASE_BASE=${INTEGRITY_RELEASE_BASE:-https://github.com/oven-sh/bun/releases/download/bun-v}
ALERT_BASE=${INTEGRITY_ALERT_BASE:-https://api.resend.com}
failures=
check_pid=
WORK=
notify() (
  set -e
  # This root-owned config is separate from the app's environment.
  # shellcheck disable=SC1090
  . "$ALERT_ENV"
  : "${RESEND_API_KEY:?}" "${ALERT_FROM:?}" "${ALERT_TO:?}"
  [[ "$RESEND_API_KEY" =~ ^[a-zA-Z0-9_-]+$ ]]
  alert_work=$(mktemp -d)
  trap 'rm -rf "$alert_work"' EXIT
  printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$RESEND_API_KEY" > "$alert_work/headers"
  jq -n --arg from "$ALERT_FROM" --arg to "$ALERT_TO" \
    --arg subject "Beacon integrity failure on $(hostname)" \
    --arg text "$(date -u +%FT%TZ) on $(hostname)"$'\n'"${failures:-runner aborted}" \
    '{from:$from,to:[$to],subject:$subject,text:$text}' > "$alert_work/email"
  status=$(curl -sS --connect-timeout 10 --max-time 30 -o "$alert_work/response" -w '%{http_code}' \
    -H "@$alert_work/headers" --data-binary "@$alert_work/email" "$ALERT_BASE/emails")
  [[ "$status" = 2?? ]]
  id=$(jq -er '.id | strings | select(length > 0)' "$alert_work/response")
  printf 'Alert accepted: %s\n' "$id"
)
finish() {
  local status=$?
  trap - EXIT TERM INT
  [ -z "$check_pid" ] || kill "$check_pid" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    set +e
    (notify)
    local delivery=$?
    [ "$delivery" -eq 0 ] || echo 'Alert delivery FAILED: inspect root alert configuration, network and provider' >&2
  fi
  [ -z "$WORK" ] || rm -rf "$WORK"
  exit "$status"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
set -e
WORK=$(mktemp -d)
jq -e '(.keys | type == "object") and (.uid0 | type == "array") and
  (.logins | type == "array") and (.sudoers | type == "object") and
  (.units | type == "array") and (.links | type == "object") and
  (.suid | type == "array")' "$POLICY/allowlist" >/dev/null
set +e

as_app() {
  if [ "$EUID" -eq 0 ]; then runuser -u beacon -- "$@"; else "$@"; fi
}
# dpkg leading-slash queries are fnmatch patterns, not literal filenames.
owned() {
  local path status alias
  path=$(printf '%s' "$1" | sed 's/[][*?\\]/\\&/g')
  dpkg -S "$path" >/dev/null 2>&1 && return 0
  status=$?; [ "$status" -eq 1 ] || return 2
  case "$path" in
    /usr/bin/*|/usr/sbin/*|/usr/lib/*|/usr/lib64/*) alias=${path#/usr} ;;
    /bin/*|/sbin/*|/lib/*|/lib64/*) alias=/usr$path ;;
    *) return 1 ;;
  esac
  dpkg -S "$alias" >/dev/null 2>&1 && return 0
  status=$?; [ "$status" -eq 1 ] || return 2
  return 1
}
packages() {
  local line path
  dpkg --verify > "$WORK/dpkg"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path=/${line#*/}
    case "$path" in
      /etc/*) printf 'INFO package drift: %s\n' "$line" ;;
      *) echo "$line"; return 1 ;;
    esac
  done < "$WORK/dpkg"
}
config() {
  cmp "$ROOT/etc/caddy/Caddyfile" "$POLICY/Caddyfile"
  # sudo treats its main conffile as policy, despite dpkg's informational marker.
  ! grep -Eq ' /etc/sudoers$' "$WORK/dpkg"
}
keys() {
  local user home file line fingerprint actual expected
  # A root-written sshd drop-in can add key sources this loop never reads.
  sshd -T | grep -Ei '^(authorizedkeysfile|authorizedkeyscommand|trustedusercakeys|authorizedprincipalsfile|authorizedprincipalscommand) ' |
    sort > "$WORK/sshd-keys"
  printf '%s\n' 'authorizedkeyscommand none' 'authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2' \
    'authorizedprincipalscommand none' 'authorizedprincipalsfile none' 'trustedusercakeys none' | sort > "$WORK/sshd-expected"
  cmp -s "$WORK/sshd-keys" "$WORK/sshd-expected" || { echo "sshd key sources differ"; return 1; }
  # sshd accepts keys for any account, including nologin ones (port forwarding needs no shell).
  getent passwd | awk -F: '{print $1 ":" $6}' > "$WORK/homes"
  while IFS=: read -r user home; do
    : > "$WORK/keys"
    for file in "$ROOT$home/.ssh/authorized_keys" "$ROOT$home/.ssh/authorized_keys2"; do
      if [ -e "$file" ] || [ -L "$file" ]; then
        cat "$file" > "$WORK/key-input"
        while IFS= read -r line || [ -n "$line" ]; do
          [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
          printf '%s\n' "$line" > "$WORK/key-line"
          fingerprint=$(ssh-keygen -lf "$WORK/key-line" -E sha256)
          printf '%s\n' "$fingerprint" | awk '{print $2}' >> "$WORK/keys"
        done < "$WORK/key-input"
      fi
    done
    actual=$(sort "$WORK/keys")
    expected=$(jq -er --arg user "$user" '.keys[$user] // [] | sort | join("\n")' "$POLICY/allowlist")
    [ "$actual" = "$expected" ] || { echo "$user fingerprints differ"; return 1; }
  done < "$WORK/homes"
}
accounts() {
  local entries actual expected
  entries=$(getent passwd)
  actual=$(printf '%s\n' "$entries" | awk -F: '$3 == 0 {print $1}' | sort)
  expected=$(jq -r '.uid0 | sort | join("\n")' "$POLICY/allowlist")
  [ "$actual" = "$expected" ]
  actual=$(printf '%s\n' "$entries" | awk -F: '$7 !~ /^\/(usr\/)?sbin\/nologin$/ && $7 !~ /^\/(usr\/)?bin\/false$/ && $7 != "/bin/sync" {print $1}' | sort)
  expected=$(jq -r '.logins | sort | join("\n")' "$POLICY/allowlist")
  [ "$actual" = "$expected" ]
}
sudoers() {
  local file name actual expected
  visudo -cf "$ROOT/etc/sudoers"
  find "$ROOT/etc/sudoers.d" -mindepth 1 -maxdepth 1 -print > "$WORK/sudo-files"
  while IFS= read -r file; do
    name=$(basename "$file")
    expected=$(jq -er --arg name "$name" '.sudoers[$name] | join("\n")' "$POLICY/allowlist")
    # sudo parses #include, #includedir, #uid and #-uid lines as rules, not comments.
    actual=$(awk '!/^[[:space:]]*$/ && (!/^[[:space:]]*#/ || /^[[:space:]]*#([-0-9]|include)/)' "$file")
    [ "$actual" = "$expected" ] || { echo "$name rules differ"; return 1; }
  done < "$WORK/sudo-files"
  actual=$(sed 's|.*/||' "$WORK/sudo-files" | sort)
  expected=$(jq -r '.sudoers | keys | sort | join("\n")' "$POLICY/allowlist")
  [ "$actual" = "$expected" ]
}
suid() {
  local file
  find "${ROOT:-/}" -xdev -type f \( -perm -4000 -o -perm -2000 \) -print0 > "$WORK/suid"
  while IFS= read -r -d '' file; do
    owned "${file#"$ROOT"}" || { echo "unowned ${file#"$ROOT"}"; return 1; }
    # dpkg --verify compares digests, not modes, so an added setuid bit needs this list.
    jq -e --arg path "${file#"$ROOT"}" '.suid | index($path) != null' "$POLICY/allowlist" >/dev/null ||
      { echo "unlisted ${file#"$ROOT"}"; return 1; }
  done < "$WORK/suid"
}
units() {
  local dir file path target status expected resolved
  : > "$WORK/units"
  for dir in /etc/systemd/system /etc/systemd/system.control /etc/systemd/system.attached /run/systemd/system /run/systemd/system.control /run/systemd/system.attached /run/systemd/transient /run/systemd/generator.early /run/systemd/generator /run/systemd/generator.late /usr/local/lib/systemd/system /usr/lib/systemd/system; do
    [ ! -d "$ROOT$dir" ] || find "$ROOT$dir" \( -type f -o -type l \) -print0 >> "$WORK/units"
  done
  while IFS= read -r -d '' file; do
    path=${file#"$ROOT"}
    # Runtime scopes group existing processes; they cannot start programs.
    case "$path" in /run/systemd/transient/*.scope) continue ;; esac
    if [ -L "$file" ]; then
      target=$(readlink "$file")
      # systemd permits dangling dependencies and masks. Review exact pairs.
      expected=$(jq -r --arg path "$path" '.links[$path] // ""' "$POLICY/allowlist")
      if [ -n "$expected" ]; then
        [ "$target" = "$expected" ]
        continue
      fi
      case "$target" in /*) resolved=$ROOT$target ;; *) resolved=$(dirname "$file")/$target ;; esac
      path=$(realpath -e "$resolved"); path=${path#"$ROOT"}
      # Packaged masks point at /dev/null, which is not itself package-owned.
      owned "${file#"$ROOT"}" && continue
      status=$?; [ "$status" -eq 1 ] || return 2
    fi
    owned "$path" && continue
    status=$?; [ "$status" -eq 1 ] || return 2
    jq -e --arg path "$path" '.units | index($path) != null' "$POLICY/allowlist" >/dev/null || { echo "unapproved $path from ${file#"$ROOT"}"; return 1; }
  done < "$WORK/units"
}
loader() { [ ! -e "$ROOT/etc/ld.so.preload" ] && [ ! -L "$ROOT/etc/ld.so.preload" ]; }
processes() {
  local exe target
  [ -r "$ROOT/proc" ] || return 1
  [ -x "$ROOT/proc" ] || return 1
  for exe in "$ROOT"/proc/[0-9]*/exe; do
    if target=$(readlink "$exe"); then
      case "$target" in *' (deleted)') echo "deleted executable: $exe"; return 1 ;; esac
    else
      # Kernel threads have no exe; vanished processes are harmless scan races.
      [ -d "$(dirname "$exe")" ] || continue
      grep -Eq '^Kthread:[[:space:]]+1$' "$(dirname "$exe")/status" || { echo "cannot read $exe"; return 1; }
    fi
  done
}
checkout() (
  exec 9< "$LOCK"
  flock -w 60 9
  local status head release
  status=$(as_app git -C "$APP" status --porcelain)
  head=$(as_app git -C "$APP" rev-parse HEAD)
  release=$(as_app git -C "$APP" rev-parse refs/remotes/origin/release)
  [ -z "$status" ] && [ "$head" = "$release" ]
)
hash() { sha256sum "$1" | awk '{print $1}'; }
bun_binary() {
  local version asset expected digest actual base arch
  version=$(cat "$APP/.bun-version")
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  arch=$(uname -m)
  case "$arch" in
    x86_64) asset=bun-linux-x64; grep -q avx2 "$ROOT/proc/cpuinfo" || asset=$asset-baseline ;;
    aarch64|arm64) asset=bun-linux-aarch64 ;;
    *) echo "unsupported architecture $arch"; return 1 ;;
  esac
  mkdir -p "$CACHE"
  if [ ! -f "$CACHE/$version-$asset.sha256" ]; then
    base=$RELEASE_BASE$version
    curl -fsSL --connect-timeout 10 --max-time 120 "$base/SHASUMS256.txt" -o "$WORK/sums"
    curl -fsSL --connect-timeout 10 --max-time 120 "$base/$asset.zip" -o "$WORK/bun.zip"
    digest=$(awk -v asset="$asset.zip" '$2 == asset {print $1}' "$WORK/sums")
    [[ "$digest" =~ ^[a-f0-9]{64}$ ]]
    actual=$(hash "$WORK/bun.zip"); [ "$digest" = "$actual" ]
    unzip -p "$WORK/bun.zip" "$asset/bun" > "$WORK/bun"
    expected=$(hash "$WORK/bun")
    printf '%s\n' "$expected" > "$CACHE/.$version-$asset.$$"
    mv "$CACHE/.$version-$asset.$$" "$CACHE/$version-$asset.sha256"
  fi
  expected=$(cat "$CACHE/$version-$asset.sha256")
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]]
  actual=$(hash "$BUN"); [ "$expected" = "$actual" ]
}
check() {
  local name=$1 output status line
  shift
  # Calling a check in an if/|| would silently disable errexit inside its body.
  (set -e; "$@") > "$WORK/check" 2>&1 &
  check_pid=$!
  wait "$check_pid"
  status=$?
  check_pid=
  output=$(cat "$WORK/check")
  if [ "$status" -eq 0 ]; then
    [ -z "$output" ] || printf '%s\n' "$output"
    printf 'PASS %s: verified\n' "$name"
  else
    line="FAIL $name: ${output:-mismatch or inventory failure}"
    line=${line//$'\n'/; }
    printf '%s\n' "$line"
    failures+="$line"$'\n'
  fi
}
check Packages packages
check Config config
check Keys keys
check Accounts accounts
check Sudoers sudoers
check SUID/SGID suid
check Units units
check Loader loader
check Processes processes
check Checkout checkout
check Bun bun_binary
[ -z "$failures" ]

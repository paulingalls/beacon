#!/usr/bin/env bash
#
# One-shot provisioning for a fresh Ubuntu 24.04 droplet, run as root:
#
#   ssh -i ~/.ssh/<key> root@<DROPLET_IP> 'bash -s' < scripts/provision-droplet.sh
#
# Rerun after Tailscale enrollment as paul with sudo; see docs/DEPLOYMENT.md.
# Lockdown requires a logged-in, running Tailscale node.
set -euo pipefail

APP_USER=beacon
APP_DIR="/home/${APP_USER}/app"
# SSH remote — the repo is private, so the droplet authenticates with a read-only
# GitHub deploy key generated below (registered once via `gh repo deploy-key add`).
REPO="git@github.com:paulingalls/beacon.git"
# Fresh boots must use a gated release; override for disposable validation only.
DEPLOY_BRANCH="${DEPLOY_BRANCH:-release}"

echo "==> apt deps (unzip BEFORE bun, curl, git, caddy prereqs)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y unzip curl git debian-keyring debian-archive-keyring apt-transport-https util-linux ufw unattended-upgrades jq sudo

echo "==> Caddy (official apt repo)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> Tailscale (Ubuntu 24.04 repository)"
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
  > /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
  > /etc/apt/sources.list.d/tailscale.list
apt-get update -y
apt-get install -y tailscale
systemctl enable --now tailscaled
timedatectl set-timezone UTC
cat > /etc/apt/apt.conf.d/52beacon-unattended <<'EOF'
// Beacon: keep the third-party edge packages patched and reboot onto new kernels.
// Without Automatic-Reboot, kernel fixes install but never run (2026-10: 126 days on 6.8.0-71).
Unattended-Upgrade::Origins-Pattern { "origin=cloudsmith/caddy/stable"; "origin=Tailscale"; };
// Reboot only when a package requires it, at 10:00 UTC (03:00 US Pacific, lowest traffic).
Unattended-Upgrade::Automatic-Reboot "true"; Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "10:00";
EOF

echo "==> operator paul and app user ${APP_USER}"
for user in paul "${APP_USER}"; do
  if ! id "$user" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$user"
  fi
  install -d -m 700 -o "$user" -g "$user" "/home/$user/.ssh"
done
usermod -aG adm,systemd-journal paul
if [ ! -s /home/paul/.ssh/authorized_keys ] && [ -s /root/.ssh/authorized_keys ]; then
  install -m 600 -o paul -g paul /root/.ssh/authorized_keys /home/paul/.ssh/authorized_keys
fi
# Never replace a rotated operator key with cloud-init's original root key.
ssh-keygen -lf /home/paul/.ssh/authorized_keys >/dev/null || {
  echo 'No usable paul authorized key; refusing lockdown.' >&2
  exit 1
}
install -m 600 -o "${APP_USER}" -g "${APP_USER}" /dev/null "/home/${APP_USER}/.ssh/authorized_keys"
rm -f "/home/${APP_USER}/.ssh/authorized_keys2"

for user in paul "${APP_USER}"; do
  staged=$(mktemp "/etc/sudoers.d/.$user.XXXXXX")
  if [ "$user" = paul ]; then
    printf 'paul ALL=(ALL) NOPASSWD:ALL\n' > "$staged"
  else
    printf 'beacon ALL=(root) NOPASSWD: /usr/bin/systemctl restart beacon, /usr/bin/systemctl restart beacon.service\n' > "$staged"
  fi
  visudo -cf "$staged"
  chown root:root "$staged"
  chmod 440 "$staged"
  mv -f "$staged" "/etc/sudoers.d/$user"
done

echo "==> GitHub read-only deploy key (private repo)"
sudo -u "${APP_USER}" -H bash -lc '
  set -e
  if [ ! -f "$HOME/.ssh/github_deploy" ]; then
    ssh-keygen -t ed25519 -N "" -f "$HOME/.ssh/github_deploy" -C "beacon-droplet-deploy-key"
  fi
  cat > "$HOME/.ssh/config" <<CFG
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
CFG
  chmod 600 "$HOME/.ssh/config"
'

echo "==> clone/refresh the repo at ${APP_DIR}"
if ! sudo -u "${APP_USER}" -H bash -lc "
  set -e
  if [ ! -d '${APP_DIR}/.git' ]; then git clone --branch '${DEPLOY_BRANCH}' '${REPO}' '${APP_DIR}'
  else cd '${APP_DIR}' && git fetch --all --prune; fi
"; then
  echo
  echo "!! Repo clone failed — the deploy key is not yet registered on GitHub."
  echo "   Register this public key as a read-only deploy key, then re-run this script:"
  echo "   gh repo deploy-key add <(printf '%s' \"\$KEY\") --title beacon-droplet"
  echo "   ---8<--- deploy key ---8<---"
  cat "/home/${APP_USER}/.ssh/github_deploy.pub"
  echo "   ---8<--------------------8<---"
  exit 3
fi

echo "==> Bun (as ${APP_USER}, from the checked-out pin)"
sudo -u "${APP_USER}" -H bash -lc '
  set -euo pipefail
  version="$(cat "$1/.bun-version")"
  if [ -z "$version" ]; then echo "Bun version pin is empty" >&2; exit 1; fi
  if [ ! -x "$HOME/.bun/bin/bun" ] || [ "$("$HOME/.bun/bin/bun" --version)" != "$version" ]; then
    curl -fsSL https://bun.sh/install | bash -s "bun-v${version}"
  fi
  actual="$("$HOME/.bun/bin/bun" --version)"
  if [ "$actual" != "$version" ]; then
    echo "Bun installation mismatch: expected $version, actual $actual" >&2
    exit 1
  fi
  grep -q ".bun/bin" "$HOME/.bashrc" || echo "export PATH=\"$HOME/.bun/bin:\$PATH\"" >> "$HOME/.bashrc"
' bash "${APP_DIR}"

echo "==> external pull runner and units (timer activation is an operator step)"
install -m 755 "${APP_DIR}/deploy/beacon-deploy.sh" /usr/local/bin/beacon-deploy
install -m 644 "${APP_DIR}/deploy/beacon-deploy.service" /etc/systemd/system/beacon-deploy.service
install -m 644 "${APP_DIR}/deploy/beacon-deploy.timer" /etc/systemd/system/beacon-deploy.timer

echo "==> systemd unit + Caddyfile from the repo"
install -m 644 "${APP_DIR}/deploy/beacon.service" /etc/systemd/system/beacon.service
install -m 644 "${APP_DIR}/deploy/Caddyfile" /etc/caddy/Caddyfile
echo "==> root-owned integrity baseline, checker and automatic timer"
install -d -o root -g root -m 700 /etc/beacon-integrity /var/cache/beacon-integrity
install -o root -g root -m 755 "${APP_DIR}/deploy/beacon-integrity.sh" /usr/local/sbin/beacon-integrity
install -o root -g root -m 600 "${APP_DIR}/deploy/integrity-allowlist" /etc/beacon-integrity/allowlist
install -o root -g root -m 600 "${APP_DIR}/deploy/Caddyfile" /etc/beacon-integrity/Caddyfile
for unit in beacon-integrity.service beacon-integrity.timer; do
  install -o root -g root -m 644 "${APP_DIR}/deploy/$unit" "/etc/systemd/system/$unit"
done
sudo -u "${APP_USER}" -H bash -c 'mkdir -p "$HOME/.local/state/beacon-deploy"; touch "$HOME/.local/state/beacon-deploy/lock"'
systemctl daemon-reload
systemctl enable caddy
systemctl enable --now beacon-integrity.timer

echo
echo "Provisioning done. REMAINING (deliberate) steps — see docs/DEPLOYMENT.md:"
echo "  1. Create /home/${APP_USER}/.env.production (chmod 600) with real secrets:"
echo "     DATABASE_URL, ADMIN_TOKEN, SHORT_DOMAIN (see docs/DEPLOYMENT.md)."
echo "  2. Confirm the host in /etc/caddy/Caddyfile, then: systemctl reload caddy"
echo "  3. sudo -u ${APP_USER} -H bash -lc 'cd ${APP_DIR} && ~/.bun/bin/bun install --frozen-lockfile --production --ignore-scripts'"
echo "  4. sudo -u ${APP_USER} -H bash -lc 'cd ${APP_DIR} && set -a; . ~/.env.production; set +a; ~/.bun/bin/bun run migrate'"
echo "  5. systemctl enable --now beacon && curl -sf http://localhost:8080/health"

if [ ! -s /etc/beacon-integrity/alert.env ]; then
  echo "  ALERTS REQUIRED: install root:root 0600 /etc/beacon-integrity/alert.env"
  echo "  with RESEND_API_KEY, ALERT_FROM and ALERT_TO (docs/OPERATIONS.md)."
  echo "  Failures cannot email Paul until this is configured."
fi

echo "  6. Seed release at the serving SHA, verify it exists, then explicitly enable beacon-deploy.timer."

if ! tailscale status --json | jq -e '.BackendState == "Running" and (.Self.Online == true)' >/dev/null; then
  echo "Tailscale is not enrolled/running. Public SSH access is unchanged." >&2
  echo "Run: sudo tailscale up --hostname=beacon-prod" >&2
  echo "Approve tag:beacon, verify a fresh paul SSH session and sudo over Tailscale, then rerun this script." >&2
  exit 1
fi

install -d -m 755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
# Sorts before 50-cloud-init.conf: sshd keeps the first value it reads.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
MaxAuthTries 3
X11Forwarding no
EOF
sshd -t
systemctl reload ssh

ufw default deny incoming
ufw default allow outgoing
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow in on tailscale0
ufw --force enable
# Numbered status includes saved rules only after ufw is enabled. Delete descending
# so IPv4/IPv6 indices stay valid; preserve rules restricted to tailscale0.
public_ssh_rules="$(ufw status numbered | sed -nE '/^\[ *[0-9]+\] +(22(\/tcp)?|OpenSSH)( +|$)/ { /tailscale0/! s/^\[ *([0-9]+)\].*/\1/p; }' | sort -rn)"
while read -r rule; do
  [ -z "$rule" ] || ufw --force delete "$rule"
done <<< "$public_ssh_rules"

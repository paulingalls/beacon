#!/usr/bin/env bash
#
# One-shot provisioning for a fresh Ubuntu 24.04 droplet, run as root:
#
#   ssh -i ~/.ssh/<key> root@<DROPLET_IP> 'bash -s' < scripts/provision-droplet.sh
#
# Idempotent: safe to re-run. Does NOT disable root SSH or touch the firewall —
# those are done deliberately, AFTER you've verified non-root access, to avoid a
# lockout. See docs/DEPLOYMENT.md.
set -euo pipefail

APP_USER=beacon
APP_DIR="/home/${APP_USER}/app"
# SSH remote — the repo is private, so the droplet authenticates with a read-only
# GitHub deploy key generated below (registered once via `gh repo deploy-key add`).
REPO="git@github.com:paulingalls/beacon.git"
# Branch to clone for the initial checkout. Steady-state deploys track main (the
# CI bootstrap ~/deploy.sh below resets to origin/main); override only to bring a
# droplet up from another branch before the code has merged, e.g.
# DEPLOY_BRANCH=some-branch ... bash -s < scripts/provision-droplet.sh
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

echo "==> apt deps (unzip BEFORE bun, curl, git, caddy prereqs)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y unzip curl git debian-keyring debian-archive-keyring apt-transport-https

echo "==> Caddy (official apt repo)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> app user '${APP_USER}' (no password; unattended sudo for deploy)"
if ! id "${APP_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${APP_USER}"
fi
# Write atomically at mode 0440 so the file is never momentarily world-readable
# (a plain `> file; chmod` leaves a 0644 window). Content is a non-secret sudoers
# rule, but atomic install is free and correct.
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${APP_USER}" \
  | install -m 440 /dev/stdin "/etc/sudoers.d/${APP_USER}"

echo "==> copy the deploy SSH key from root to ${APP_USER}"
install -d -m 700 -o "${APP_USER}" -g "${APP_USER}" "/home/${APP_USER}/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  install -m 600 -o "${APP_USER}" -g "${APP_USER}" \
    /root/.ssh/authorized_keys "/home/${APP_USER}/.ssh/authorized_keys"
fi

echo "==> Bun (as ${APP_USER})"
sudo -u "${APP_USER}" -H bash -lc '
  set -e
  if [ ! -x "$HOME/.bun/bin/bun" ]; then curl -fsSL https://bun.sh/install | bash; fi
  grep -q ".bun/bin" "$HOME/.bashrc" || echo "export PATH=\"$HOME/.bun/bin:\$PATH\"" >> "$HOME/.bashrc"
'

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
  else cd '${APP_DIR}' && git fetch --all --prune && git reset --hard 'origin/${DEPLOY_BRANCH}'; fi
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

echo "==> install the deploy bootstrap (~/deploy.sh) for the CI SSH action"
cat > "/home/${APP_USER}/deploy.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${APP_DIR}"
git fetch --all --prune
git reset --hard origin/main
exec bash scripts/deploy.sh
EOF
chown "${APP_USER}:${APP_USER}" "/home/${APP_USER}/deploy.sh"
chmod 750 "/home/${APP_USER}/deploy.sh"

echo "==> systemd unit + Caddyfile from the repo"
install -m 644 "${APP_DIR}/deploy/beacon.service" /etc/systemd/system/beacon.service
install -m 644 "${APP_DIR}/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable caddy

echo
echo "Provisioning done. REMAINING (deliberate) steps — see docs/DEPLOYMENT.md:"
echo "  1. Create /home/${APP_USER}/.env.production (chmod 600) with real secrets:"
echo "     DATABASE_URL, ADMIN_TOKEN, SHORT_DOMAIN (see docs/DEPLOYMENT.md)."
echo "  2. Confirm the host in /etc/caddy/Caddyfile, then: systemctl reload caddy"
echo "  3. sudo -u ${APP_USER} -H bash -lc 'cd ${APP_DIR} && ~/.bun/bin/bun install --frozen-lockfile --production --ignore-scripts'"
echo "  4. sudo -u ${APP_USER} -H bash -lc 'cd ${APP_DIR} && set -a; . ~/.env.production; set +a; ~/.bun/bin/bun run migrate'"
echo "  5. systemctl enable --now beacon && curl -sf http://localhost:8080/health"
echo "  6. ONLY after verifying 'ssh ${APP_USER}@<ip>' works in a SEPARATE session:"
echo "     disable root SSH (PermitRootLogin no) and reload sshd."

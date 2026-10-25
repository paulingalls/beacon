# Beacon Operations Runbook

Day-2 operations for the live Beacon deployment — what to run when something
gets weird. For first-time setup see [`DEPLOYMENT.md`](./DEPLOYMENT.md); for the
branch/release model see [`BRANCH_PROTECTION.md`](./BRANCH_PROTECTION.md).

**Live:** `https://beacon.vodshorter.com` → DigitalOcean droplet `beacon`
(`165.232.141.200`, sfo3). Bun server under systemd on `:8080`, behind Caddy
(auto-TLS). Postgres is the managed `beacon_prod` database on the `simplyhuman-db`
cluster, reached over the VPC private network.

---

## Shell in

Use your workstation-only maintenance key with OpenSSH over the tailnet:

```bash
ssh beacon            # configure this alias as paul@beacon-prod over Tailscale
sudo -n true
```

Root SSH and public TCP 22 are disabled after cut-over. `beacon-prod` has
`tag:beacon`; Paul's ACL allows autogroup:admin TCP 22. UFW allows incoming
`tailscale0`, 80 and 443. DO `beacon-fw` also closes public 22. Keep the DO
console as break-glass; verify a fresh paul tailnet SSH/sudo session before access
changes. For a rebuilt host run `sudo tailscale up --hostname=beacon-prod`,
approve its tag and verify access before the provisioner's enrolled rerun:
use the root-bundle delivery and execution sequence below.

The app lives in `/home/beacon/app`; secrets are `/home/beacon/.env.production` (chmod 600).
The droplet's `/home/beacon/.ssh/github_deploy` is a separate read-only GitHub key.

---

## Health & status

```bash
# From anywhere — public health (DB-free; should stay 200 even during a DB outage):
curl https://beacon.vodshorter.com/health            # => {"status":"ok","commit":"<boot SHA>"}

# On the droplet:
systemctl is-active beacon                            # => active
sudo systemctl status beacon --no-pager               # full unit status
curl -sf http://localhost:8080/health                 # local probe (bypasses Caddy)
```

## Monitoring

Vodshorter's external monitor probes `https://beacon.vodshorter.com/health` every
15 minutes and emails Paul after two consecutive failures (incident `beacon-down`).
It has been live since 2026-10-25 ~06:25Z in vodshorter v0.2.5. This is an external
contract: keep `/health` unauthenticated, DB-free, HTTP 200 with
`{"status":"ok","commit":...}` over HTTPS, with **no redirect**; redirects fail the probe.

## Logs

```bash
sudo journalctl -u beacon -f                          # app logs (follow)
sudo journalctl -u beacon -n 200 --no-pager           # last 200 lines
sudo journalctl -u caddy  -f                           # proxy / TLS logs
sudo journalctl -u beacon --since "10 min ago" --no-pager
```

## Service control

```bash
sudo systemctl restart beacon                         # restart the app (drains via SIGTERM)
sudo systemctl reload caddy                            # re-read /etc/caddy/Caddyfile
sudo systemctl restart caddy                           # full Caddy restart
```

---

## Deploys

A merge to `main` runs full CI, publishes its gated SHA to `release`, then waits
up to five minutes for public health.commit. The minute `beacon-deploy.timer`
fetches main/release under flock, verifies both ancestry checks, resets and runs
`scripts/deploy.sh`. No inbound GitHub SSH is involved. Failed-run email from
the workflow's commit poll is the alarm; a healthy older process still fails it.

```bash
gh run list --workflow=deploy.yml --limit 3
gh run watch <run-id>
journalctl -u beacon-deploy --since today
systemctl list-timers beacon-deploy.timer
```

Pause before maintenance, retry, rollback or replacing the installed runner/units:

```bash
sudo systemctl stop beacon-deploy.timer
systemctl status beacon-deploy.service   # wait until no deploy is running
# After the operation and health.commit verification:
sudo systemctl start beacon-deploy.timer
```

Stopping the timer does not cancel an active deploy. Disabling the GitHub
workflow does not stop a release already published. Never unlink the live lock
at `/home/beacon/.local/state/beacon-deploy/lock`. `last-failed` in that directory suppresses
retries of the same SHA; a newer release supersedes it. A skip exits 0, so the
next tick clears failed unit status; the marker and journal remain evidence.

`scripts/deploy.sh` rolls back code only. Exit `1` means rollback healthy; `2`
means rollback unhealthy; `3` restores HEAD before restart on runtime pin,
install or migration failure. Migrations are additive and never reverted.
For runtime repair, read the pin from the fetched release, as beacon, while paused:

```bash
sudo -u beacon -H bash <<'APP'
cd /home/beacon/app
set -eo pipefail
git fetch origin '+refs/heads/release:refs/remotes/origin/release'
curl -fsSL https://bun.sh/install | bash -s "bun-v$(git show origin/release:.bun-version)"
~/.bun/bin/bun --version
APP
```

After fixing the cause, retry through the runner (not the restored old checkout):

```bash
sudo -u beacon rm /home/beacon/.local/state/beacon-deploy/last-failed
sudo systemctl start beacon-deploy.service
curl -fsS https://beacon.vodshorter.com/health  # verify expected commit
sudo systemctl start beacon-deploy.timer
```

Manual rollback with timer paused and service idle:

```bash
sudo -u beacon -H bash <<'APP'
set -e
cd /home/beacon/app
git fetch origin '+refs/heads/release:refs/remotes/origin/release'
mkdir -p ~/.local/state/beacon-deploy
git rev-parse origin/release > ~/.local/state/beacon-deploy/last-failed
git reset --hard <good-sha>
bash scripts/deploy.sh
APP
curl -fsS https://beacon.vodshorter.com/health  # verify good-sha, not just status
# Resume deliberately once healthy:
sudo systemctl start beacon-deploy.timer
```

Do not force release backwards. After this manual reset, deploy.sh's `HEAD@{1}`
rollback target is the bad SHA. If the rollback deploy itself fails health,
deploy.sh restores that bad release: inspect health.commit before resuming.

A timeout, reboot or kill can leave HEAD equal to release while the old process
still serves. Ticks then skip and the workflow poll fails. Inspect the journal,
run `sudo -u beacon -H bash -lc 'cd /home/beacon/app && bash scripts/deploy.sh'` deliberately while paused, and verify
health.commit. Canceling GitHub does not stop an on-droplet deploy.

The runner and units live outside the checkout. After changing them, pause and
wait for idle, reinstall from the intended reviewed source with the commands in
DEPLOYMENT.md and run `sudo systemctl daemon-reload` before resuming.

---

## Integrity checks and alerts

`beacon-integrity.timer` is enabled by provisioning: Monday 12:00 UTC and ten
minutes after boot, with missed calendar runs persisted. It runs as root, using
`/usr/local/sbin/beacon-integrity`, `/etc/beacon-integrity/{allowlist,Caddyfile}`
and `/var/cache/beacon-integrity`. The app cannot rewrite this baseline.

The lead installs a sending-only Resend key, verified sender and Paul's recipient
in `/etc/beacon-integrity/alert.env`, owned root:root, mode 0600 (directory 0700):

```bash
sudo test -e /etc/beacon-integrity/alert.env || sudo install -o root -g root -m 600 /dev/null /etc/beacon-integrity/alert.env
sudoedit /etc/beacon-integrity/alert.env
# Shell assignments; quote addresses containing spaces or angle brackets:
# RESEND_API_KEY=...
# ALERT_FROM='Beacon <verified-sender@example.com>'
# ALERT_TO=paul@example.com
sudo systemctl start beacon-integrity.service
sudo journalctl -u beacon-integrity -n 100 --no-pager
systemctl list-timers beacon-integrity.timer
```

Provisioning preserves this file on rerun. Without valid settings, failures
cannot notify Paul. A failed run sends one email with host, UTC time and named
failures. `Alert accepted: <id>` means Resend accepted the request; verify actual
receipt during installation. `Alert delivery FAILED` requires checking the key,
verified sender, recipient, provider status and outbound HTTPS immediately.
A malformed baseline or a service timeout also attempts an alert. Power loss,
SIGKILL and an unreadable alert config cannot deliver one.

Triage the failed name before changing the baseline:

- **Packages / Config**: a packaged file outside `/etc` or the reviewed Caddyfile
  differs; main sudoers drift also fails. Other `/etc` differences are informational.
- **Keys / Accounts / Sudoers**: inspect both authorized key files for every
  account, including nologin ones, uid-zero/login-shell accounts, and every
  sudoers.d file. Both `sudo` and `admin` groups must have no supplementary or primary-GID members (an absent admin group is fine). "sshd key sources differ" means `sudo sshd -T` reports an
  AuthorizedKeysFile/Command, TrustedUserCAKeys or principals setting other than
  the defaults: look for a new file in `/etc/ssh/sshd_config.d/`. Beacon can only
  restart `beacon` or `beacon.service`; paul has full sudo.
- **SUID/SGID / Units / Loader**: investigate setuid/setgid files that are unowned
  or missing from the allowlist's exact `suid` list (dpkg does not verify modes; an
  upgrade that adds one needs a reviewed list update), unknown local unit
  targets/drop-ins or `/etc/ld.so.preload`. Package ownership resolves
  usrmerge aliases; exact local unit exceptions live in the reviewed allowlist.
  Generated dangling dependencies require an exact path/target pair. Runtime
  scopes group existing processes and are excluded from the file check.
- **Processes**: a daemon may still run a deleted binary after an upgrade.
  Confirm the upgrade and restart that daemon, then rerun the check.
- **Checkout**: compare the served files with GitHub's authoritative `release`
  tree. Root fetches the explicit repository into the root-owned bare mirror at
  `/var/cache/beacon-integrity/mirror.git`, ignoring inherited Git configuration
  and app SSH config. It uses the read-only `/home/beacon/.ssh/github_deploy` key
  and root-owned `/etc/beacon-integrity/known_hosts`, with strict checking and no
  global fallback. A fresh temporary index compares tracked files without reading
  the app repository's config, index, refs or objects, and names each changed
  tracked path; do not trust `git status` in the app for triage. Only Bun's install directories
  (`/node_modules/`, `/apps/*/node_modules/`, `/packages/*/node_modules/`) are excluded
  from untracked inventory; a `node_modules` anywhere else is reported; ignored paths such as `.env.local`
  are reported. Inspect each reported path before removing or restoring it.
  Transport failures also fail Checkout and alert. The deploy lock covers the
  fetch and comparison; the check never resets or cleans the app.
- **Bun**: compare the pin/installed runtime with the official Linux release.
  The root cache keys binary digests by version and asset, after verifying the zip.

For deliberate key rotation, preserve a working paul session, install the new
key, prove a fresh login/sudo session, then remove the revoked key. Commit the
new SHA256 fingerprint in `deploy/integrity-allowlist`; root/beacon expect no keys.
Reruns seed paul only when his authorized_keys is empty and root's is nonempty.

To update installed integrity artifacts, pause pulls and wait for idle, review
the checkout, then run from the workstation:

```bash
ssh beacon 'sudo systemctl stop beacon-deploy.timer; systemctl status beacon-deploy.service'
# Wait for idle. On the operator workstation:
set -euo pipefail
git fetch origin main
git -c tar.umask=0022 archive origin/main scripts deploy | ssh beacon \
  'sudo rm -rf /root/beacon-provision && sudo install -d -o root -g root -m 0700 /root/beacon-provision && sudo tar -x -C /root/beacon-provision'
# Execute only after successful delivery:
ssh beacon 'sudo bash /root/beacon-provision/scripts/provision-droplet.sh'
ssh beacon 'sudo systemctl start beacon-integrity.service'
```

Inspect all eleven verdicts and service exit status before resuming pulls. The
rerun also reapplies Caddyfile and access policy; keep DO console access and
verify a fresh paul session before lockdown.

GitHub host-key changes require an operator review of `https://api.github.com/meta`
SSH keys against GitHub's published SSH key fingerprints, then a commit to
`deploy/github_known_hosts` and delivery/install from the root bundle. Never
accept a replacement from the app's known_hosts or disable strict checking.
Reruns preserve the CA and alert.env.

### Host patching and validation

The script preserves Ubuntu security update origins, adds Caddy
`cloudsmith/caddy/stable` and `Tailscale` origins, and configures required reboots
at 10:00 UTC with the system timezone UTC. Before enabling the pull timer, validate
`systemd-analyze verify` on installed units, `sshd -t` and `sshd -T`,
`apt-cache policy caddy tailscale`, `unattended-upgrade --dry-run --debug`,
`timedatectl` and `ufw status verbose`. Reruns preserve pull timer state and enable the integrity timer.

### Reinstalling root assets

Runner, unit and baseline reinstalls use only `/root/beacon-provision/deploy`
(delivered per DEPLOYMENT.md §3), never the app checkout. For a selective reinstall after delivering the reviewed root bundle, while paused:

```bash
sudo install -o root -g root -m 0755 /root/beacon-provision/deploy/beacon-deploy.sh /usr/local/bin/beacon-deploy
for unit in beacon.service beacon-deploy.service beacon-deploy.timer beacon-integrity.service beacon-integrity.timer; do
  sudo install -o root -g root -m 0644 "/root/beacon-provision/deploy/$unit" "/etc/systemd/system/$unit"
done
sudo install -o root -g root -m 0755 /root/beacon-provision/deploy/beacon-integrity.sh /usr/local/sbin/beacon-integrity
sudo install -o root -g root -m 0600 /root/beacon-provision/deploy/integrity-allowlist /etc/beacon-integrity/allowlist
sudo install -o root -g root -m 0600 /root/beacon-provision/deploy/github_known_hosts /etc/beacon-integrity/known_hosts
sudo install -o root -g root -m 0600 /root/beacon-provision/deploy/Caddyfile /etc/beacon-integrity/Caddyfile
sudo install -o root -g root -m 0644 /root/beacon-provision/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl reload caddy
```

## Database CA install and rotation

`DATABASE_CA_CERT=/etc/beacon/db-ca.crt` is required for the managed deployment;
local plaintext databases leave it unset. A bad explicit path
or PEM fails before opening Postgres, naming the variable. Handshake failures
remain certificate/hostname errors, including in the migration CLI.

Install: before a host first runs 0.2.15 or later, install the managed cluster CA
and env line. Older code ignores the variable. From the workstation:

```bash
doctl --context default databases get-ca 9785744c-ed60-4075-9a2f-9d65247982ab --no-header > /tmp/beacon-db-ca.crt
openssl x509 -in /tmp/beacon-db-ca.crt -noout -subject -dates
ssh beacon 'sudo install -d -o root -g root -m 0755 /etc/beacon && sudo tee /etc/beacon/db-ca.crt.next >/dev/null && sudo chown root:root /etc/beacon/db-ca.crt.next && sudo chmod 0644 /etc/beacon/db-ca.crt.next && sudo mv /etc/beacon/db-ca.crt.next /etc/beacon/db-ca.crt' < /tmp/beacon-db-ca.crt
```

Add `DATABASE_CA_CERT=/etc/beacon/db-ca.crt` to `/home/beacon/.env.production`.
Before release, on the droplet substitute the private host and port from
DATABASE_URL (do not print its credentials):

```bash
openssl s_client -starttls postgres -connect <host>:<port> -servername <host> \
  -CAfile /etc/beacon/db-ca.crt -verify_hostname <host> -verify_return_error </dev/null
```

Require `Verify return code: 0 (ok)`; resolve a SAN mismatch before releasing.
After release, confirm migration success in the deploy journal and authenticated
`/analytics/schema` HTTP 200. Then deliver `origin/main`'s root bundle and rerun
provisioning (DEPLOYMENT.md §3) to install the new checker and GitHub host pins. Run
`sudo /usr/local/sbin/beacon-integrity` and inspect all eleven PASS verdicts with
the CA installed; a regular `/etc/beacon/db-ca.crt` needs no integrity allowlist
entry. Check public HTTPS `/health` with redirects disabled: HTTP 200, status ok,
and the expected boot commit.

Rotate: fetch the replacement CA using the same cluster UUID and `--context default`,
inspect its subject, dates and provider provenance, then stage it beside the
existing file as root:root 0644. Use the documented `openssl s_client` command
with `-CAfile /etc/beacon/db-ca.crt.next` and the DATABASE_URL private hostname;
require verification code 0 before atomically replacing the file on the same filesystem:

```bash
sudo mv /etc/beacon/db-ca.crt.next /etc/beacon/db-ca.crt
```

Keep a valid overlap PEM bundle when the provider requires both old and new CAs during
rotation. CA contents are read when each client is created: pause pulls, wait
for idle, restart Beacon or deploy, verify the migration journal and authenticated
schema response, then resume pulls. Never disable verification to recover;
restore a valid CA bundle. After cut-over run the installed integrity checker
and inspect all eleven PASS verdicts with the CA present.

## When things get weird

### `/health` fails / 502 from Caddy
- `systemctl is-active beacon` — if not active: `sudo journalctl -u beacon -n 100`.
- Common cause: a bad deploy. Check `sudo -u beacon -H git -C /home/beacon/app log -1` and roll back (above).
- Caddy up but app down → 502s; the app restarting for a few seconds is normal
  during a deploy.

### Database connection errors (`CONNECTION_DESTROYED`, timeouts)
The managed DB is firewalled to **trusted sources** and the `beacon` user needs
schema rights. If the droplet was rebuilt or the cluster changed:

```bash
# 1. Is the droplet a trusted source on the cluster?
doctl databases firewalls list <cluster-id>
doctl databases firewalls append <cluster-id> --rule droplet:<droplet-id>

# 2. Can the droplet reach the DB over the VPC?
ssh beacon "timeout 5 bash -c 'cat </dev/null >/dev/tcp/<private-db-host>/25060' && echo OK || echo BLOCKED"

# 3. Schema privileges (PG15+ has no default CREATE) — run as the cluster admin:
#    GRANT ALL ON SCHEMA public TO beacon;  (see DEPLOYMENT.md §1b)
```
`/health` stays green during a DB outage by design — only ingest/query degrade.

### Migrations didn't apply
```bash
ssh beacon
sudo -u beacon -H bash -lc 'cd /home/beacon/app && set -a; . ~/.env.production; set +a; ~/.bun/bin/bun --no-env-file run apps/server/src/storage/migrate.ts'
```
Idempotent + advisory-locked; safe to re-run. `permission denied for schema
public` ⇒ the GRANT in DEPLOYMENT.md §1b was never applied.

### TLS / certificate problems
- `sudo journalctl -u caddy -f` and look for ACME errors.
- Caddy needs the hostname's DNS A record pointing at the droplet **before** it
  can issue a cert. After a fresh provision, `sudo systemctl reload caddy` (the
  provision script installs the Caddyfile but doesn't reload the running Caddy).
- Changing the hostname: edit `/etc/caddy/Caddyfile`, update DNS, `reload caddy`.

### Rotate `ADMIN_TOKEN`
```bash
ssh beacon
# edit ADMIN_TOKEN in /home/beacon/.env.production, then:
sudo systemctl restart beacon
```

### Rotate `TRUSTED_INGEST_TOKEN`

The shared secret a trusted s2s caller (e.g. the VodShorter relay) presents to assert
per-event `user_id`/`context` on the ingest boundary (M2). Rotate it on both ends:

```bash
NEW=$(openssl rand -hex 32)
ssh beacon
# set TRUSTED_INGEST_TOKEN=$NEW in /home/beacon/.env.production, then:
sudo systemctl restart beacon
# then roll the same value on the trusted caller's config.
```

Rotation is fail-safe, not an outage: while the two ends disagree, Beacon simply
ignores the body-asserted `user_id`/`context` and falls back to the anonymous path
(fail-closed) — no events are lost. Roll the caller promptly to restore trusted asserts.

---

## Quick reference

| Thing | Value |
|---|---|
| URL | https://beacon.vodshorter.com |
| Droplet | `beacon`, `165.232.141.200`, sfo3 |
| App dir | `/home/beacon/app` (user `beacon`) |
| Env file | `/home/beacon/.env.production` (DATABASE_URL, DATABASE_CA_CERT, ADMIN_TOKEN, TRUSTED_INGEST_TOKEN, SHORT_DOMAIN) |
| Port | `8080` (behind Caddy) |
| DB | `beacon_prod` on `simplyhuman-db` (VPC private host, `sslmode=require`) |
| Autodeploy | merge to `main` → `.github/workflows/deploy.yml` |

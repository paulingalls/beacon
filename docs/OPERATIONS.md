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
ssh beacon            # configure this alias as beacon@beacon-prod over Tailscale
sudo -n true
```

Root SSH and public TCP 22 are disabled after cut-over. `beacon-prod` has
`tag:beacon`; Paul's ACL allows autogroup:admin TCP 22. UFW allows incoming
`tailscale0`, 80 and 443. DO `beacon-fw` also closes public 22. Keep the DO
console as break-glass; verify a second tailnet SSH/sudo session before access
changes. For a rebuilt host run `sudo tailscale up --hostname=beacon-prod`,
approve its tag and verify access before the provisioner's enrolled rerun:
`ssh beacon 'sudo bash -s' < scripts/provision-droplet.sh`.

The app lives in `~/app`; secrets are `~/.env.production` (chmod 600).
The droplet's `~/.ssh/github_deploy` is a separate read-only GitHub key.

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
at `~/.local/state/beacon-deploy/lock`. `last-failed` in that directory suppresses
retries of the same SHA; a newer release supersedes it. A skip exits 0, so the
next tick clears failed unit status; the marker and journal remain evidence.

`scripts/deploy.sh` rolls back code only. Exit `1` means rollback healthy; `2`
means rollback unhealthy; `3` restores HEAD before restart on runtime pin,
install or migration failure. Migrations are additive and never reverted.
For runtime repair, read the pin from the fetched release, as beacon, while paused:

```bash
cd ~/app
set -o pipefail
git fetch origin '+refs/heads/release:refs/remotes/origin/release'
curl -fsSL https://bun.sh/install | bash -s "bun-v$(git show origin/release:.bun-version)"
~/.bun/bin/bun --version
```

After fixing the cause, retry through the runner (not the restored old checkout):

```bash
rm ~/.local/state/beacon-deploy/last-failed
sudo systemctl start beacon-deploy.service
curl -fsS https://beacon.vodshorter.com/health  # verify expected commit
sudo systemctl start beacon-deploy.timer
```

Manual rollback, as beacon with timer paused and service idle:

```bash
cd ~/app
git fetch origin '+refs/heads/release:refs/remotes/origin/release'
mkdir -p ~/.local/state/beacon-deploy
git rev-parse origin/release > ~/.local/state/beacon-deploy/last-failed
git reset --hard <good-sha>
bash scripts/deploy.sh
curl -fsS https://beacon.vodshorter.com/health  # verify good-sha, not just status
# Resume deliberately once healthy:
sudo systemctl start beacon-deploy.timer
```

Do not force release backwards. After this manual reset, deploy.sh's `HEAD@{1}`
rollback target is the bad SHA. If the rollback deploy itself fails health,
deploy.sh restores that bad release: inspect health.commit before resuming.

A timeout, reboot or kill can leave HEAD equal to release while the old process
still serves. Ticks then skip and the workflow poll fails. Inspect the journal,
run `cd ~/app && bash scripts/deploy.sh` deliberately while paused, and verify
health.commit. Canceling GitHub does not stop an on-droplet deploy.

The runner and units live outside the checkout. After changing them, pause and
wait for idle, reinstall from the intended reviewed source with the commands in
DEPLOYMENT.md and run `sudo systemctl daemon-reload` before resuming.

---

## When things get weird

### `/health` fails / 502 from Caddy
- `systemctl is-active beacon` — if not active: `sudo journalctl -u beacon -n 100`.
- Common cause: a bad deploy. Check `git -C ~/app log -1` and roll back (above).
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
cd ~/app && set -a; . ~/.env.production; set +a; ~/.bun/bin/bun run migrate
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
# edit ADMIN_TOKEN in ~/.env.production, then:
sudo systemctl restart beacon
```

### Rotate `TRUSTED_INGEST_TOKEN`

The shared secret a trusted s2s caller (e.g. the VodShorter relay) presents to assert
per-event `user_id`/`context` on the ingest boundary (M2). Rotate it on both ends:

```bash
NEW=$(openssl rand -hex 32)
ssh beacon
# set TRUSTED_INGEST_TOKEN=$NEW in ~/.env.production, then:
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
| App dir | `~/app` (user `beacon`) |
| Env file | `~/.env.production` (DATABASE_URL, ADMIN_TOKEN, TRUSTED_INGEST_TOKEN, SHORT_DOMAIN) |
| Port | `8080` (behind Caddy) |
| DB | `beacon_prod` on `simplyhuman-db` (VPC private host, `sslmode=require`) |
| Autodeploy | merge to `main` → `.github/workflows/deploy.yml` |

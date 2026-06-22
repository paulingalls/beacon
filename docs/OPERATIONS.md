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

Root SSH is disabled. Connect as the `beacon` user (passwordless sudo):

```bash
ssh beacon            # uses ~/.ssh/config alias → beacon@165.232.141.200
# or explicitly:
ssh -i ~/.ssh/beacon_deploy beacon@165.232.141.200
```

The app lives in `~/app`; runtime secrets are in `~/.env.production` (chmod 600).

> `~/.ssh/beacon_deploy` is also the GitHub `SSH_PRIVATE_KEY` deploy secret — it
> has no passphrase, so guard it. The droplet-local `~/.ssh/github_deploy` key is
> the read-only key the droplet uses to pull the repo, not for interactive login.

---

## Health & status

```bash
# From anywhere — public health (DB-free; should stay 200 even during a DB outage):
curl https://beacon.vodshorter.com/health            # => {"status":"ok"}

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

Deploys are **automatic on merge to `main`** — `.github/workflows/deploy.yml`
re-runs the full CI suite as a gate, then SSHes in and runs `~/deploy.sh`
(fast-forward `~/app` to `origin/main` → `scripts/deploy.sh`: install → migrate →
restart → health-check → rollback on failure). `develop` is the integration
branch; a `develop`→`main` PR is a release.

```bash
# Watch the latest deploy:
gh run list --workflow=deploy.yml --limit 3
gh run watch <run-id>

# Deploy manually from the droplet (same path CI uses):
ssh beacon 'bash ~/deploy.sh'

# Pause / resume autodeploy (e.g. during maintenance):
gh workflow disable deploy.yml
gh workflow enable  deploy.yml
```

**Rollback:** `scripts/deploy.sh` auto-rolls back **code only** if the new commit
fails its health check (resets to the prior commit, reinstalls, re-checks). Exit
codes: `0` healthy, `1` rolled back and healthy (investigate the bad commit), `2`
rollback also unhealthy — **manual intervention** (see below). Migrations are
forward-only and are NOT reverted, so a breaking migration can't be auto-recovered.

Manual rollback to a known-good commit:

```bash
ssh beacon
cd ~/app
git log --oneline -n 5
git reset --hard <good-sha>
~/.bun/bin/bun install --frozen-lockfile --production --ignore-scripts
sudo systemctl restart beacon
curl -sf http://localhost:8080/health
```

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

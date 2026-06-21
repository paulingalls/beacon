# Deploying Beacon to a DigitalOcean Droplet

This runbook takes the Beacon host app (`apps/server`) from the repository to a
running production deployment on a **DigitalOcean droplet** behind **Caddy**
(automatic TLS), backed by a **DigitalOcean Managed Postgres** database — serving
every Beacon surface: event ingest, the query API, the admin dashboard, the URL
shortener, and a DB-free `/health` probe.

The deploy is modeled on the sibling `vodshorter` project. A docs-sync guard
(`test/acceptance/docs/deployment-runbook.test.ts`) asserts this file keeps
naming the load-bearing artifacts, env vars, and steps below, so it can't
silently drift from how Beacon actually deploys.

> **Status — proven live (free-2026-06-21-live-do-deploy).** Beacon runs at
> `https://beacon.vodshorter.com` on a dedicated droplet, with autodeploy on
> merge to `main`. The interim hostname is a subdomain of `vodshorter.com`
> (Beacon's first integration target); swap it for a dedicated short domain by
> editing `deploy/Caddyfile` + DNS, or serve both.

---

## Architecture

- **One droplet** (`s-1vcpu-1gb`, region `sfo3`, in the same VPC as the DB) runs
  the Bun server as a non-root `beacon` user under **systemd**
  ([`deploy/beacon.service`](../deploy/beacon.service), `PORT=8080`, drains on
  SIGTERM via `beacon.shutdown()`).
- **Caddy** ([`deploy/Caddyfile`](../deploy/Caddyfile)) terminates TLS (auto
  Let's Encrypt) and reverse-proxies `localhost:8080`.
- **Managed Postgres** — a `beacon_prod` database + `beacon` user on the shared
  cluster, reached over the **VPC private network** (`sslmode=require`).
- **Deploy** is git-pull based: [`scripts/deploy.sh`](../scripts/deploy.sh) runs
  on the droplet — install → **migrate** → restart → health-check → rollback.
  Beacon does **not** migrate on server startup (keeps `/health` DB-free), so
  migrations run in `deploy.sh` before the restart.

`/health` never touches Postgres, so a database outage degrades the app without
failing the health check and cycling the service.

---

## Prerequisites

- [`doctl`](https://docs.digitalocean.com/reference/doctl/) and `gh`, both
  authenticated (`doctl auth init`, `gh auth login`).
- A managed Postgres cluster (Beacon reuses the existing one) and a domain you
  control on DigitalOcean DNS for the hostname.
- An SSH keypair for the droplet (its public half uploaded to DO, its private
  half stored as the `SSH_PRIVATE_KEY` GitHub secret for autodeploy).

---

## 1. Create the database + user

On the managed cluster (`<cluster-id>`), create a dedicated database and user:

```bash
doctl databases db create   <cluster-id> beacon_prod
doctl databases user create <cluster-id> beacon   # note the generated password
```

The `DATABASE_URL` uses the cluster's **private** host (VPC), the `beacon` user,
the `beacon_prod` database, and `sslmode=require`:

```
postgres://beacon:<password>@private-<cluster-host>:25060/beacon_prod?sslmode=require
```

### 1a. Allow the droplet through the DB firewall (trusted sources)

The managed DB's firewall lists **trusted sources**; a new droplet is blocked
(TCP to `:25060` times out) until you add it — do this after the droplet exists
(step 2):

```bash
doctl databases firewalls append <cluster-id> --rule droplet:<droplet-id>
```

### 1b. Grant the `beacon` user schema privileges

PostgreSQL 15+ no longer grants `CREATE` on schema `public` to normal users, so
migrations fail with `permission denied for schema public` until you grant it.
Connect **as the admin user** (`doadmin`) to `beacon_prod` and run:

```sql
GRANT ALL ON SCHEMA public TO beacon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO beacon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO beacon;
```

---

## 2. Create the droplet + DNS

```bash
doctl compute droplet create beacon \
  --region sfo3 --size s-1vcpu-1gb --image ubuntu-24-04-x64 \
  --vpc-uuid <vpc-uuid> --ssh-keys <ssh-key-fingerprint> \
  --enable-monitoring --wait
```

Add the DNS A record **before** Caddy starts (so the ACME challenge resolves):

```bash
doctl compute domain records create vodshorter.com \
  --record-type A --record-name beacon --record-data <droplet-public-ip>
```

---

## 3. Provision the droplet

[`scripts/provision-droplet.sh`](../scripts/provision-droplet.sh) is idempotent
and run as root. It installs Caddy + Bun, creates the `beacon` user, generates a
read-only GitHub deploy key, clones the repo, and installs the systemd unit +
Caddyfile:

```bash
ssh -i ~/.ssh/<key> root@<droplet-ip> 'bash -s' < scripts/provision-droplet.sh
```

The first run fails at `git clone` and prints the droplet's deploy public key —
register it, then re-run:

```bash
gh repo deploy-key add <key.pub> --repo paulingalls/beacon --title beacon-droplet
ssh -i ~/.ssh/<key> root@<droplet-ip> 'bash -s' < scripts/provision-droplet.sh
```

> To bring a droplet up from a branch before it has merged to `main`, set
> `DEPLOY_BRANCH=<branch>` in the SSH command. Steady-state deploys track `main`.

---

## 4. Configure secrets + start

Create `/home/beacon/.env.production` (chmod 600, owned by `beacon`) — **never
committed**; `.env.*` is gitignored and this lives outside the repo:

```bash
DATABASE_URL=postgres://beacon:<password>@private-<cluster-host>:25060/beacon_prod?sslmode=require
ADMIN_TOKEN=<openssl rand -hex 32>
TRUSTED_INGEST_TOKEN=<openssl rand -hex 32>
SHORT_DOMAIN=https://beacon.vodshorter.com
```

Then reload Caddy (provision installs the Caddyfile but does not reload the
running Caddy), install, migrate, and start:

```bash
systemctl reload caddy        # picks up deploy/Caddyfile → obtains the TLS cert
sudo -u beacon -H bash -lc 'cd ~/app && ~/.bun/bin/bun install --frozen-lockfile --production --ignore-scripts'
sudo -u beacon -H bash -lc 'cd ~/app && set -a; . ~/.env.production; set +a; ~/.bun/bin/bun run migrate'
systemctl enable --now beacon
```

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Managed Postgres connection string (TLS). Host fails fast if unset. |
| `ADMIN_TOKEN` | set in prod | Bearer token gating dashboard + query API. **Unset ⇒ those surfaces fail closed (403).** |
| `TRUSTED_INGEST_TOKEN` | set for s2s | Bearer secret authorizing a trusted caller to assert per-event `user_id`/`context` in the ingest body (M2). **Unset ⇒ trusted ingest disabled (anonymous-only).** See [`OPERATIONS.md`](./OPERATIONS.md) for rotation. |
| `SHORT_DOMAIN` | no | Absolute base for generated short URLs. Without it the shortener emits relative `/CODE` redirects. |
| `PRODUCT_ID` | no | Fallback `product_id` for events whose batch omits one (default `beacon`). |
| `PRODUCT_ALLOWLIST` | no | Comma-separated allowlist of accepted `product_id`s. |
| `BASE_PATH` | no | API mount prefix (default `/analytics`). |

These map to `ServerEnv` in [`apps/server/src/server.ts`](../apps/server/src/server.ts).

Finally, after confirming `ssh beacon@<ip>` works in a separate session, disable
root SSH (`PermitRootLogin no`, reload sshd) — last, to avoid a lockout.

---

## 5. Autodeploy on merge to `main`

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) triggers on
push to `main`, re-runs the full CI suite via the reusable `ci.yml` as a hard
gate, then SSHes to the droplet and runs `~/deploy.sh` (which fast-forwards
`~/app` to `origin/main` and runs [`scripts/deploy.sh`](../scripts/deploy.sh)).
It needs two repo secrets:

```bash
gh secret set DROPLET_IP --repo paulingalls/beacon --body <droplet-ip>
gh secret set SSH_PRIVATE_KEY --repo paulingalls/beacon < ~/.ssh/<deploy-key>
```

`main` is releases-only; integration happens on `develop` (see
[`BRANCH_PROTECTION.md`](./BRANCH_PROTECTION.md)). A `develop`→`main` PR is a
release. `scripts/deploy.sh` rolls back to the previous commit (code only) if the
new commit fails its health check.

---

## 6. Smoke checks

```bash
# Health probe — DB-free, must return {"status":"ok"} even during a DB outage.
curl https://beacon.vodshorter.com/health

# URL shortener — a known code answers with a 302 redirect to its destination.
curl -i https://beacon.vodshorter.com/<code>            # => HTTP/2 302 ; location: <destination>

# Ingest accepts SDK batches; 202 + product_id_used confirms the write path.
curl -X POST https://beacon.vodshorter.com/analytics/events \
  -H 'content-type: application/json' \
  -d '{"product_id":"beacon","events":[{"event_type":"smoke","properties":{}}]}'

# Admin surface fails closed without the bearer token.
curl -i https://beacon.vodshorter.com/analytics/dashboard  # => 403
# (supply Authorization: Bearer $ADMIN_TOKEN to reach it)
```

---

## Operations

```bash
sudo journalctl -u beacon -f     # app logs
sudo journalctl -u caddy -f      # proxy / TLS logs
sudo systemctl restart beacon    # manual restart
gh workflow disable deploy.yml   # pause autodeploy during maintenance
```

## Related

- [`deploy/beacon.service`](../deploy/beacon.service) — systemd unit.
- [`deploy/Caddyfile`](../deploy/Caddyfile) — reverse proxy / TLS.
- [`scripts/provision-droplet.sh`](../scripts/provision-droplet.sh) — provisioning.
- [`scripts/deploy.sh`](../scripts/deploy.sh) — on-droplet deploy + rollback.
- [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) — autodeploy.
- [`BRANCH_PROTECTION.md`](./BRANCH_PROTECTION.md) — develop/main split.

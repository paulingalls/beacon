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
| `DATABASE_URL` | yes | Postgres connection string; use TLS for managed Postgres. Host fails fast if unset. |
| `PORT` | no | HTTP port (default `8080`); also used by the container HEALTHCHECK. |
| `RETENTION_DAYS` | optional | Unset or 0 = disabled. Positive finite decimal days enable pruning; invalid or unrepresentable cutoff values fail startup before resources are created. |
| `ADMIN_TOKEN` | set in prod | Bearer token gating dashboard + query API. **Unset ⇒ those surfaces fail closed (403).** |
| `REFERRER_MODE` | unset (`raw`) | Optional `raw`, `origin`, or `origin-and-path`. Server policy for all newly stored referrers, including trusted ingest, track, and short-link clicks. Scrubbing omits invalid or non-HTTP(S) referrers and removes credentials, query, and fragment. Landing-URL attribution is unchanged. Invalid modes fail startup. |
| `IP_MODE` | unset | Optional `sha256`, `daily-salt`, or `none`; unset preserves legacy SHA-256. Invalid values fail startup. Daily salts rotate at UTC midnight, stay in memory, and differ across restarts/replicas. `none` omits stored IPs while keeping in-memory rate limits. |
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

## Grafana database reader

After migrations, an operator provisions `beacon_reader` from the repository
root with PostgreSQL 15+ `psql` (the script uses `\getenv`). The administrator
needs CREATEROLE, authority to manage this role, and ownership/grant authority on
the database, public schema and all four tables. Managed-provider administrators
may need additional owner grants. Resetting existing unsafe role attributes
requires corresponding elevated authority (for example, only a superuser can
clear SUPERUSER); a failed command requires operator resolution.

Export `ADMIN_DATABASE_URL` for that administrator's Beacon database connection
(with TLS on managed Postgres). Supply a fresh password without putting it in
shell history:

```bash
read -r -s -p 'Reader password: ' BEACON_READER_PASSWORD; echo
export BEACON_READER_PASSWORD
```

<!-- reader-provision -->
```bash
psql -X --dbname "$ADMIN_DATABASE_URL" --set=ON_ERROR_STOP=1 --file scripts/create-reader-role.sql
```

Then `unset BEACON_READER_PASSWORD ADMIN_DATABASE_URL`. Do not enable shell
tracing or SQL echo while provisioning. Configure Grafana's PostgreSQL data source
with the Beacon database/host, TLS, username `beacon_reader`, and the supplied
password in its secret credential field. Credentials belong to the private
operator/Grafana deployment, never a published Beacon package.

The transaction can be rerun to rotate the password and reconcile direct grants.
It grants SELECT on `beacon_events`, `beacon_meta`, `beacon_short_links`, and
`beacon_erasures`, plus schema USAGE and database CONNECT/TEMPORARY. It grants
no future tables. The reader cannot INSERT/UPDATE/DELETE these tables, ALTER/DROP them, or
CREATE permanent tables or schemas. Session-local temporary tables are allowed; database-wide PUBLIC TEMPORARY privileges are preserved.
Existing role membership or ownership, unsafe PUBLIC CREATE/write grants, and
CREATE access to additional permanent schemas cause a loud failure. Resolve those
privileges deliberately before retrying; the script does not change shared PUBLIC
policy.

## Self-contained container deployment

Run these commands from the repository root with Docker Engine/Compose available.
Acquire the Bun, Postgres and Caddy images before isolating Beacon. Choose unique
resource names, an absolute CONFIG_DIR outside the repo, and fresh secrets; the
example uses shell variables so multiple installations can coexist.

```bash
IMAGE=beacon:local
NETWORK=beacon-private
PG=beacon-postgres
VOLUME=beacon-postgres-data
SERVER=beacon-server
CADDY=beacon-caddy
PUBLIC_NETWORK=beacon-public
CONFIG_DIR="$HOME/beacon-config"
DATABASE_NAME=beacon
PG_PASSWORD=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 32)
TRUSTED_INGEST_TOKEN=$(openssl rand -hex 32)
PORT=8080
HTTP_PORT=80
HTTPS_PORT=443
BIND_IP=0.0.0.0
SITE=analytics.example.com
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
docker pull postgres:16-alpine
docker pull caddy:2-alpine
```

<!-- container-build -->
```bash
docker build -t "$IMAGE" .
```

<!-- container-network -->
```bash
docker network create --internal "$NETWORK"
docker volume create "$VOLUME"
docker network create "$PUBLIC_NETWORK"
```

<!-- container-postgres -->
```bash
docker run -d --name "$PG" --network "$NETWORK" -e POSTGRES_USER=beacon -e POSTGRES_DB="$DATABASE_NAME" -e POSTGRES_PASSWORD="$PG_PASSWORD" -v "$VOLUME:/var/lib/postgresql/data" postgres:16-alpine
```

Wait for `docker exec "$PG" pg_isready -h 127.0.0.1 -U beacon -d beacon` to succeed.
The strict server outbound profile permits only Postgres, not DNS. Derive its
private numeric address from the exact Docker network; use this DATABASE_URL
unchanged for migration, ordinary launch and traced acceptance.

<!-- container-address -->
```bash
PG_IP=$(docker inspect --format "{{with index .NetworkSettings.Networks \"$NETWORK\"}}{{.IPAddress}}{{end}}" "$PG")
test -n "$PG_IP"
DATABASE_URL="postgres://beacon:$PG_PASSWORD@$PG_IP:5432/$DATABASE_NAME"
```

Re-resolve the address after Postgres container recreation; rewrite the env file
and restart Beacon with the updated DATABASE_URL. A hostname-only launch is not
claimed to pass this strict profile. The env table above applies to both paths.
Local Postgres here is private; managed Postgres still requires TLS.

<!-- container-env -->
```bash
umask 077
cat > "$CONFIG_DIR/beacon.env" <<EOF
DATABASE_URL=$DATABASE_URL
ADMIN_TOKEN=$ADMIN_TOKEN
TRUSTED_INGEST_TOKEN=$TRUSTED_INGEST_TOKEN
PORT=$PORT
IP_MODE=none
REFERRER_MODE=origin-and-path
RETENTION_DAYS=30
EOF
```

Run migrations before every new image launch; startup never migrates.

<!-- container-migrate -->
```bash
docker run --rm --network "$NETWORK" --env-file "$CONFIG_DIR/beacon.env" "$IMAGE" bun run migrate
```

<!-- container-launch -->
```bash
docker run -d --name "$SERVER" --network "$NETWORK" --network-alias beacon --env-file "$CONFIG_DIR/beacon.env" "$IMAGE"
```

Caddy starts on the host-published ingress bridge, then joins the private network
for its upstream. Beacon and Postgres each have only the internal network;
Beacon publishes no host port.
Beacon stays exclusively on the internal network. Configure domain DNS and expose
ports 80/443 in production (HTTP_PORT=80, HTTPS_PORT=443). For local acceptance,
SITE=http://:80, BIND_IP=127.0.0.1 and HTTP_PORT=0 use local ephemeral HTTP; that check does not prove public DNS/ACME issuance.

<!-- container-caddy-config -->
```bash
cat > "$CONFIG_DIR/Caddyfile" <<EOF
$SITE {
    reverse_proxy beacon:$PORT
}
EOF
```

<!-- container-caddy-launch -->
```bash
docker run -d --name "$CADDY" --network "$PUBLIC_NETWORK" -p "$BIND_IP:$HTTP_PORT:80" -p "$BIND_IP:$HTTPS_PORT:443" -v "$CONFIG_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine
docker network connect "$NETWORK" "$CADDY"
```

Inspect `docker inspect --format '{{.State.Health.Status}}' "$SERVER"` until
healthy. `/health` is DB-free and remains healthy during a Postgres outage.
Use the smoke checks above through Caddy with the configured host/port and tokens.
Docker stop sends SIGTERM to the exec-form Bun entry; it drains accepted buffered
events before exiting 0. Allow enough time for your database to accept the drain.

<!-- container-stop -->
```bash
docker stop --time 30 "$SERVER"
```

The container suite uses a strace sidecar with SYS_PTRACE, seccomp tracing permission
and Docker host PID visibility, attached only to the inspected Beacon PID. A
startup gate lets it attach before exec; the primary trace keeps the shipped
source, startup command, image and deployment env unchanged. The sidecar remains
alive outside Beacon's PID namespace to capture terminal exit. Missing attachment
or terminal evidence fails the suite. It observes server syscalls from before the exact
shipped startup command through workload and shutdown. It counts every TCP
connection attempt, including failed/swallowed attempts, and every outbound
datagram send attempt. Only the numeric Postgres address on TCP 5432 is allowed.
A UDP connect alone associates a local socket without sending a payload. The
observer must narrowly accept Bun's address-selection probes to `0.0.0.0:65535`,
`[::]:65535`, and `Postgres-IP:0` only on UDP sockets with no send during that
socket's lifetime. Any payload send on those sockets fails the observer. UDP,
loopback and DNS are not blanket exemptions. Unknown/incomplete observations or
missing Docker/tracing prerequisites fail loudly. This is bounded evidence for
the exercised startup/workload/shutdown, not every possible future workload.
Caddy, clients, healthcheck processes and the observer are separate from the
server traffic claim. The suite provisions one owned Postgres container per
process through the documented command; each scenario uses a separate database
and drops it in finally cleanup. Base and observer builds are shared, while
Beacon lifecycle and fault runs use fresh processes. Separate timing diagnostics shorten only the daily retention
interval or delay only periodic buffer flushing; they exercise persisted policy
and shutdown faults, and are not the primary traced run. The outage check requires
a failed DB-dependent query (server/proxy error or a bounded timeout) followed
by successful HTTP health and a fresh Docker healthcheck. The dashboard loads Chart.js from
`https://cdn.jsdelivr.net/npm/chart.js` in the browser; that existing browser-side
CDN dependency needs browser internet access and is not server outbound traffic.

## Related

- [`deploy/beacon.service`](../deploy/beacon.service) — systemd unit.
- [`deploy/Caddyfile`](../deploy/Caddyfile) — reverse proxy / TLS.
- [`scripts/provision-droplet.sh`](../scripts/provision-droplet.sh) — provisioning.
- [`scripts/deploy.sh`](../scripts/deploy.sh) — on-droplet deploy + rollback.
- [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) — autodeploy.
- [`BRANCH_PROTECTION.md`](./BRANCH_PROTECTION.md) — develop/main split.

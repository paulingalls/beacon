# Deploying Beacon to DigitalOcean App Platform

This runbook takes the Beacon host app (`apps/server`) from the repository to a
running deployment on **DigitalOcean App Platform** with a **Managed Postgres**
database, serving every Beacon surface: event ingest, the query API, the admin
dashboard, and the URL shortener.

It is the deploy procedure for the spec committed at [`.do/app.yaml`](../.do/app.yaml).
Every command and field below is kept in sync with that spec by an automated
docs-sync check (`test/acceptance/docs/deployment-runbook.test.ts`): if the spec
gains an environment variable or job, this runbook must document it or the test
fails.

> **Status — not yet proven against a live account.** As of this writing the
> image builds and boots `/health` locally, but a full App Platform deploy
> (Managed-PG binding, the PRE_DEPLOY migrate job, production env/auth wiring)
> has not been exercised end-to-end against a real DigitalOcean account
> (tracked as an open risk). Treat this as the intended, spec-validated
> procedure — verify each step the first time you run it for real.

---

## What gets deployed

The spec describes a single application with three parts:

- **One Dockerfile-backed web service** (`name: web`). DigitalOcean buildpacks
  don't ship Bun, so the image is built from [`Dockerfile`](../Dockerfile)
  (`oven/bun`) and runs `apps/server/src/server.ts` directly. This one service
  hosts every surface — `/analytics/*` (ingest + query API + dashboard), the
  shortener at the root (`GET /:code`), and a DB-free `/health` probe.
- **One Managed Postgres database** (`name: beacon-db`, engine `PG`, version
  `16`, `production: true`). PG 16 matches `docker-compose.yml` and CI
  (`postgres:16-alpine`), so the deployed engine equals what the tests exercise.
- **A PRE_DEPLOY `migrate` job** that runs the schema migrations before every
  deploy of the web service.

The web service `health_check` points at `/health`, which never touches
Postgres — so a database outage degrades the app without failing the health
check and cycling the instance.

---

## Prerequisites

- The [`doctl`](https://docs.digitalocean.com/reference/doctl/) CLI, installed
  and authenticated (`doctl auth init`).
- This GitHub repository connected to your DigitalOcean team (App Platform reads
  the `github.repo` named in `.do/app.yaml`, `paulingalls/beacon`, branch
  `main`).
- Bun locally, to run migrations or smoke checks by hand if needed.

---

## 1. Create the app from the spec

```bash
doctl apps create --spec .do/app.yaml
```

This provisions the web service, the `beacon-db` Managed Postgres, and the
`migrate` job in one call. Note the returned **app ID** — you'll use it for
manual deploys and updates. List apps any time with `doctl apps list`.

## 2. Set the ADMIN_TOKEN secret

`ADMIN_TOKEN` is declared in the spec as `type: SECRET` with **no value
committed** — you must set it at or after creation, via the DigitalOcean
dashboard (App → Settings → `web` → Environment Variables) or
`doctl apps update <app-id> --spec <spec-with-value>`.

`ADMIN_TOKEN` gates the admin dashboard and the query API. **If it is unset, the
host fails closed** — the dashboard and query endpoints return `403`, rather than
being exposed. The presented `Authorization: Bearer <token>` is compared against
it in constant time (see `apps/server/src/server.ts`).

## 3. Managed Postgres

The web service and the migrate job both receive the database connection via the
DigitalOcean-injected binding:

```yaml
- key: DATABASE_URL
  value: ${beacon-db.DATABASE_URL}
```

No connection string is committed; DigitalOcean substitutes the managed
database's TLS connection string at deploy time. `DATABASE_URL` is the one
required variable — the host fails fast on boot if it is missing.

## 4. Migrations (PRE_DEPLOY job)

The `migrate` job runs `bun run migrate` (which executes
`packages/beacon/src/storage/migrate.ts`) against `DATABASE_URL` **before** each
deploy of the web service. The migration runner is idempotent and
advisory-locked: it applies only unapplied SQL files and is safe to run on every
deploy, including the first. No manual migration step is required — but you can
run it by hand against any database with:

```bash
DATABASE_URL=postgres://... bun run migrate
```

## 5. Deploys are manual (deploy_on_push: false)

The spec sets `deploy_on_push: false` deliberately. `main`'s branch protection
uses `enforce_admins=false` (see [`BRANCH_PROTECTION.md`](./BRANCH_PROTECTION.md)),
so an admin close-flow merge can land on `main` with red CI. Auto-deploy would
ship that straight to production. Instead, trigger a deploy explicitly once you
have confirmed CI is green on the commit you want to ship:

```bash
doctl apps create-deployment <app-id>
```

Flip `deploy_on_push` to `true` only once admin merges are gated too (the
`gh pr merge` follow-up — tracked as an open debt).

---

## Environment variables

Set on the `web` service. `DATABASE_URL` is injected by the Managed PG binding;
`ADMIN_TOKEN` is a secret; the rest have safe defaults.

| Variable | Required | Source | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | `${beacon-db.DATABASE_URL}` | Managed Postgres connection string (TLS). Host fails fast if unset. |
| `ADMIN_TOKEN` | no (set in prod) | `SECRET` | Bearer token gating dashboard + query API. **Unset ⇒ those surfaces fail closed (403).** |
| `PRODUCT_ID` | no | spec value `beacon` | Fallback `product_id` for events whose batch omits one. |
| `SHORT_DOMAIN` | no | operator-set | Absolute base for generated short URLs (e.g. `https://pi.ink`). Without it, the shortener emits relative `/CODE` redirects. |
| `PRODUCT_ALLOWLIST` | no | operator-set | Comma-separated allowlist of accepted `product_id`s (`PRODUCT_ID` must be in it). |
| `BASE_PATH` | no | operator-set | API mount prefix (default `/analytics`). |

These map directly to `ServerEnv` in `apps/server/src/server.ts`.

---

## 6. Smoke checks

After a deploy completes, verify the surfaces (substitute your app's domain):

```bash
# Health probe — DB-free, must return {"status":"ok"} even during a DB outage.
curl https://<your-app>.ondigitalocean.app/health

# URL shortener — a known code should answer with a 302 redirect to its destination.
curl -I https://<your-app>.ondigitalocean.app/<code>
# => HTTP/2 302 ; location: <destination>

# Admin surface fails closed without the bearer token.
curl -i https://<your-app>.ondigitalocean.app/analytics/dashboard
# => 403 (supply Authorization: Bearer $ADMIN_TOKEN to reach it)
```

Ingest accepts SDK batches at `POST /analytics/events`; a `202` with a
`product_id_used` body confirms the write path.

---

## Related

- [`.do/app.yaml`](../.do/app.yaml) — the App Platform spec this runbook deploys.
- [`Dockerfile`](../Dockerfile) — the `oven/bun` image App Platform builds.
- [`BRANCH_PROTECTION.md`](./BRANCH_PROTECTION.md) — why deploys are manual.
- [`../README.md`](../README.md) — integration guide and the host-app template.

# Sprint 25 retrospective

Independent review found a valid JavaScript cutoff that PostgreSQL could not
represent and a redundant privilege revoke. Both were fixed and verified before
landing. The existing boundary and independent-challenge rules remain sufficient.

Executing the container runbook exposed Docker DNS traffic and an internal-network
host-publication assumption. Numeric private Postgres addressing and Caddy attached
first to an ingress bridge made the documented and tested launch agree. Fault
injection checks failed connection attempts as well as successful traffic.

Repeated container provisioning added avoidable churn. The container suite now
shares one owned Postgres with isolated scenario databases and checks cleanup after
success and failure. Fresh Beacon processes preserve lifecycle and fault isolation.
Nine completed worktrees also left database containers behind. Replace the worktree
teardown value of “none needed” with `docker compose down`; preserve volumes and
leave the active root database and unrelated projects alone.

Parallel destructive suites collided on one database; sequential reruns passed.
Replace the root-test convention with an explicit requirement to run destructive
suites sequentially per database or allocate a distinct database for each process.
No new constraint or deferred debt is needed.

Final verification exposed stale startup signaling and truncated rewritten bind-mounted
fault inputs. Container-local startup signaling and immutable diagnostic files now
replace those reused inputs; the complete container checks passed before landing.

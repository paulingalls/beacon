# Branch protection — `main`

`main` is protected so a red CI run cannot merge. Branch protection lives in GitHub repo
settings (not in the tree), so this file is the in-repo record of the policy and how to
re-apply it. Set in sprint-012 / story-005 (adopted retro Try).

## Current rule

`main` requires all four CI jobs from [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
to pass before a pull request merges:

| Setting | Value | Why |
|---|---|---|
| Required status checks | `lint`, `typecheck`, `test`, `e2e` | the four CI jobs; the contexts are the job names |
| `strict` | `true` | a PR branch must be up to date with `main` before it merges (re-run CI after `main` moves) |
| `enforce_admins` | `false` | **load-bearing** — the XP close flow merges locally and pushes directly to `main` as the repo admin; `true` would reject those pushes and break the workflow |
| Force pushes / deletions | blocked | default protection against history rewrites |

`strict` applies to PR merges, not admin direct-pushes, so it is harmless to the XP close
flow. The net effect today: the gate binds **contributor PRs** and documents the quality
bar; the admin's own integration merges still go straight to `main`.

## Re-applying the rule

```bash
gh api --method PUT repos/paulingalls/beacon/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["lint", "typecheck", "test", "e2e"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

Verify:

```bash
gh api repos/paulingalls/beacon/branches/main/protection \
  --jq '{contexts: .required_status_checks.contexts, strict: .required_status_checks.strict, enforce_admins: .enforce_admins.enabled}'
```

Or in the UI: **Settings → Branches → Branch protection rules → `main`**.

## Partially landed: `develop`/`main` release split

The **workflow-level** half of this split has landed: `develop` is the integration branch and
`main` is releases-only. `ci.yml` runs on every push except `main` (`branches-ignore: [main]`),
and [`deploy.yml`](../.github/workflows/deploy.yml) triggers on push to `main`, re-runs the full
CI suite via `uses: ./.github/workflows/ci.yml` (so the main tip keeps its own completed CI
record), then SSH-deploys to the droplet only if CI passes.

The **protection-rule** half remains deferred: `enforce_admins` is still `false` and the XP
close flow still merges locally and pushes directly to `main` as admin. Switching the close
flow to `gh pr merge` — so the required-checks gate binds the admin too — is the remaining step.
Note: when `enforce_admins` is flipped to `true`, the required check names must be reconciled
with the deploy-time reusable CI call, whose checks render as `ci / lint`, `ci / typecheck`,
etc., not the bare `lint`/`typecheck`/`test`/`e2e` names listed above. Revisit when there's a
second contributor or a real release cadence.

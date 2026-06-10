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

## Deferred: `develop`/`main` release split

A future evolution (tracked as SMM debt) is to introduce a `develop` integration branch as
the XP primary, keep `main` for releases only, and switch the close flow to `gh pr merge`
so the required-checks gate binds the admin too (rather than being bypassed by direct
pushes). Revisit when there's a second contributor or a real release cadence — premature
while a single maintainer does every integration merge.

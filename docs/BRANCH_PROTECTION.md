# Branch protection — `main` and `develop`

`main` and `develop` are both protected so a red CI run cannot merge. Branch protection lives
in GitHub repo settings (not in the tree), so this file is the in-repo record of the policy and
how to re-apply it. `main` was set in sprint-012 / story-005 (adopted retro Try); `develop` was
added when the integration/release split landed (free-2026-06-21-live-do-deploy).

- **`develop`** — the integration branch. All work (sprint/free/story close flows) merges here.
- **`main`** — releases-only. A `develop`→`main` PR is a release; merging it triggers
  [`deploy.yml`](../.github/workflows/deploy.yml), which re-runs CI and deploys to the droplet.

## Current rule

Both branches carry the **same** rule — all four CI jobs from
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) must pass before a pull request merges:

| Setting | Value | Why |
|---|---|---|
| Required status checks | `lint`, `typecheck`, `test`, `e2e` | the four CI jobs; the contexts are the job names |
| `strict` | `true` | a PR branch must be up to date with the base before it merges (re-run CI after the base moves) |
| `enforce_admins` | `false` | **load-bearing** — the XP close flow merges locally and pushes directly to `develop` as the repo admin; `true` would reject those pushes and break the workflow |
| Force pushes / deletions | blocked | default protection against history rewrites |

`strict` applies to PR merges, not admin direct-pushes, so it is harmless to the XP close
flow. The net effect today: the gate binds **contributor PRs** and documents the quality
bar; the admin's own integration merges still go straight to `develop`.

## Re-applying the rule

Same payload for either branch — substitute `main` or `develop`:

```bash
for BRANCH in main develop; do
gh api --method PUT "repos/paulingalls/beacon/branches/$BRANCH/protection" --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["lint", "typecheck", "test", "e2e"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
done
```

Verify:

```bash
gh api repos/paulingalls/beacon/branches/develop/protection \
  --jq '{contexts: .required_status_checks.contexts, strict: .required_status_checks.strict, enforce_admins: .enforce_admins.enabled}'
```

Or in the UI: **Settings → Branches → Branch protection rules**.

## Partially landed: `develop`/`main` release split

The **workflow + branch** half of this split has landed: `develop` is the protected integration
branch and `main` is releases-only. `ci.yml` runs on every push except `main`
(`branches-ignore: [main]`), and [`deploy.yml`](../.github/workflows/deploy.yml) triggers on push
to `main`, re-runs the full CI suite via `uses: ./.github/workflows/ci.yml` (so the main tip keeps
its own completed CI record), then SSH-deploys to the droplet only if CI passes. The SMM branching
strategy is at stage 3 with `integration_branch: develop`, so the XP close flow merges to `develop`.

The **protection-rule** half remains deferred: `enforce_admins` is still `false` and the XP
close flow still merges locally and pushes directly to `main` as admin. Switching the close
flow to `gh pr merge` — so the required-checks gate binds the admin too — is the remaining step.
Note: when `enforce_admins` is flipped to `true`, the required check names must be reconciled
with the deploy-time reusable CI call, whose checks render as `ci / lint`, `ci / typecheck`,
etc., not the bare `lint`/`typecheck`/`test`/`e2e` names listed above. Revisit when there's a
second contributor or a real release cadence.

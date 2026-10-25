import { expect, test } from 'bun:test';

const env = { ...process.env };
for (const key of (await Bun.$`git rev-parse --local-env-vars`.text()).trim().split('\n'))
  Reflect.deleteProperty(env, key);
if (!Bun.which('flock')) throw new Error('Install real flock: brew install flock');
const RUNNER = new URL('../../../deploy/beacon-deploy.sh', import.meta.url).pathname;
const setup = `
set -euo pipefail
root=$(mktemp -d)
export APP_DIR="$root/app" STATE_DIR="$root/state"
first= second=
trap 'touch "$STATE_DIR/release"; wait; rm -rf "$root"' EXIT
mkdir -p "$APP_DIR/scripts" "$STATE_DIR"
git init -q --bare "$root/origin"
git init -q -b main "$APP_DIR"
cd "$APP_DIR"
git config user.email test@test
git config user.name test
git remote add origin "$root/origin"
publish() {
  printf 'git rev-parse HEAD >> "$STATE_DIR/calls"\\n%s\\n' "$1" > scripts/deploy.sh
  git add .
  git commit --allow-empty -qm release
  git push -q "$root/origin" HEAD:release \${2-HEAD:main}
  git rev-parse HEAD
}
serving=$(publish '')
target=$(publish true)
git reset -q --hard "$serving"
run() { bash "$RUNNER"; }
`;
const cases = {
  'deploys release once and skips HEAD or last-failed': `
run
test "$(git rev-parse HEAD)" = "$target"
before=$(git reflog | wc -l)
run
test "$(git reflog | wc -l)" = "$before"
git reset -q --hard "$serving"
printf '%s' "$target" > "$STATE_DIR/last-failed"
before=$(git reflog | wc -l)
run
test "$(git reflog | wc -l)" = "$before"
test "$(git rev-parse HEAD)" = "$serving"
test "$(cat "$STATE_DIR/calls")" = "$target"`,
  'records target and preserves deploy failure status after rollback': `
git reset -q --hard "$target"
failed=$(publish "git reset -q --hard $serving; exit 7")
git reset -q --hard "$serving"
status=0; run || status=$?
test "$status" = 7
test "$(git rev-parse HEAD)" = "$serving"
test "$(cat "$STATE_DIR/last-failed")" = "$failed"
test "$(cat "$STATE_DIR/calls")" = "$failed"`,
  'refuses release outside fetched main without reset or deploy': `
git reset -q --hard "$target"
rogue=$(publish 'echo rogue' '')
git reset -q --hard "$serving"
before=$(git reflog | wc -l)
status=0; run || status=$?
test "$status" = 1
test "$(git reflog | wc -l)" = "$before"
test "$(git rev-parse HEAD)" = "$serving"
test ! -e "$STATE_DIR/calls"
test "$(cat "$STATE_DIR/last-failed")" = "$rogue"`,
  'refuses a release force-moved back to an older main commit': `
run
git push -qf origin "$serving:release"
before=$(git reflog | wc -l)
status=0; run || status=$?
test "$status" = 1
test "$(git reflog | wc -l)" = "$before"
test "$(git rev-parse HEAD)" = "$target"
test "$(cat "$STATE_DIR/calls")" = "$target"
test "$(cat "$STATE_DIR/last-failed")" = "$serving"`,
  'overlapping run exits before the first is released': `
git reset -q --hard "$target"
target=$(publish 'touch "$STATE_DIR/ready"; while [ ! -f "$STATE_DIR/release" ]; do sleep 0.05; done')
git reset -q --hard "$serving"
bash "$RUNNER" & first=$!
for ((i=0; i<100; i++)); do [ ! -f "$STATE_DIR/ready" ] || break; sleep 0.01; done
test -f "$STATE_DIR/ready"
next=$(publish true)
git reset -q --hard "$target"
(run; touch "$STATE_DIR/second-done") & second=$!
for ((i=0; i<100; i++)); do [ ! -f "$STATE_DIR/second-done" ] || break; sleep 0.01; done
test -f "$STATE_DIR/second-done"
wait "$second"; second=
test "$(git rev-parse origin/release)" = "$target"
test "$(cat "$STATE_DIR/calls")" = "$target"
touch "$STATE_DIR/release"
wait "$first"; first=`,
};
for (const [name, body] of Object.entries(cases)) {
  test(name, async () => {
    const result = await Bun.$`bash -c ${setup + body}`
      .env({ ...env, RUNNER })
      .quiet()
      .nothrow();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });
}

const workflowSource = await Bun.file('.github/workflows/deploy.yml').text();
const workflow = Bun.YAML.parse(workflowSource) as {
  jobs: {
    ci: { uses: string };
    deploy: {
      needs: string;
      permissions: { contents: string };
      steps: Array<{ uses?: string; with?: { ref: string }; run?: string }>;
    };
  };
};
test('publishes the CI-gated SHA with a non-force push and full history', () => {
  expect(workflow.jobs.ci.uses).toBe('./.github/workflows/ci.yml');
  const job = workflow.jobs.deploy;
  expect(job.needs).toBe('ci');
  expect(job.permissions?.contents).toBe('write');
  expect(workflowSource).not.toMatch(/ssh-action|SSH_PRIVATE_KEY|DROPLET_IP/);
  expect(job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.ref).toBe(
    `\${{ github.sha }}`,
  );
  const publication = job.steps.find((step) => step.run?.includes('git push'))?.run ?? '';
  expect(publication).toContain('git fetch --unshallow');
  expect(publication).toContain('git push origin "$TARGET:refs/heads/release"');
  expect(publication.indexOf('--unshallow')).toBeLessThan(publication.indexOf('git push'));
  expect(publication).not.toMatch(/--force|\+/);
});
test.each([false, true])('poll requires the booted target, timeout=%s', async (timeout) => {
  const poll = workflow.jobs.deploy.steps.find((step) => step.run?.includes('curl'))?.run ?? '';
  expect(poll).toContain('SECONDS + 300');
  expect(poll).toContain('https://beacon.vodshorter.com/health');
  const fixture = `
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export TARGET=target COUNT="$root/count" TIMEOUT=${timeout ? 'yes' : 'no'}
mkdir "$root/bin"
cat > "$root/bin/curl" <<'CURL'
#!/bin/bash
n=$(cat "$COUNT" 2>/dev/null || echo 0)
echo $((n+1)) > "$COUNT"
sha=old
if [ "$TIMEOUT" = no ] && [ "$n" != 0 ]; then sha="$TARGET"; fi
printf '{"status":"ok","commit":"%s"}' "$sha"
CURL
printf '#!/bin/bash\n/bin/sleep 0.05\n' > "$root/bin/sleep"
chmod +x "$root/bin/"*
export PATH="$root/bin:$PATH"
`;
  const result = await Bun.$`bash -c ${fixture + poll.replace('SECONDS + 300', 'SECONDS + 1')}`
    .quiet()
    .nothrow();
  expect(result.exitCode, result.stderr.toString()).toBe(timeout ? 1 : 0);
});

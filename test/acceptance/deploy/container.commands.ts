import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const root = join(import.meta.dir, '../../..');
export const runbook = readFileSync(join(root, 'docs/DEPLOYMENT.md'), 'utf8');
export function block(step: string, source = runbook) {
  const matches = [
    ...source.matchAll(
      new RegExp(`<!-- container-${step} -->\\s*\x60\x60\x60bash\\n([\\s\\S]*?)\x60\x60\x60`, 'g'),
    ),
  ];
  if (matches.length !== 1)
    throw new Error(`container-${step}: expected exactly one executable block`);
  return matches[0]?.[1] as string;
}
export async function command(argv: string[], env: Record<string, string> = {}, timeout = 120000) {
  const process = Bun.spawn(argv, {
    cwd: root,
    env: { ...Bun.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => process.kill(), timeout);
  try {
    const [status, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (status !== 0)
      throw new Error(`${argv[0]} ${argv[1]} failed (${status}): ${stderr || stdout}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}
export const docker = (...args: string[]) => command(['docker', ...args]);
export const requireDocker = (cli = 'docker') => command([cli, 'info']);
export async function until(label: string, check: () => Promise<boolean>, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
}

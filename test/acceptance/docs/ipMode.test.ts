import { expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
test('ipMode docs server configuration and SDK forwarding', async () => {
  const doc = await Bun.file(join(root, 'INTEGRATION.md')).text();
  expect(doc).toMatch(/\| `ipMode` \|[^\n]*sha256[^\n]*daily-salt[^\n]*none/);
  expect(doc).toContain('hashIPs: false');
  expect(doc).toContain('forwardRawIPs');
  expect(doc).toContain('double hash');
});
test('ipMode docs privacy warns about reversible pseudonyms', async () => {
  const doc = await Bun.file(join(root, 'README.md')).text();
  expect(doc).toContain('pseudonymous');
  expect(doc).toMatch(/enumerat|reversib/);
});

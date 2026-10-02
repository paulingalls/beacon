import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');
test('retention requirements §4.3 disables default and specifies event pruning contract', () => {
  const section =
    read('docs/requirements/server-and-schema.md')
      .split('### 4.3 Data Retention')[1]
      ?.split('\n## ')[0] ?? '';
  expect(section).not.toMatch(/retentionDays[^\n]*365/);
  expect(section).toMatch(/unset|omitted/i);
  expect(section).toMatch(/0[^\n]*no pruning|0[^\n]*disabled/i);
  for (const term of [
    'timestamp',
    'strictly before',
    '10,000',
    'beacon_meta',
    'beacon_short_links',
    'beacon_erasures',
    'unref',
    'shutdown',
    'non-overlap',
  ])
    expect(section).toContain(term);
  expect(section).toContain('86400000');
});
test('retention requirements §10 declares both options with disabled default and bounds', () => {
  const section =
    read('docs/requirements/client-and-operations.md')
      .split('## 10. Configuration Reference')[1]
      ?.split('\n## ')[0] ?? '';
  expect(section).not.toMatch(/retentionDays[^\n]*365/);
  expect(section).toMatch(/retentionDays\?: number;[^\n]*off unless set/);
  expect(section).toMatch(/pruneInterval\?: number;[^\n]*86400000/);
  expect(section).toContain('2147483647');
  expect(section).toContain('representable Date');
});
for (const path of ['INTEGRATION.md', 'docs/DEPLOYMENT.md']) {
  test(`retention operational guidance in ${path}`, () => {
    const row =
      read(path)
        .split('\n')
        .find((line) => line.includes('| `RETENTION_DAYS` |')) ?? '';
    expect(row).toMatch(/unset.*disabled/i);
    expect(row).toMatch(/0.*disabled/i);
    expect(row).toMatch(/invalid.*startup/i);
    expect(row).not.toContain('365');
  });
}

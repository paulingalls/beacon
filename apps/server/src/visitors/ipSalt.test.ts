import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { createIpPolicy } from './ipSalt';

const ip = '198.51.100.9';
const hmac = (salt: Buffer) => createHmac('sha256', salt).update(ip).digest('hex');
function clock() {
  let time = Date.parse('2026-10-02T23:59:59.999Z');
  let callback = () => {};
  let delay = 0;
  let cancelled = false;
  const salts: Buffer[] = [];
  const deps = {
    now: () => time,
    salt: () => {
      const salt = Buffer.alloc(32, 65 + salts.length);
      salts.push(salt);
      return salt;
    },
    schedule: (fn: () => void, ms: number) => {
      callback = fn;
      delay = ms;
      return () => {
        cancelled = true;
      };
    },
  };
  return {
    deps,
    salts,
    tick: (ms: number) => {
      time += ms;
    },
    fire: () => callback(),
    delay: () => delay,
    cancelled: () => cancelled,
  };
}
test('ipMode midnight unlink rotates on use and discards skipped-day salt', () => {
  const c = clock();
  const policy = createIpPolicy({ ipMode: 'daily-salt' }, c.deps);
  const first = hmac(Buffer.alloc(32, 65));
  expect(policy.storage(ip)).toBe(first);
  expect(policy.storage(ip)).toBe(first);
  expect(policy.storage('203.0.113.2')).not.toBe(first);
  c.tick(1);
  expect(policy.storage(ip)).toBe(hmac(Buffer.alloc(32, 66)));
  expect(c.salts[0]).toEqual(Buffer.alloc(32));
  c.tick(3 * 86400000);
  expect(policy.storage(ip)).toBe(hmac(Buffer.alloc(32, 67)));
  expect(c.salts).toHaveLength(3);
  policy.stop();
});
test('ipMode idle rotation and shutdown cleanup', () => {
  const c = clock();
  const policy = createIpPolicy({ ipMode: 'daily-salt' }, c.deps);
  expect(c.delay()).toBe(1);
  c.tick(1);
  c.fire();
  expect(c.salts).toHaveLength(2);
  expect(c.salts[0]).toEqual(Buffer.alloc(32));
  expect(c.delay()).toBe(86400000);
  policy.stop();
  expect(c.cancelled()).toBe(true);
  expect(c.salts[1]).toEqual(Buffer.alloc(32));
  c.tick(86400000);
  c.fire();
  expect(c.salts).toHaveLength(2);
  expect(() => policy.storage(ip)).toThrow('stopped');
});
test('ipMode defaults and none storage versus ephemeral key', () => {
  for (const hashIPs of [undefined, true, false]) {
    const policy = createIpPolicy({ hashIPs });
    expect(policy.storage(ip)).toBe(
      hashIPs === false ? ip : createHash('sha256').update(ip).digest('hex'),
    );
    expect(policy.rateKey(ip)).toBe(policy.storage(ip));
    expect(policy.storage(undefined)).toBeUndefined();
    policy.stop();
  }
  const policy = createIpPolicy({ ipMode: 'none' });
  expect(policy.storage(ip)).toBeUndefined();
  expect(policy.rateKey(ip)).toBe(ip);
  policy.stop();
});

test('ipMode production entropy joins within a day but unlinks instances, restart and midnight', () => {
  let time = Date.parse('2026-10-02T23:59:59.999Z');
  const deps = { now: () => time, schedule: () => () => {} };
  const first = createIpPolicy({ ipMode: 'daily-salt' }, deps);
  const independent = createIpPolicy({ ipMode: 'daily-salt' }, deps);
  try {
    const before = first.storage(ip);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(first.storage(ip)).toBe(before);
    expect(independent.storage(ip)).not.toBe(before);
    independent.stop();
    const restarted = createIpPolicy({ ipMode: 'daily-salt' }, deps);
    try {
      expect(restarted.storage(ip)).not.toBe(before);
    } finally {
      restarted.stop();
    }
    time += 1;
    const after = first.storage(ip);
    expect(after).not.toBe(before);
    expect(first.storage(ip)).toBe(after);
  } finally {
    first.stop();
    independent.stop();
  }
});

import { describe, expect, test } from 'bun:test';

import type { Context } from 'hono';

import { buildFilters, parseCommonParams, QueryParamError } from './params';

/**
 * Minimal Context stub exposing only `req.query(key)` from a fixed map — the
 * parser reads nothing else. Mirrors the lightweight stub style in errors.test.ts.
 */
function stubContext(params: Record<string, string>): Context {
  return {
    req: { query: (key: string) => params[key] },
  } as unknown as Context;
}

/** A fixed clock so the 30-day `after` default is deterministic. */
const FIXED_NOW = Date.parse('2026-05-30T12:00:00.000Z');
const now = () => FIXED_NOW;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe('parseCommonParams — defaults', () => {
  test('with no params: after=30d before now, before=now, others undefined', () => {
    const p = parseCommonParams(stubContext({}), now);
    expect(p.after.getTime()).toBe(FIXED_NOW - THIRTY_DAYS_MS);
    expect(p.before.getTime()).toBe(FIXED_NOW);
    expect(p.productId).toBeUndefined();
    expect(p.platform).toBeUndefined();
    expect(p.userId).toBeUndefined();
  });
});

describe('parseCommonParams — pass-through', () => {
  test('product_id and user_id pass through verbatim', () => {
    const p = parseCommonParams(stubContext({ product_id: 'clipcast', user_id: 'u_42' }), now);
    expect(p.productId).toBe('clipcast');
    expect(p.userId).toBe('u_42');
  });

  test('a valid platform passes through', () => {
    const p = parseCommonParams(stubContext({ platform: 'ios' }), now);
    expect(p.platform).toBe('ios');
  });

  test('present-but-blank product_id/user_id are treated as absent (span all)', () => {
    const p = parseCommonParams(stubContext({ product_id: '', user_id: '   ' }), now);
    expect(p.productId).toBeUndefined();
    expect(p.userId).toBeUndefined();
  });

  test('a blank platform is treated as absent rather than rejected', () => {
    const p = parseCommonParams(stubContext({ platform: '' }), now);
    expect(p.platform).toBeUndefined();
  });

  test('surrounding whitespace is trimmed from pass-through params', () => {
    const p = parseCommonParams(stubContext({ product_id: '  clipcast  ' }), now);
    expect(p.productId).toBe('clipcast');
  });

  test('valid ISO after/before are parsed', () => {
    const p = parseCommonParams(
      stubContext({ after: '2026-01-01T00:00:00Z', before: '2026-02-01T00:00:00Z' }),
      now,
    );
    expect(p.after.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(p.before.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('parseCommonParams — validation (throws QueryParamError)', () => {
  test('an unknown platform throws naming "platform"', () => {
    try {
      parseCommonParams(stubContext({ platform: 'desktop' }), now);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryParamError);
      expect((err as QueryParamError).parameter).toBe('platform');
    }
  });

  test('a non-ISO after throws naming "after"', () => {
    try {
      parseCommonParams(stubContext({ after: 'not-a-date' }), now);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryParamError);
      expect((err as QueryParamError).parameter).toBe('after');
    }
  });

  test('a non-ISO before throws naming "before"', () => {
    try {
      parseCommonParams(stubContext({ before: 'nope' }), now);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryParamError);
      expect((err as QueryParamError).parameter).toBe('before');
    }
  });

  test('a reversed range (after later than before) throws naming "after"', () => {
    try {
      parseCommonParams(
        stubContext({ after: '2026-02-01T00:00:00Z', before: '2026-01-01T00:00:00Z' }),
        now,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryParamError);
      expect((err as QueryParamError).parameter).toBe('after');
    }
  });

  test('after exactly equal to before is rejected (range must be non-empty)', () => {
    const ts = '2026-03-01T00:00:00Z';
    expect(() => parseCommonParams(stubContext({ after: ts, before: ts }), now)).toThrow(
      QueryParamError,
    );
  });
});

describe('buildFilters — §5.4 response echo (shared by aggregate/funnel/attribution)', () => {
  const after = new Date('2026-03-01T00:00:00.000Z');

  test('always echoes after as an ISO string', () => {
    expect(buildFilters({ after, before: new Date() })).toEqual({
      after: '2026-03-01T00:00:00.000Z',
    });
  });

  test('includes product_id only when a product filter was supplied', () => {
    expect(buildFilters({ after, before: new Date(), productId: 'clipcast' })).toEqual({
      product_id: 'clipcast',
      after: '2026-03-01T00:00:00.000Z',
    });
  });

  test('omits the product_id key entirely when absent (not set to undefined)', () => {
    const filters = buildFilters({ after, before: new Date() });
    expect('product_id' in filters).toBe(false);
  });
});

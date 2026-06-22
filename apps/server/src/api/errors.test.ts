import { describe, expect, test } from 'bun:test';

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { type ErrorCode, errorBody, errorResponse, errorStatus } from './errors';

describe('errorBody', () => {
  test('builds the §5.5 shape with a parameter', () => {
    expect(errorBody('INVALID_PARAMETER', "bad 'group_by'", 'group_by')).toEqual({
      error: { code: 'INVALID_PARAMETER', message: "bad 'group_by'", parameter: 'group_by' },
    });
  });

  test('omits parameter entirely when not given (no undefined key)', () => {
    const body = errorBody('INTERNAL_ERROR', 'boom');
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'boom' } });
    expect('parameter' in body.error).toBe(false);
  });
});

describe('errorStatus', () => {
  const cases: Array<[ErrorCode, ContentfulStatusCode]> = [
    ['INVALID_PARAMETER', 400],
    ['MISSING_PARAMETER', 400],
    ['RATE_LIMITED', 429],
    ['UNAUTHORIZED', 403],
    ['INTERNAL_ERROR', 500],
  ];
  for (const [code, status] of cases) {
    test(`${code} maps to ${status}`, () => {
      expect(errorStatus(code)).toBe(status);
    });
  }
});

describe('errorResponse', () => {
  /** Stub Context whose json() echoes its args, so we assert body + status without mounting. */
  function stubContext(): { c: Context; calls: Array<{ body: unknown; status: number }> } {
    const calls: Array<{ body: unknown; status: number }> = [];
    const c = {
      json: (body: unknown, status: number) => {
        calls.push({ body, status });
        return { body, status } as unknown as Response;
      },
    } as unknown as Context;
    return { c, calls };
  }

  test('responds with the §5.5 body and the code-mapped status', () => {
    const { c, calls } = stubContext();
    errorResponse(c, 'UNAUTHORIZED', 'admin only');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      body: { error: { code: 'UNAUTHORIZED', message: 'admin only' } },
      status: 403,
    });
  });

  test('passes the parameter through when given', () => {
    const { c, calls } = stubContext();
    errorResponse(c, 'INVALID_PARAMETER', 'must be a positive integer', 'limit');
    expect(calls[0]).toEqual({
      body: {
        error: {
          code: 'INVALID_PARAMETER',
          message: 'must be a positive integer',
          parameter: 'limit',
        },
      },
      status: 400,
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { QueryParamError } from '../api/params';
import { createFunnelHandler, MissingParamError, parseSteps, parseWindow } from './funnel';

interface FunnelStep {
  event_type: string;
  count: number;
  conversion_rate: number;
}

interface FunnelResponse {
  steps: FunnelStep[];
  overall_conversion: number;
  window_seconds: number;
  filters: { product_id?: string; after?: string };
}

// ── parseSteps (pure) ──────────────────────────────────────────────────────

describe('parseSteps', () => {
  test('splits and trims a comma-separated list', () => {
    expect(parseSteps('request, signup ,clip_created')).toEqual([
      'request',
      'signup',
      'clip_created',
    ]);
  });

  test('missing or blank value throws MissingParamError', () => {
    expect(() => parseSteps(undefined)).toThrow(MissingParamError);
    expect(() => parseSteps('')).toThrow(MissingParamError);
    expect(() => parseSteps('   ')).toThrow(MissingParamError);
  });

  test('fewer than 2 steps throws QueryParamError', () => {
    expect(() => parseSteps('request')).toThrow(QueryParamError);
    // A trailing comma collapses to a single real step.
    expect(() => parseSteps('request,')).toThrow(QueryParamError);
  });

  test('more than 10 steps throws QueryParamError', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `s${i}`).join(',');
    expect(() => parseSteps(eleven)).toThrow(QueryParamError);
  });

  test('accepts the 2..10 boundary counts', () => {
    expect(parseSteps('a,b')).toHaveLength(2);
    expect(parseSteps(Array.from({ length: 10 }, (_, i) => `s${i}`).join(','))).toHaveLength(10);
  });
});

// ── parseWindow (pure) ─────────────────────────────────────────────────────

describe('parseWindow', () => {
  test('defaults to 86400 when absent or blank', () => {
    expect(parseWindow(undefined)).toBe(86400);
    expect(parseWindow('  ')).toBe(86400);
  });

  test('passes through a positive integer', () => {
    expect(parseWindow('3600')).toBe(3600);
  });

  test('rejects zero, negative, and non-integer values', () => {
    expect(() => parseWindow('0')).toThrow(QueryParamError);
    expect(() => parseWindow('-1')).toThrow(QueryParamError);
    expect(() => parseWindow('1.5')).toThrow(QueryParamError);
    expect(() => parseWindow('abc')).toThrow(QueryParamError);
  });
});

// ── createFunnelHandler: param validation & error isolation (no DB) ─────────

/**
 * An `Sql` stub whose every tagged-template call resolves to the SAME rows
 * array. The handler issues one recursive-CTE query, so a single pre-resolved
 * promise reused across the discarded fragment intermediates lets the final
 * `await` see these grouped (step_idx, reached_count) rows — exercising the
 * zero-fill + response path with no database. Mirrors events.test's rejectingSql.
 */
function rowsSql(rows: Array<{ step_idx: number; reached_count: string }>): Sql {
  const resolved = Promise.resolve(rows);
  const builder = () => resolved;
  return builder as unknown as Sql;
}

/** An `Sql` stub whose query rejects, to exercise the 500 path. */
function rejectingSql(message: string): Sql {
  const rejected = Promise.reject(new Error(message));
  rejected.catch(() => {});
  const builder = () => rejected;
  return builder as unknown as Sql;
}

async function getFunnel(handler: ReturnType<typeof createFunnelHandler>, qs: string) {
  const app = new Hono();
  app.get('/funnel', handler);
  return app.request(`/funnel${qs}`);
}

describe('createFunnelHandler (validation & errors)', () => {
  test('missing steps → 400 MISSING_PARAMETER', async () => {
    const res = await getFunnel(createFunnelHandler(rowsSql([])), '');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MISSING_PARAMETER',
    );
  });

  test('fewer than 2 steps → 400 INVALID_PARAMETER', async () => {
    const res = await getFunnel(createFunnelHandler(rowsSql([])), '?steps=request');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PARAMETER',
    );
  });

  test('more than 10 steps → 400 INVALID_PARAMETER', async () => {
    const steps = Array.from({ length: 11 }, (_, i) => `s${i}`).join(',');
    const res = await getFunnel(createFunnelHandler(rowsSql([])), `?steps=${steps}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PARAMETER',
    );
  });

  test('bad window → 400 INVALID_PARAMETER', async () => {
    const res = await getFunnel(createFunnelHandler(rowsSql([])), '?steps=a,b&window=0');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PARAMETER',
    );
  });

  test('a query failure → 500 INTERNAL_ERROR', async () => {
    const res = await getFunnel(createFunnelHandler(rejectingSql('db down')), '?steps=a,b');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });

  test('shapes per-step counts and rates from grouped SQL rows, zero-filling unreached steps', async () => {
    // The CTE returns one (step_idx, reached_count) row per reached step; here
    // steps 1 and 2 were reached but step 3 was not, so it must zero-fill and
    // guard the missing step's rate. counts are 1-based step_idx, the response
    // is 0-based — exercising the byStep.get(i+1) zero-fill.
    const grouped = [
      { step_idx: 1, reached_count: '4' },
      { step_idx: 2, reached_count: '2' },
    ];
    const res = await getFunnel(
      createFunnelHandler(rowsSql(grouped)),
      '?steps=request,signup,clip_created',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as FunnelResponse;
    expect(body.steps).toEqual([
      { event_type: 'request', count: 4, conversion_rate: 1.0 },
      { event_type: 'signup', count: 2, conversion_rate: 0.5 },
      { event_type: 'clip_created', count: 0, conversion_rate: 0 },
    ]);
    expect(body.overall_conversion).toBe(0); // 0 / 4
    expect(body.window_seconds).toBe(86400);
  });

  test('an empty result set yields zero counts and guarded (0) rates', async () => {
    const res = await getFunnel(createFunnelHandler(rowsSql([])), '?steps=a,b,c&window=3600');
    const body = (await res.json()) as FunnelResponse;
    expect(body.steps.map((s) => s.count)).toEqual([0, 0, 0]);
    expect(body.steps.map((s) => s.conversion_rate)).toEqual([1.0, 0, 0]);
    expect(body.overall_conversion).toBe(0);
    expect(body.window_seconds).toBe(3600);
  });

  test('echoes applied product_id and after in filters', async () => {
    const res = await getFunnel(
      createFunnelHandler(rowsSql([])),
      '?steps=a,b&product_id=clipcast&after=2026-03-01T00:00:00Z',
    );
    const body = (await res.json()) as FunnelResponse;
    expect(body.filters.product_id).toBe('clipcast');
    expect(body.filters.after).toBe('2026-03-01T00:00:00.000Z');
  });
});

import type { BeaconConfig } from '../types';

export function validateReferrerMode(value: unknown): NonNullable<BeaconConfig['referrerMode']> {
  if (value === undefined) return 'raw';
  if (value === 'raw' || value === 'origin' || value === 'origin-and-path') return value;
  throw new Error('[beacon] invalid referrerMode');
}

export function scrubReferrerContext(
  context: Record<string, unknown>,
  mode: BeaconConfig['referrerMode'],
): Record<string, unknown> {
  if (mode === undefined || mode === 'raw') return context;
  const result = { ...context };
  delete result.referrer;
  if (typeof context.referrer !== 'string') return result;
  try {
    const url = new URL(context.referrer);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      result.referrer = mode === 'origin' ? url.origin : url.origin + url.pathname;
    }
  } catch {}
  return result;
}

import type { Attribution } from '../types';

/** UTM tags and ad-platform click IDs kept verbatim (REQUIREMENTS.md §3.1). */
const KNOWN_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'msclkid',
  'dclid',
  'ttclid',
  'li_fat_id',
] as const;

const CUSTOM_PREFIX = '_bcn_';
const KNOWN_PARAM_SET = new Set<string>(KNOWN_PARAMS);

/**
 * Extract first-touch campaign attribution from a request URL (REQUIREMENTS.md
 * §3.1): the known UTM/click-ID params plus any `_bcn_`-prefixed custom param
 * (prefix stripped in the stored key). Empty values are ignored, and the first
 * non-empty value wins when a param repeats — uniformly for known and custom
 * params. Returns null when nothing relevant is present. Malformed/relative
 * URLs never throw — the dummy base lets relative paths parse, and a parse
 * failure yields null.
 */
export function extractAttribution(url: string): Attribution | null {
  let params: URLSearchParams;
  try {
    params = new URL(url, 'http://_').searchParams;
  } catch {
    return null;
  }

  // Null-prototype accumulator so custom param names that collide with
  // Object.prototype members (constructor, toString, ...) are stored, not
  // silently dropped by an `in`/inherited-key check.
  const attribution: Attribution = Object.create(null);

  for (const [key, value] of params) {
    if (!value) continue; // ignore empty values
    let storeKey: string;
    if (KNOWN_PARAM_SET.has(key)) {
      storeKey = key;
    } else if (key.startsWith(CUSTOM_PREFIX)) {
      storeKey = key.slice(CUSTOM_PREFIX.length);
      if (!storeKey) continue; // bare `_bcn_` prefix
    } else {
      continue;
    }
    // First non-empty value wins.
    if (!Object.hasOwn(attribution, storeKey)) attribution[storeKey] = value;
  }

  return Object.keys(attribution).length > 0 ? attribution : null;
}

import { describe, expect, test } from 'bun:test';

import { extractAttribution } from './attribution';

const BASE = 'https://app.example.com/landing';

describe('extractAttribution — UTM params', () => {
  test('extracts all five UTM params, keeping their original names', () => {
    const url = `${BASE}?utm_source=newsletter&utm_medium=email&utm_campaign=spring&utm_content=hero&utm_term=running+shoes`;
    expect(extractAttribution(url)).toEqual({
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'spring',
      utm_content: 'hero',
      utm_term: 'running shoes',
    });
  });

  test('extracts only the UTM params that are present', () => {
    expect(extractAttribution(`${BASE}?utm_source=twitter`)).toEqual({ utm_source: 'twitter' });
  });
});

describe('extractAttribution — ad-platform click IDs', () => {
  test('extracts all six click IDs', () => {
    const url = `${BASE}?gclid=g1&fbclid=f2&msclkid=m3&dclid=d4&ttclid=t5&li_fat_id=l6`;
    expect(extractAttribution(url)).toEqual({
      gclid: 'g1',
      fbclid: 'f2',
      msclkid: 'm3',
      dclid: 'd4',
      ttclid: 't5',
      li_fat_id: 'l6',
    });
  });
});

describe('extractAttribution — custom _bcn_ params', () => {
  test('extracts _bcn_-prefixed params and strips the prefix in the stored key', () => {
    expect(extractAttribution(`${BASE}?_bcn_partner=acme&_bcn_tier=gold`)).toEqual({
      partner: 'acme',
      tier: 'gold',
    });
  });

  test('a bare _bcn_ prefix with no suffix is ignored', () => {
    expect(extractAttribution(`${BASE}?_bcn_=x`)).toBeNull();
  });

  test('keeps custom params named like Object.prototype members', () => {
    expect(extractAttribution(`${BASE}?_bcn_constructor=acme&_bcn_toString=t`)).toEqual({
      constructor: 'acme',
      toString: 't',
    });
  });
});

describe('extractAttribution — mixed and empty', () => {
  test('mixes UTM, click ID, and custom params in one result', () => {
    const url = `${BASE}?utm_source=ig&gclid=g1&_bcn_partner=acme&foo=bar`;
    expect(extractAttribution(url)).toEqual({
      utm_source: 'ig',
      gclid: 'g1',
      partner: 'acme',
    });
  });

  test('returns null when no relevant params are present', () => {
    expect(extractAttribution(BASE)).toBeNull();
    expect(extractAttribution(`${BASE}?foo=bar&ref=123`)).toBeNull();
  });

  test('ignores empty-valued attribution params', () => {
    expect(extractAttribution(`${BASE}?utm_source=&gclid=`)).toBeNull();
    expect(extractAttribution(`${BASE}?utm_source=&utm_medium=email`)).toEqual({
      utm_medium: 'email',
    });
  });
});

describe('extractAttribution — robustness', () => {
  test('parses a relative path with a query string', () => {
    expect(extractAttribution('/landing?utm_source=newsletter')).toEqual({
      utm_source: 'newsletter',
    });
  });

  test('returns null on malformed input without throwing', () => {
    expect(() => extractAttribution('::::not a url::::')).not.toThrow();
    expect(extractAttribution('::::not a url::::')).toBeNull();
  });

  test('takes the first value when a param repeats', () => {
    expect(extractAttribution(`${BASE}?utm_source=a&utm_source=b`)).toEqual({ utm_source: 'a' });
  });

  test('skips an empty first occurrence and takes the next non-empty repeat (known and custom alike)', () => {
    expect(extractAttribution(`${BASE}?utm_source=&utm_source=b`)).toEqual({ utm_source: 'b' });
    expect(extractAttribution(`${BASE}?_bcn_p=&_bcn_p=b`)).toEqual({ p: 'b' });
  });
});

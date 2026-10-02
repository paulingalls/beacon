import { describe, expect, test } from 'bun:test';
import { scrubReferrerContext, validateReferrerMode } from './referrer';

describe('referrerMode', () => {
  test('default and raw preserve bytes and value shape', () => {
    expect(validateReferrerMode(undefined)).toBe('raw');
    for (const referrer of ['https://SITE.example:443/a%20b?token=x#f', 'not a URL', 42]) {
      const context = { referrer, extra: 'kept' };
      expect(scrubReferrerContext(context, 'raw')).toBe(context);
    }
  });
  for (const mode of ['origin', 'origin-and-path'] as const) {
    test(`${mode} removes credentials, query and fragment`, () => {
      const context = { referrer: 'https://user:secret@site.example/a?token=x#f', extra: 1 };
      expect(scrubReferrerContext(context, mode)).toEqual({
        referrer: mode === 'origin' ? 'https://site.example' : 'https://site.example/a',
        extra: 1,
      });
      expect(context.referrer).toBe('https://user:secret@site.example/a?token=x#f');
    });
    test(`${mode} omits invalid or non-web referrers as an absent key`, () => {
      for (const referrer of [
        undefined,
        '',
        'not a URL',
        '/a',
        'mailto:a@b.com',
        'file:///a',
        42,
      ]) {
        const context = { referrer, extra: 1 };
        const result = scrubReferrerContext(context, mode);
        expect(Object.hasOwn(result, 'referrer')).toBe(false);
        expect(result.extra).toBe(1);
        expect(Object.hasOwn(context, 'referrer')).toBe(true);
      }
    });
  }
  test('rejects invalid runtime modes without exposing the value', () => {
    for (const value of ['', 'RAW', 'secret-mode', null, 42]) {
      expect(() => validateReferrerMode(value)).toThrow(new Error('[beacon] invalid referrerMode'));
    }
  });
});

import { describe, expect, test } from 'bun:test';

import { APP_CONTEXT_HEADER, type AppContext, buildAppContextHeader } from './appContext';

describe('buildAppContextHeader', () => {
  test('returns the X-App-Context header with the minimum fields', () => {
    const headers = buildAppContextHeader({ appVersion: '1.2.0', platform: 'ios' });

    expect(Object.keys(headers)).toEqual([APP_CONTEXT_HEADER]);
    const parsed = JSON.parse(headers[APP_CONTEXT_HEADER] as string);
    expect(parsed).toEqual({ appVersion: '1.2.0', platform: 'ios' });
  });

  test('includes the additional os/device/screen fields when set', () => {
    const appContext: AppContext = {
      appVersion: '1.2.0',
      platform: 'ios',
      os: 'iOS 18.2',
      device: 'iPhone 16',
      screen: '393x852',
    };

    const value = buildAppContextHeader(appContext)[APP_CONTEXT_HEADER] as string;

    // Valid, parseable JSON (the server JSON.parses this verbatim).
    expect(() => JSON.parse(value)).not.toThrow();
    expect(JSON.parse(value)).toEqual(appContext);
  });

  test('omits unset optional fields from the serialized value (no null keys)', () => {
    const value = buildAppContextHeader({ appVersion: '1.2.0', platform: 'android' })[
      APP_CONTEXT_HEADER
    ] as string;

    const parsed = JSON.parse(value);
    expect(parsed).not.toHaveProperty('os');
    expect(parsed).not.toHaveProperty('device');
    expect(parsed).not.toHaveProperty('screen');
    // No literal "null" leaks into the wire value either.
    expect(value).not.toContain('null');
  });

  test('E2E: a full mobile appContext round-trips intact through the header value', () => {
    const appContext: AppContext = {
      appVersion: '3.1.4',
      platform: 'android',
      os: 'Android 15',
      device: 'Pixel 9',
      screen: '412x915',
    };

    const headers = buildAppContextHeader(appContext);
    const roundTripped = JSON.parse(headers[APP_CONTEXT_HEADER] as string);

    expect(roundTripped).toEqual(appContext);
  });
});

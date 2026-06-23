import { describe, expect, test } from 'bun:test';

import { requestToBeaconRequest } from './beaconRequest';

// honoToBeaconRequest moved to ../hono (the ./hono subpath); its coverage now lives
// in ../hono/index.test.ts. This file covers only the hono-free Web Request adapter.

describe('requestToBeaconRequest', () => {
  test('header/query/url/path/method/json read from a plain Web Request', async () => {
    const request = new Request('https://host.example/landing?x=1&_t=v1', {
      method: 'POST',
      headers: { 'User-Agent': 'PlainAgent/2.0', 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ event_type: 'tap' }] }),
    });
    const req = requestToBeaconRequest(request);

    expect(req.header('user-agent')).toBe('PlainAgent/2.0');
    expect(req.header('X-Missing')).toBeUndefined();

    expect(req.query('_t')).toBe('v1');
    expect(req.query('x')).toBe('1');
    expect(req.query('absent')).toBeUndefined();

    expect(req.url).toBe('https://host.example/landing?x=1&_t=v1');
    expect(req.path).toBe('/landing');
    expect(req.method).toBe('POST');
    expect(await req.json()).toEqual({ events: [{ event_type: 'tap' }] });
  });

  test('json() is memoized — a second call returns the same value, not "Body already read"', async () => {
    const request = new Request('https://host.example/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ event_type: 'tap' }] }),
    });
    const req = requestToBeaconRequest(request);

    const first = await req.json();
    // A raw Request body is a one-shot stream; without memoization this throws.
    const second = await req.json();

    expect(first).toEqual({ events: [{ event_type: 'tap' }] });
    expect(second).toEqual(first);
  });

  test('clientAddress returns the injected socket address', () => {
    const req = requestToBeaconRequest(new Request('https://host.example/'), {
      clientAddress: '10.0.0.5',
    });
    expect(req.clientAddress()).toBe('10.0.0.5');
  });

  test('clientAddress is undefined when none is injected', () => {
    const req = requestToBeaconRequest(new Request('https://host.example/'));
    expect(req.clientAddress()).toBeUndefined();
  });

  test('token state threads through a closure (no Hono context bag)', () => {
    const req = requestToBeaconRequest(new Request('https://host.example/'));

    // no _t param, nothing set yet
    expect(req.getToken()).toBeNull();

    req.setToken('minted-in-closure');
    expect(req.getToken()).toBe('minted-in-closure');
  });
});

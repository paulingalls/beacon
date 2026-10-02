import { describe, expect, test } from 'bun:test';
import { allEvents, build, type RecordedCall } from '../testkit';
import { useBeaconScreenViews } from './reactNative';

function makeRenderHarness() {
  const refs: Array<{ current: unknown }> = [];
  const effects: Array<readonly unknown[] | undefined> = [];
  let refCursor = 0;
  let effectCursor = 0;
  let pending: Array<() => undefined | (() => void)> = [];
  const bindings = {
    useRef<T>(initialValue: T): { current: T } {
      const slot = refCursor++;
      if (!refs[slot]) refs[slot] = { current: initialValue };
      return refs[slot] as { current: T };
    },
    useEffect(effect: () => undefined | (() => void), deps?: readonly unknown[]): void {
      const slot = effectCursor++;
      const previous = effects[slot];
      const changed =
        !deps ||
        !previous ||
        deps.length !== previous.length ||
        deps.some((value, index) => !Object.is(value, previous[index]));
      effects[slot] = deps;
      if (changed) pending.push(effect);
    },
  };
  return {
    bindings,
    render(component: () => void) {
      refCursor = 0;
      effectCursor = 0;
      pending = [];
      component();
      for (const effect of pending) effect();
    },
  };
}

function screens(calls: RecordedCall[]) {
  return allEvents(calls).map((event) => ({
    event_type: event.event_type,
    properties: event.properties,
  }));
}

function screenEvents(...names: string[]) {
  return names.map((screen) => ({ event_type: 'screen_view', properties: { screen } }));
}

test('render harness honors dependencies and persists independent refs', () => {
  const first = makeRenderHarness();
  const second = makeRenderHarness();
  const observed: Array<{ current: number }> = [];
  let count = 0;
  for (const dependency of [1, 1, 2]) {
    first.render(() => {
      observed.push(first.bindings.useRef(0));
      first.bindings.useEffect(() => {
        count++;
        return undefined;
      }, [dependency]);
    });
    expect(count).toBe(dependency);
  }
  expect(observed[0]).toBe(observed[1]);
  expect(observed[1]).toBe(observed[2]);
  second.render(() => expect(second.bindings.useRef(0)).not.toBe(observed[0]));
});

describe('useBeaconScreenViews', () => {
  for (const freshBindings of [false, true]) {
    test(`emits a, b, a for a, a, null, b, b, a (fresh bindings: ${freshBindings})`, async () => {
      const { client, calls } = build();
      const host = makeRenderHarness();
      for (const route of ['a', 'a', null, 'b', 'b', 'a']) {
        host.render(() =>
          useBeaconScreenViews(client, route, freshBindings ? { ...host.bindings } : host.bindings),
        );
      }
      await client.flush();
      expect(screens(calls)).toEqual(screenEvents('a', 'b', 'a'));
      client.shutdown();
    });
  }

  test('emits the first non-null route once on mount', async () => {
    const { client, calls } = build();
    const host = makeRenderHarness();
    for (let render = 0; render < 3; render++) {
      host.render(() => useBeaconScreenViews(client, '/clips/[id]', { ...host.bindings }));
    }
    await client.flush();
    expect(screens(calls)).toEqual(screenEvents('/clips/[id]'));
    client.shutdown();
  });

  test('waits for a route after a null mount', async () => {
    const { client, calls } = build();
    const host = makeRenderHarness();
    host.render(() => useBeaconScreenViews(client, null, host.bindings));
    await client.flush();
    expect(calls).toEqual([]);
    host.render(() => useBeaconScreenViews(client, 'a', host.bindings));
    await client.flush();
    expect(screens(calls)).toEqual(screenEvents('a'));
    client.shutdown();
  });

  test('ignores null without resetting the last emitted route', async () => {
    const { client, calls } = build();
    const host = makeRenderHarness();
    for (const route of ['a', null, 'a']) {
      host.render(() => useBeaconScreenViews(client, route, host.bindings));
    }
    await client.flush();
    expect(screens(calls)).toEqual(screenEvents('a'));
    client.shutdown();
  });

  test('keeps independent state for two instances sharing a client', async () => {
    const { client, calls } = build();
    const hosts = [makeRenderHarness(), makeRenderHarness()];
    for (const route of ['a', 'b']) {
      for (const host of hosts) {
        host.render(() => useBeaconScreenViews(client, route, host.bindings));
      }
    }
    await client.flush();
    expect(screens(calls)).toEqual(screenEvents('a', 'a', 'b', 'b'));
    client.shutdown();
  });
});

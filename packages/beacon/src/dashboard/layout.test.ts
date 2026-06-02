import { describe, expect, test } from 'bun:test';

import { renderShell, WIDGET_CONTAINER_IDS } from './layout';

// Structural unit tests for the dashboard page shell (REQUIREMENTS.md §9). The
// shell is a pure function of { basePath } — no DB, no browser — so we assert on
// the returned HTML string. Real rendered behaviour is story-006's Playwright
// capstone; here we prove the structural contract the widget stories (002-005)
// build against.

describe('renderShell — page structure', () => {
  const html = renderShell({ basePath: '/analytics' });

  test('is a full HTML document', () => {
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  test('inlines its own CSS (no external stylesheet / build step)', () => {
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  test('loads Chart.js from CDN', () => {
    expect(html).toContain('https://cdn.jsdelivr.net/npm/chart.js');
  });

  test('has the product selector', () => {
    expect(html).toContain('id="beacon-product-select"');
  });

  test('has the four date-range presets and a custom range', () => {
    expect(html).toContain('data-range="today"');
    expect(html).toContain('data-range="7d"');
    expect(html).toContain('data-range="30d"');
    expect(html).toContain('data-range="90d"');
    expect(html).toContain('id="beacon-range-after"');
    expect(html).toContain('id="beacon-range-before"');
  });

  test('has a container div for each of the four widgets', () => {
    for (const id of Object.values(WIDGET_CONTAINER_IDS)) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test('emits exactly one widget card per container — no more, no fewer', () => {
    // Counting cards independently of WIDGET_CONTAINER_IDS catches a dropped
    // widgetCard(...) call: a missing card would otherwise pass the loop above
    // yet leave a downstream widget mounting into a never-emitted container.
    const cardCount = html.split('<section class="widget">').length - 1;
    expect(cardCount).toBe(Object.keys(WIDGET_CONTAINER_IDS).length);
  });

  test('embeds basePath so the browser can build same-origin query URLs', () => {
    expect(html).toContain('data-base-path="/analytics"');
    expect(renderShell({ basePath: '/foo' })).toContain('data-base-path="/foo"');
  });

  test('passes basePath through verbatim (trusted operator config, not escaped)', () => {
    // basePath is createBeacon config, never end-user input — it is interpolated
    // raw into data-base-path. This pins that trust assumption: a path with a
    // sub-segment lands intact, so downstream URL building stays exact. If this
    // input ever becomes untrusted, attribute-escaping must be added in renderShell.
    expect(renderShell({ basePath: '/api/v1/analytics' })).toContain(
      'data-base-path="/api/v1/analytics"',
    );
  });
});

describe('renderShell — window.Beacon bootstrap contract (002-005 consume this)', () => {
  // Structural assertions only: the inline browser script can't run in bun:test
  // without a DOM. Behavioural proof (real fetch, selector re-fetch, rendering)
  // is story-006's Playwright capstone (assumption fef7710a05c0). These pin the
  // contract surface so the widget stories build against stable symbols.
  const html = renderShell({ basePath: '/analytics' });

  test('installs the window.Beacon global with mutable state and a schema slot', () => {
    expect(html).toContain('window.Beacon');
    expect(html).toContain('state');
    expect(html).toContain('schema');
  });

  test('exposes the registration + refresh + url-building API widgets call', () => {
    expect(html).toContain('registerWidget');
    expect(html).toContain('refreshAll');
    expect(html).toContain('queryUrl');
    expect(html).toContain('eventTypeNames');
  });

  test('reads basePath from the data-base-path attribute (script carries no interpolated value)', () => {
    expect(html).toContain('dataset.basePath');
  });

  test('loads the schema endpoint to populate products and the event-type list', () => {
    expect(html).toContain('/schema');
  });

  test('queryUrl maps the shared filter state to the §5.3 common params', () => {
    expect(html).toContain('product_id');
    expect(html).toContain('after');
    expect(html).toContain('before');
  });

  test('eventTypeNames reads the per-product event_types objects, not flat names', () => {
    // GET /schema returns event_types as [{product_id, event_type, ...}] objects.
    // eventTypeNames must read the .event_type field (and dedup) rather than treat
    // the array as names — pins concern 03d0aefb1f19 for the funnel widget (005).
    expect(html).toContain('event_type');
  });

  test('isolates a failing widget so it cannot blank its siblings', () => {
    expect(html).toContain('catch');
  });

  test('custom date inputs are read as local calendar days, not UTC midnight', () => {
    // <input type=date> value is the operator's local day; new Date('YYYY-MM-DD')
    // would parse as UTC and shift by the offset. The script builds the instant
    // from split local Y/M/D parts instead.
    expect(html).toContain('localDayIso');
    expect(html).not.toContain('new Date(after.value)');
    expect(html).not.toContain('new Date(before.value)');
  });

  test("custom 'To' bound advances one day so the whole selected end day is included", () => {
    // Query filters timestamp < before (exclusive upper bound); the end bound must
    // be the start of the day AFTER the picked day or the end day (and From==To)
    // would be excluded entirely.
    expect(html).toContain('localDayIso(before.value, 1)');
  });

  test("'today' preset is local calendar-day start, not a rolling 24h window", () => {
    expect(html).toContain('startOfTodayIso');
  });

  test('surfaces a visible error when the schema load fails', () => {
    // Schema load is the bootstrap precondition for refreshAll; on failure the
    // operator must see a visible status, not four cards blank like 'no data'.
    expect(html).toContain('id="beacon-status"');
    expect(html).toContain('showStatus');
    expect(html).toContain('r.ok');
  });
});

describe('WIDGET_CONTAINER_IDS — the frozen container contract (002-005 import this)', () => {
  test('names a stable, beacon-prefixed id per widget', () => {
    expect(WIDGET_CONTAINER_IDS).toEqual({
      overview: 'beacon-widget-overview',
      topPages: 'beacon-widget-top-pages',
      attribution: 'beacon-widget-attribution',
      funnel: 'beacon-widget-funnel',
    });
  });
});

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

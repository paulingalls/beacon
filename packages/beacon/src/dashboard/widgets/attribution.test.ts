import { describe, expect, test } from 'bun:test';

import { attributionWidgetScript } from './attribution';

// Structural assertions on the Attribution widget's inline browser script (no DOM in
// bun:test; rendered behaviour is story-006's Playwright capstone). The widget renders a
// table from GET /attribution grouped by utm_source (default), with a dropdown to switch
// group_by between source / medium / campaign. Columns: Source, Clicks, Conversions,
// Conversion Rate — sorted clicks-desc by the server (the widget does not re-sort).

describe('attributionWidgetScript', () => {
  const id = 'beacon-widget-attribution';
  const script = attributionWidgetScript(id);

  test('registers a refresher with window.Beacon and targets its container', () => {
    expect(script).toContain('window.Beacon.registerWidget');
    expect(script).toContain(JSON.stringify(id));
  });

  test('fetches /attribution via Beacon.queryUrl + Beacon.getJson carrying group_by', () => {
    expect(script).toContain('Beacon.getJson');
    expect(script).toContain("'/attribution'");
    expect(script).toContain('group_by');
  });

  test('defaults group_by to utm_source', () => {
    expect(script).toContain("groupBy = 'utm_source'");
  });

  test('renders the four columns Source / Clicks / Conversions / Conversion Rate', () => {
    expect(script).toContain('Clicks');
    expect(script).toContain('Conversions');
    expect(script).toContain('Conversion Rate');
    // The first column header tracks the selected dimension's label (Source by default).
    expect(script).toContain('Source');
  });

  test('offers a group_by dropdown for source, medium, and campaign that re-fetches on change', () => {
    expect(script).toContain('utm_medium');
    expect(script).toContain('utm_campaign');
    expect(script).toContain('<select');
    expect(script).toContain("addEventListener('change'");
  });

  test('renders the conversion rate as a percentage', () => {
    expect(script).toContain('conversion_rate');
    expect(script).toContain("'%'");
  });

  test('escapes the (untrusted, event-derived) group key', () => {
    // attribution->>utm_* values come from request data, so the key must be HTML-escaped
    // before it lands in a table cell — same guard the Top Pages widget applies to paths.
    expect(script).toContain('esc(');
    expect(script).toContain('&amp;');
  });

  test('renders empty and inline-error states', () => {
    expect(script.toLowerCase()).toContain('no ');
    expect(script).toContain('catch');
  });

  test('keeps the Group by dropdown on the error path so the operator can switch to recover', () => {
    // The error branch re-renders selectMarkup() (like the empty state) and re-attaches the
    // change handler, so a failed fetch does not strand the operator without the dropdown.
    expect(script).toContain('beacon-error');
    expect(script).toContain('selectMarkup() +\n          \'<p class="beacon-error">');
  });

  test('guards renders with a load sequence token against out-of-order resolution', () => {
    // The dropdown self-triggers load() out-of-band of refreshAll, so a stale-scope fetch
    // must not stomp a newer one — each load captures a token and renders only if latest.
    expect(script).toContain('loadSeq');
    expect(script).toContain('seq !== loadSeq');
  });

  test('does not hardcode the container id (takes it as a parameter)', () => {
    expect(attributionWidgetScript('other-id')).toContain(JSON.stringify('other-id'));
    expect(attributionWidgetScript('other-id')).not.toContain('beacon-widget-attribution');
  });
});

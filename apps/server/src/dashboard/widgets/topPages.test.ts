import { describe, expect, test } from 'bun:test';

import { topPagesWidgetScript } from './topPages';

// Structural assertions on the Top Pages widget's inline browser script (no DOM in
// bun:test; rendered behaviour is story-006's Playwright capstone). The /aggregate
// group_by whitelist is dimensions+time only — it can't group by properties->>'path'
// — so this widget pulls request events from /events and tallies path views + unique
// users client-side over a bounded page set.

describe('topPagesWidgetScript', () => {
  const id = 'beacon-widget-top-pages';
  const script = topPagesWidgetScript(id);

  test('registers a refresher with window.Beacon and targets its container', () => {
    expect(script).toContain('window.Beacon.registerWidget');
    expect(script).toContain(JSON.stringify(id));
  });

  test('pulls request events from /events via Beacon.queryUrl + Beacon.getJson', () => {
    expect(script).toContain('Beacon.getJson');
    expect(script).toContain("'/events'");
    expect(script).toContain('event_type');
    expect(script).toContain("'request'");
  });

  test('bounds how many events it pulls (paginates with a cap, not unbounded)', () => {
    expect(script).toContain('cursor');
    // a cap guards against pulling the entire feed
    expect(script).toContain('rows.length < MAX_EVENTS');
    expect(script).toMatch(/MAX_EVENTS = \d+/);
  });

  test('tallies views and unique users per path from properties.path', () => {
    expect(script).toContain('properties');
    expect(script).toContain('path');
    expect(script).toContain('user_id');
    expect(script).toContain('visitor_token');
  });

  test('shows the top 20 paths sorted by views descending', () => {
    expect(script).toContain('slice(0, TOP_N)');
    expect(script).toContain('TOP_N = 20');
    expect(script).toContain('sort');
  });

  test('uses null-prototype tally maps so __proto__ keys are not dropped', () => {
    // Plain {} would route a '__proto__' path/token to the prototype setter and
    // Object.keys would omit it — Object.create(null) keeps the tally total.
    expect(script).toContain('Object.create(null)');
    expect(script).not.toContain('users: {}');
  });

  test('discloses an approximate tally when the MAX_EVENTS cap is hit', () => {
    // When pagination stops at the cap (cursor still truthy) the table reflects only
    // the most-recent N requests, not the full window — the widget must say so rather
    // than let the totals read as exact.
    expect(script).toContain('var capped = !!cursor');
    expect(script).toContain('Approximate');
  });

  test('escapes the (event-derived) path via the shared Beacon.esc helper', () => {
    // properties.path is event-derived; escaping is delegated to window.Beacon.esc
    // (defined once in layout.ts), so the widget calls it rather than redefine the map.
    expect(script).toContain('Beacon.esc(');
  });

  test('renders empty and inline-error states', () => {
    expect(script.toLowerCase()).toContain('no ');
    expect(script).toContain('catch');
  });

  test('does not hardcode the container id (takes it as a parameter)', () => {
    expect(topPagesWidgetScript('other-id')).toContain(JSON.stringify('other-id'));
    expect(topPagesWidgetScript('other-id')).not.toContain('beacon-widget-top-pages');
  });
});

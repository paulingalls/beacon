import { describe, expect, test } from 'bun:test';

import { overviewWidgetScript } from './overview';

// Structural assertions on the Overview widget's inline browser script (no DOM in
// bun:test; rendered behaviour is story-006's Playwright capstone). The script is a
// pure function of its container id, so we assert the contract surface: it registers
// with window.Beacon, builds /aggregate URLs via Beacon.queryUrl, requests the three
// metrics + the daily series, draws a Chart, and handles loading/empty/error states.

describe('overviewWidgetScript', () => {
  const id = 'beacon-widget-overview';
  const script = overviewWidgetScript(id);

  test('registers a refresher with window.Beacon and targets its container', () => {
    expect(script).toContain('window.Beacon.registerWidget');
    expect(script).toContain(JSON.stringify(id));
  });

  test('queries /aggregate via Beacon.queryUrl for the three metrics', () => {
    expect(script).toContain('Beacon.queryUrl');
    expect(script).toContain("'/aggregate'");
    expect(script).toContain('count');
    expect(script).toContain('unique_users');
    expect(script).toContain('unique_visitors');
  });

  test('requests the daily-volume series and draws a Chart', () => {
    expect(script).toContain('group_by');
    expect(script).toContain("'day'");
    expect(script).toContain('new Chart');
  });

  test('fetches via the shared Beacon.getJson contract (no per-widget fetch helper)', () => {
    expect(script).toContain('Beacon.getJson');
    // The old inline helper declared its own `var getJson = function` — gone now.
    expect(script).not.toContain('var getJson');
  });

  test('folds all four /aggregate GETs into a single Promise.all (one fetch wave)', () => {
    expect(script.match(/Promise\.all/g) ?? []).toHaveLength(1);
    expect(script.match(/await/g) ?? []).toHaveLength(1);
  });

  test('tears down the prior Chart instance on re-refresh (no canvas-reuse leak)', () => {
    expect(script).toContain('.destroy()');
  });

  test('destroys the prior Chart BEFORE any await so the error path also tears it down', () => {
    expect(script.indexOf('.destroy()')).toBeLessThan(script.indexOf('await'));
  });

  test('renders loading, empty, and inline-error states', () => {
    expect(script).toContain('Loading');
    expect(script.toLowerCase()).toContain('no data');
    expect(script).toContain('catch');
  });

  test('does not hardcode the container id (takes it as a parameter)', () => {
    expect(overviewWidgetScript('other-id')).toContain(JSON.stringify('other-id'));
    expect(overviewWidgetScript('other-id')).not.toContain('beacon-widget-overview');
  });
});

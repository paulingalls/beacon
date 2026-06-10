import { describe, expect, test } from 'bun:test';

import { funnelWidgetScript } from './funnel';

// Structural assertions on the Funnel widget's inline browser script (no DOM in bun:test;
// rendered behaviour is story-006's Playwright capstone). The widget offers 5 fixed step
// <select> slots populated from the schema event types (Beacon.eventTypeNames), defaults to
// request->signup when both exist, and renders a horizontal-bar funnel from GET /funnel with
// per-step counts, between-step drop-off %, and an overall conversion rate.

describe('funnelWidgetScript', () => {
  const id = 'beacon-widget-funnel';
  const script = funnelWidgetScript(id);

  test('registers a refresher with window.Beacon and targets its container', () => {
    expect(script).toContain('window.Beacon.registerWidget');
    expect(script).toContain(JSON.stringify(id));
  });

  test('derives the step types from the schema via Beacon.eventTypeNames', () => {
    expect(script).toContain('Beacon.eventTypeNames');
  });

  test('defaults the funnel to request -> signup when both event types exist', () => {
    expect(script).toContain('DEFAULT_STEPS');
    expect(script).toContain('request');
    expect(script).toContain('signup');
  });

  test('fetches /funnel via Beacon.queryUrl + Beacon.getJson carrying the joined steps', () => {
    expect(script).toContain('Beacon.getJson');
    expect(script).toContain("'/funnel'");
    expect(script).toContain('steps');
    expect(script).toContain('.join');
  });

  test('offers five step slots and re-fetches when a slot changes', () => {
    expect(script).toContain('MAX_STEPS = 5');
    expect(script).toContain('data-step');
    expect(script).toContain("addEventListener('change'");
  });

  test('renders horizontal bars with per-step count, drop-off %, and overall conversion', () => {
    // bar width is proportional to the step count; drop-off derives from the server's
    // step-over-step conversion_rate; the overall conversion rate is shown at the bottom.
    expect(script).toContain('width:');
    expect(script).toContain('conversion_rate');
    expect(script).toContain('overall_conversion');
    // the between-step drop-off is rendered with the ↓ glyph in its own labelled span
    expect(script).toContain('beacon-funnel-drop');
    expect(script).toContain('↓');
  });

  test('suppresses the drop-off label when the prior step had zero entities', () => {
    // A zero-count prior step makes the server guard conversion_rate to 0, which would
    // render a misleading ↓100% drop — there is nothing to drop from, so the label is gated
    // on the previous step's count.
    expect(script).toContain('prevCount');
    expect(script).toContain('prevCount === 0');
  });

  test('prompts the admin to pick at least 2 steps when fewer are selected', () => {
    // The <2-steps branch renders a prompt and skips the fetch entirely, so the widget
    // never sends a sub-2-step request that /funnel would reject with 400.
    expect(script).toContain('Select at least 2 steps');
  });

  test('drops selected steps the current product lacks (re-intersect on product switch)', () => {
    // A product switch can leave selectedSteps holding event types the new product has none
    // of; the widget intersects them with the current eventTypeNames so it never queries
    // /funnel for absent step names and the slots match state.
    expect(script).toContain('types.indexOf(s)');
    expect(script).toContain('selectedSteps.filter');
  });

  test('guards renders with a load sequence token against out-of-order resolution', () => {
    // The step slots self-trigger load() out-of-band of refreshAll, so a stale-scope fetch
    // must not stomp a newer one — each load captures a token and renders only if latest
    // (the widget-self-fetch-guard convention shared with the attribution widget).
    expect(script).toContain('loadSeq');
    expect(script).toContain('seq !== loadSeq');
  });

  test('shows an empty state (not an error) when there is no funnel data', () => {
    expect(script).toContain('beacon-empty');
    expect(script).toContain('beacon-error');
    // empty is distinct from error: an empty funnel is data, a failed fetch is an error.
    expect(script).toContain('catch');
  });

  test('escapes the (event-derived) step labels via the shared Beacon.esc helper', () => {
    // Step labels are event-derived; escaping is delegated to window.Beacon.esc
    // (defined once in layout.ts), so the widget calls it rather than redefine the map.
    expect(script).toContain('Beacon.esc(');
  });

  test('does not hardcode the container id (takes it as a parameter)', () => {
    expect(funnelWidgetScript('other-id')).toContain(JSON.stringify('other-id'));
    expect(funnelWidgetScript('other-id')).not.toContain('beacon-widget-funnel');
  });
});

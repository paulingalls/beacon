// Funnel widget (REQUIREMENTS.md §9.2, PHASE_7 §7.5): a step selector (five fixed <select>
// slots populated from the schema event types) and a visual horizontal-bar funnel from GET
// /funnel — per-step counts, between-step drop-off %, and an overall conversion rate. The
// default funnel is request -> signup when both event types exist. The browser code is a
// plain-JS string (no build step); the container id is a parameter so the module stays
// decoupled from layout.ts (the registry passes WIDGET_CONTAINER_IDS at render time, which
// also avoids a layout<->widgets import cycle).

/** Fixed number of step <select> slots — the §7.5 admin picks 2..5 ordered steps. */
const MAX_STEPS = 5;
/** The default step sequence, applied on first load when both types exist (§7.5). */
const DEFAULT_STEPS = ['request', 'signup'];

/**
 * Build the Funnel widget's inline browser script. Registers a refresher that fetches
 * /funnel (scoped to the shared product/date state via Beacon.queryUrl, fetched via
 * Beacon.getJson) for the selected ordered steps, and renders a horizontal-bar funnel.
 * Five fixed step slots are populated from Beacon.eventTypeNames(productId); changing a slot
 * re-fetches ONLY this widget (not Beacon.refreshAll). The selected steps persist across
 * refreshAll waves (module-scope), resetting on page reload. Because the slots self-trigger
 * load() out-of-band of refreshAll, renders are guarded by a monotonic load-sequence token
 * (the widget-self-fetch-guard convention shared with the attribution widget). Loading /
 * empty / inline-error states are in-widget (§7.6); an empty funnel renders as data, not an
 * error.
 */
export function funnelWidgetScript(containerId: string): string {
  const id = JSON.stringify(containerId);
  const defaults = JSON.stringify(DEFAULT_STEPS);
  return `(function () {
  var MAX_STEPS = ${MAX_STEPS};
  var DEFAULT_STEPS = ${defaults};
  // Compact ordered step list; null until the first load computes the default. Persisted
  // across refreshAll waves (like attribution's groupBy), reset on page reload.
  var selectedSteps = null;
  // Monotonic load sequence. The step slots self-trigger load() out-of-band of refreshAll,
  // so a slot-change fetch can race a refreshAll-driven load (different date/product scope) —
  // the shell's refreshAll latch (layout.ts) only coalesces its OWN waves. Each load captures
  // a token and renders only if still the latest, so an out-of-order resolution can't stomp
  // the funnel with a stale-scope response.
  var loadSeq = 0;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function pct(n) { return (Number(n) * 100).toFixed(1) + '%'; }
  function defaultSteps(types) {
    var hasAll = DEFAULT_STEPS.every(function (t) { return types.indexOf(t) !== -1; });
    return hasAll ? DEFAULT_STEPS.slice() : [];
  }

  function selectorMarkup(types) {
    var slots = '';
    for (var i = 0; i < MAX_STEPS; i++) {
      var cur = selectedSteps[i] || '';
      var opts = '<option value="">(none)</option>' + types.map(function (t) {
        var sel = t === cur ? ' selected' : '';
        return '<option value="' + esc(t) + '"' + sel + '>' + esc(t) + '</option>';
      }).join('');
      slots += '<select data-step="' + i + '" class="beacon-funnel-slot">' + opts + '</select>';
    }
    return '<div class="beacon-funnel-steps">' + slots + '</div>';
  }

  function collectSteps(el) {
    var out = [];
    el.querySelectorAll('select[data-step]').forEach(function (s) {
      if (s.value) { out.push(s.value); }
    });
    return out;
  }

  function funnelBody(data) {
    var steps = (data && data.steps) || [];
    var first = steps.length ? steps[0].count : 0;
    // No entities entered the funnel — render as an empty state, not an error (AC3).
    if (steps.length === 0 || first === 0) {
      return '<p class="beacon-empty">No funnel data for the selected steps and range.</p>';
    }
    var rows = steps.map(function (s, i) {
      var width = (s.count / first) * 100;
      // Drop-off from the previous step = 1 - this step's step-over-step conversion_rate
      // (step 1's rate is always 1.0, so it shows no drop-off). When the prior step had 0
      // entities the server guards conversion_rate to 0, which would read as a misleading
      // 100% drop — there is nothing to drop from, so suppress the label entirely.
      var prevCount = i === 0 ? 0 : steps[i - 1].count;
      var drop = i === 0 || prevCount === 0 ? '' :
        '<span class="beacon-funnel-drop">↓' + pct(1 - s.conversion_rate) + '</span>';
      return '<div class="beacon-funnel-row">' +
        '<div class="beacon-funnel-bar" style="width:' + width.toFixed(1) + '%"></div>' +
        '<span class="beacon-funnel-label">' + esc(s.event_type) + '</span>' +
        '<span class="beacon-funnel-count">' + s.count + '</span>' + drop + '</div>';
    }).join('');
    return rows +
      '<p class="beacon-funnel-overall">Overall conversion: ' + pct(data.overall_conversion) + '</p>';
  }

  function renderShell(Beacon, el, types, bodyHtml) {
    el.innerHTML = selectorMarkup(types) + '<div class="beacon-funnel-body">' + bodyHtml + '</div>';
    attachSteps(Beacon, el);
  }

  // innerHTML replaces the prior slots on every render, so re-attach the change handler each
  // time. Switching a step re-fetches ONLY this widget (load), not the whole dashboard.
  function attachSteps(Beacon, el) {
    el.querySelectorAll('select[data-step]').forEach(function (s) {
      s.addEventListener('change', function () {
        selectedSteps = collectSteps(el);
        load(Beacon, el);
      });
    });
  }

  function load(Beacon, el) {
    // Bump the token FIRST, on every call: the <2-steps early return below must also
    // invalidate any in-flight fetch, else a resolving fetch stomps the freshly-rendered
    // prompt.
    var seq = ++loadSeq;
    var types = Beacon.eventTypeNames(Beacon.state.productId);
    if (selectedSteps === null) {
      selectedSteps = defaultSteps(types);
    } else {
      // A product switch may leave selected steps the new product doesn't have. Drop them so
      // the slots (which only mark in-list options selected) match state and we never query
      // /funnel for absent step names; if that leaves < 2 the prompt below asks for a re-pick.
      selectedSteps = selectedSteps.filter(function (s) {
        return types.indexOf(s) !== -1;
      });
    }

    if (selectedSteps.length < 2) {
      renderShell(Beacon, el, types,
        '<p class="beacon-empty">Select at least 2 steps to see the funnel.</p>');
      return Promise.resolve();
    }

    renderShell(Beacon, el, types, '<p class="beacon-loading">Loading…</p>');
    return Beacon.getJson(Beacon.queryUrl('/funnel', { steps: selectedSteps.join(',') }))
      .then(function (data) {
        if (seq !== loadSeq) { return; }
        renderShell(Beacon, el, types, funnelBody(data));
      })
      .catch(function (e) {
        if (seq !== loadSeq) { return; }
        renderShell(Beacon, el, types, '<p class="beacon-error">Failed to load funnel.</p>');
        console.error('[beacon-dashboard] funnel failed', e);
      });
  }

  window.Beacon.registerWidget(function (Beacon) {
    var el = document.getElementById(${id});
    if (!el) { return; }
    return load(Beacon, el);
  });
})();`;
}

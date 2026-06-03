// Attribution widget (REQUIREMENTS.md §9.2, PHASE_7 §7.4): a table from GET /attribution
// grouped by utm_source (default) with Source / Clicks / Conversions / Conversion Rate,
// plus a dropdown to switch group_by between source, medium, and campaign. The /attribution
// handler already sorts groups clicks-desc, so the widget renders rows as received (no
// re-sort). The browser code is a plain-JS string (no build step); the container id is a
// parameter so the module stays decoupled from layout.ts (the registry passes
// WIDGET_CONTAINER_IDS at render time, which also avoids a layout<->widgets import cycle).

/**
 * The group_by dimensions the widget offers, with their column-header labels. `value` is
 * the §5.4 group_by param sent to /attribution; `label` is the first table column's header
 * (so the default utm_source reads "Source"). Restricted to the three the story exposes —
 * /attribution also accepts utm_content/utm_term/channel, but §7.4 scopes the dropdown to
 * source/medium/campaign.
 */
const GROUP_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'utm_source', label: 'Source' },
  { value: 'utm_medium', label: 'Medium' },
  { value: 'utm_campaign', label: 'Campaign' },
];

/**
 * Build the Attribution widget's inline browser script. Registers a refresher that fetches
 * /attribution (scoped to the shared product/date state via Beacon.queryUrl, fetched via
 * Beacon.getJson) for the current group_by, and renders a table sorted clicks-desc by the
 * server. A `Group by` dropdown switches the dimension and re-fetches ONLY this widget
 * (not Beacon.refreshAll) on change. The selected group_by persists across refreshAll waves
 * (module-scope), resetting to utm_source on page reload. Loading / empty / inline-error
 * states are in-widget (§7.6).
 */
export function attributionWidgetScript(containerId: string): string {
  const id = JSON.stringify(containerId);
  const options = JSON.stringify(GROUP_OPTIONS);
  return `(function () {
  var GROUP_OPTIONS = ${options};
  // Persisted across refreshAll waves (like overview's chart var); reset on page reload.
  var groupBy = 'utm_source';
  // Monotonic load sequence. The dropdown handler self-triggers load() out-of-band, so its
  // fetch can race a refreshAll-driven load (different date/product scope) — the shell's
  // refreshAll latch (layout.ts) only coalesces its OWN waves, not this widget's direct
  // load() calls. Each load captures a token and renders only if still the latest, so an
  // out-of-order resolution can't stomp the table with a stale-scope response.
  var loadSeq = 0;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function pct(n) { return (Number(n) * 100).toFixed(1) + '%'; }
  function currentLabel() {
    for (var i = 0; i < GROUP_OPTIONS.length; i++) {
      if (GROUP_OPTIONS[i].value === groupBy) { return GROUP_OPTIONS[i].label; }
    }
    return 'Source';
  }
  function selectMarkup() {
    var opts = GROUP_OPTIONS.map(function (o) {
      var sel = o.value === groupBy ? ' selected' : '';
      return '<option value="' + o.value + '"' + sel + '>' + o.label + '</option>';
    }).join('');
    return '<label class="beacon-groupby">Group by <select>' + opts + '</select></label>';
  }

  window.Beacon.registerWidget(function (Beacon) {
    var el = document.getElementById(${id});
    if (!el) { return; }
    return load(Beacon, el);
  });

  function load(Beacon, el) {
    var seq = ++loadSeq;
    el.innerHTML = '<p class="beacon-loading">Loading…</p>';
    return Beacon.getJson(Beacon.queryUrl('/attribution', { group_by: groupBy }))
      .then(function (data) {
        // A newer load started after this fetch — drop this (stale-scope) response.
        if (seq !== loadSeq) { return; }
        render(Beacon, el, data);
      })
      .catch(function (e) {
        if (seq !== loadSeq) { return; }
        // Keep the dropdown so the operator can switch dimensions to recover without a
        // full page refresh (matches the empty state); re-attach its change handler.
        el.innerHTML = selectMarkup() +
          '<p class="beacon-error">Failed to load attribution.</p>';
        attachGroupBy(Beacon, el);
        console.error('[beacon-dashboard] attribution failed', e);
      });
  }

  function render(Beacon, el, data) {
    var groups = (data && data.groups) || [];
    if (groups.length === 0) {
      // Keep the dropdown so the operator can switch dimensions even with no rows.
      el.innerHTML = selectMarkup() +
        '<p class="beacon-empty">No attribution data for the selected range.</p>';
    } else {
      // Rows are rendered as received — /attribution already orders by clicks desc.
      var body = groups.map(function (g) {
        return '<tr><td>' + esc(g.key) + '</td><td>' + g.clicks + '</td><td>' +
          g.conversions + '</td><td>' + pct(g.conversion_rate) + '</td></tr>';
      }).join('');
      el.innerHTML = selectMarkup() +
        '<table class="beacon-table"><thead><tr><th>' + esc(currentLabel()) +
        '</th><th>Clicks</th><th>Conversions</th><th>Conversion Rate</th></tr></thead><tbody>' +
        body + '</tbody></table>';
    }
    attachGroupBy(Beacon, el);
  }

  // innerHTML replaces the prior <select> on every render (table, empty, AND error), so
  // re-attach the change handler each time. Switching the dimension re-fetches ONLY this
  // widget (load), not the whole dashboard.
  function attachGroupBy(Beacon, el) {
    var sel = el.querySelector('select');
    if (sel) {
      sel.addEventListener('change', function () {
        groupBy = sel.value;
        load(Beacon, el);
      });
    }
  }
})();`;
}

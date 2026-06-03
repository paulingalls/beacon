// Overview widget (REQUIREMENTS.md §9.2, PHASE_7 §7.2): total events, unique users,
// and unique visitors metric cards plus a daily event-volume chart. The browser code
// is a plain-JS string (no build step); it takes its container id as a parameter so
// the module stays decoupled from layout.ts (the registry passes WIDGET_CONTAINER_IDS
// at render time, which also avoids a layout<->widgets import cycle).

/** The three §5.4 aggregate metrics this widget shows, with their card labels. */
const METRICS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'count', label: 'Events' },
  { key: 'unique_users', label: 'Users' },
  { key: 'unique_visitors', label: 'Visitors' },
];

/**
 * Build the Overview widget's inline browser script. Registers a refresher with
 * window.Beacon that, on each refresh, fetches the three scalar metrics and the
 * daily-volume series from /aggregate in a single Promise.all (scoped to the shared
 * product/date state via Beacon.queryUrl, fetched via the shared Beacon.getJson),
 * then renders metric cards + a Chart.js bar chart into `#${containerId}`. The prior
 * Chart instance is destroyed at the TOP of the refresher — before any await — so
 * every exit path (loading, empty, success, AND the fetch-error path) releases the
 * canvas and can't leak it or hit "canvas already in use". Loading, empty, and
 * inline-error states are handled in-widget (§7.6).
 */
export function overviewWidgetScript(containerId: string): string {
  const id = JSON.stringify(containerId);
  const metrics = JSON.stringify(METRICS);
  return `(function () {
  var METRICS = ${metrics};
  var chart = null;
  window.Beacon.registerWidget(async function (Beacon) {
    var el = document.getElementById(${id});
    if (!el) { return; }
    // Tear down the prior Chart up front so EVERY exit path (loading, empty,
    // success, error) releases the canvas — a rejected fetch jumps to catch and
    // would otherwise leak the instance (and its resize listener) across cycles.
    if (chart) { chart.destroy(); chart = null; }
    el.innerHTML = '<p class="beacon-loading">Loading…</p>';
    try {
      var results = await Promise.all(METRICS.map(function (m) {
        return Beacon.getJson(Beacon.queryUrl('/aggregate', { metric: m.key }));
      }).concat([
        Beacon.getJson(Beacon.queryUrl('/aggregate', { metric: 'count', group_by: 'day' })),
      ]));
      var scalars = results.slice(0, METRICS.length);
      var series = results[METRICS.length];
      var groups = series.groups || [];
      var totalEvents = (scalars[0] && scalars[0].value) || 0;
      if (!totalEvents && groups.length === 0) {
        el.innerHTML = '<p class="beacon-empty">No data for the selected range.</p>';
        return;
      }
      var cards = METRICS.map(function (m, i) {
        var v = (scalars[i] && scalars[i].value) || 0;
        return '<div class="beacon-metric"><span class="beacon-metric-value">' + v +
          '</span><span class="beacon-metric-label">' + m.label + '</span></div>';
      }).join('');
      var canvasId = ${id} + '-chart';
      el.innerHTML = '<div class="beacon-metrics">' + cards +
        '</div><canvas id="' + canvasId + '"></canvas>';
      // Guard on Chart so a CDN failure (offline / CSP-blocked / down) degrades
      // gracefully — the metric cards stay rendered and only the chart is skipped,
      // instead of an uncaught throw masking the (successful) metrics with an error.
      if (groups.length && typeof Chart !== 'undefined') {
        chart = new Chart(document.getElementById(canvasId), {
          type: 'bar',
          data: {
            labels: groups.map(function (g) { return String(g.key || '').slice(0, 10); }),
            datasets: [{ label: 'Daily events', data: groups.map(function (g) { return g.value; }) }],
          },
          options: { plugins: { legend: { display: false } } },
        });
      }
    } catch (e) {
      el.innerHTML = '<p class="beacon-error">Failed to load overview.</p>';
      console.error('[beacon-dashboard] overview failed', e);
    }
  });
})();`;
}

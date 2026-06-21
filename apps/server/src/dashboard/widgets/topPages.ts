// Top Pages widget (REQUIREMENTS.md §9.2, PHASE_7 §7.3): the top 20 request paths by
// view count, with unique-user counts. The /aggregate group_by whitelist is
// dimensions+time only (it can't group by properties->>'path'), so this widget pulls
// `request` events from /events — scoped to the shared product/date state via
// Beacon.queryUrl — over a bounded set of pages and tallies path views + distinct
// users in the browser. Container id is a parameter (decoupled from layout.ts).

/** Max request events pulled per refresh — bounds the client-side tally. */
const MAX_EVENTS = 1000;
/** Per-page fetch size (the /events handler caps `limit` at 1000). */
const PAGE_SIZE = 200;
/** Rows shown in the table. */
const TOP_N = 20;

/**
 * Build the Top Pages widget's inline browser script. Registers a refresher that
 * pages through `request` events (bounded by MAX_EVENTS), tallies views and distinct
 * users (user_id ?? visitor_token) per properties.path, and renders the top-N table
 * sorted by views descending. Loading / empty / inline-error states are in-widget.
 */
export function topPagesWidgetScript(containerId: string): string {
  const id = JSON.stringify(containerId);
  return `(function () {
  var MAX_EVENTS = ${MAX_EVENTS};
  var PAGE_SIZE = ${PAGE_SIZE};
  var TOP_N = ${TOP_N};
  window.Beacon.registerWidget(async function (Beacon) {
    var el = document.getElementById(${id});
    if (!el) { return; }
    el.innerHTML = '<p class="beacon-loading">Loading…</p>';
    try {
      var rows = [];
      var cursor = null;
      // Bounded pagination: pull request events until the feed is exhausted or the
      // cap is hit — a dashboard tally, not a full-table scan.
      do {
        var extra = { event_type: 'request', limit: PAGE_SIZE };
        if (cursor) { extra.cursor = cursor; }
        var page = await Beacon.getJson(Beacon.queryUrl('/events', extra));
        rows = rows.concat(page.events || []);
        cursor = page.cursor;
      } while (cursor && rows.length < MAX_EVENTS);
      // A still-truthy cursor means we stopped at the cap, not the end of the feed —
      // so the tally is the most-recent MAX_EVENTS, an approximation of the window.
      var capped = !!cursor;

      // Null-prototype maps so a literal '__proto__' path or user token tallies as
      // an own key instead of hitting the Object.prototype setter (and being dropped
      // by Object.keys). Low realism for beacon data, but the tally must be total.
      var byPath = Object.create(null);
      rows.forEach(function (e) {
        var p = (e.properties && e.properties.path) || '(unknown)';
        var rec = byPath[p] || (byPath[p] = { views: 0, users: Object.create(null) });
        rec.views += 1;
        var u = e.user_id || e.visitor_token;
        if (u) { rec.users[u] = true; }
      });
      var list = Object.keys(byPath).map(function (p) {
        return { path: p, views: byPath[p].views, uniques: Object.keys(byPath[p].users).length };
      }).sort(function (a, b) { return b.views - a.views; }).slice(0, TOP_N);

      if (list.length === 0) {
        el.innerHTML = '<p class="beacon-empty">No request events for the selected range.</p>';
        return;
      }
      var body = list.map(function (r) {
        return '<tr><td>' + Beacon.esc(r.path) + '</td><td>' + r.views + '</td><td>' + r.uniques + '</td></tr>';
      }).join('');
      var note = capped
        ? '<p class="beacon-note">Approximate — based on the most recent ' + MAX_EVENTS +
          ' requests in this range.</p>'
        : '';
      el.innerHTML = '<table class="beacon-table"><thead><tr><th>Path</th><th>Views</th>' +
        '<th>Unique Users</th></tr></thead><tbody>' + body + '</tbody></table>' + note;
    } catch (e) {
      el.innerHTML = '<p class="beacon-error">Failed to load top pages.</p>';
      console.error('[beacon-dashboard] top-pages failed', e);
    }
  });
})();`;
}

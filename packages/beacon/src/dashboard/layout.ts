// Server-rendered admin dashboard shell (REQUIREMENTS.md §9). A pure function of
// { basePath } — no DB, no async, no per-request state — so the route handler is
// just `c.html(renderShell({ basePath }))` and this module is unit-testable as a
// plain string. There is no client-side build step (CLAUDE.md): all CSS is inline
// in a <style> tag and the browser script is plain JS authored as a template
// literal, with Chart.js pulled from a CDN. Widget stories (002-005) render into
// the container divs declared here and drive everything through the window.Beacon
// browser contract (added in the next step).

import { renderWidgetScripts } from './widgets';

/** Chart.js, loaded from a public CDN (no bundler). Hosts enforcing a CSP must
 * allowlist this origin and the inline script/style. */
const CHART_JS_CDN = 'https://cdn.jsdelivr.net/npm/chart.js';

/**
 * The container <div> id each widget renders into. The single source of truth for
 * these ids — widget stories (002-005) import this rather than copy the strings,
 * so a rename here can't silently desync the shell from a widget. Frozen by
 * story-001 because four downstream stories depend on it.
 */
export const WIDGET_CONTAINER_IDS = {
  overview: 'beacon-widget-overview',
  topPages: 'beacon-widget-top-pages',
  attribution: 'beacon-widget-attribution',
  funnel: 'beacon-widget-funnel',
} as const;

export interface RenderShellOptions {
  /** API mount prefix (e.g. '/analytics'); the browser builds same-origin query
   * URLs from it. Trusted operator config (createBeacon's `config.basePath`,
   * default '/analytics'), never end-user input — so it is interpolated into the
   * `data-base-path` attribute without HTML-escaping. Do not route untrusted
   * input here. */
  basePath: string;
}

/** Inline dashboard stylesheet — minimal, responsive down to tablet width. */
const STYLE = `
  :root { --fg: #1a1a2e; --muted: #6b7280; --line: #e5e7eb; --accent: #2563eb; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; color: var(--fg); background: #f8fafc; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
    padding: 16px 24px; background: #fff; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 18px; margin: 0 16px 0 0; }
  header select, header input, header button { font: inherit; padding: 6px 10px;
    border: 1px solid var(--line); border-radius: 6px; background: #fff; }
  header button { cursor: pointer; }
  header button:hover { border-color: var(--accent); color: var(--accent); }
  main { display: grid; gap: 16px; padding: 24px;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .widget { background: #fff; border: 1px solid var(--line); border-radius: 10px;
    padding: 16px; min-height: 120px; }
  .widget h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted); margin: 0 0 12px; }
  #beacon-status { margin: 0; padding: 12px 24px; background: #fef2f2;
    border-bottom: 1px solid #fecaca; color: #b91c1c; }
`;

/** A widget card with its heading and the container the widget renders into. */
function widgetCard(id: string, title: string): string {
  return `<section class="widget"><h2>${title}</h2><div id="${id}"></div></section>`;
}

/**
 * The browser bootstrap — the frozen `window.Beacon` contract that widget stories
 * (002-005) build against. Authored as a static plain-JS IIFE string (no build
 * step; CLAUDE.md). It carries no server-interpolated values: `basePath` is read
 * from the `data-base-path` attribute on <body> at runtime, so this constant is
 * identical for every render. The contract:
 *
 *   window.Beacon = {
 *     basePath,                       // from data-base-path
 *     state: { productId, after, before },  // shared filter state; after/before ISO
 *     schema,                         // the full GET /schema body once loaded, else null
 *     getJson(url),                   // fetch(url) → throw on !ok → parsed JSON; the shared fetch helper
 *     queryUrl(endpoint, extra),      // basePath + endpoint + ?product_id(if set)&after&before&...extra
 *     eventTypeNames(productId?),     // distinct names from schema.event_types
 *     registerWidget(fn),             // fn:(Beacon)=>void|Promise; auto-run if schema already loaded
 *     refreshAll(),                   // re-run every widget; per-widget try/catch isolation
 *   }
 *
 * Contract rules widgets MUST honour: read Beacon.state / Beacon.schema (never the
 * DOM controls); build URLs only via Beacon.queryUrl; render into exactly one
 * WIDGET_CONTAINER_IDS div. A refresher may assume Beacon.schema is non-null (it is
 * only ever called after the schema load). refreshAll isolates each widget in a
 * try/catch so one failure can't blank the others (§1.3 failure-isolation ethos).
 *
 * IMPORTANT — schema.event_types shape: GET /schema returns event_types as an array
 * of per-product objects `{product_id, event_type, first_seen, last_seen, count}`,
 * NOT a flat list of names. eventTypeNames() reads the `.event_type` field and
 * dedups (optionally scoped to a product) so the funnel widget (005) never has to
 * re-derive the shape.
 */
const BOOTSTRAP_SCRIPT = `(function () {
  var DAY_MS = 86400000;
  var isoDaysAgo = function (n) { return new Date(Date.now() - n * DAY_MS).toISOString(); };
  var nowIso = function () { return new Date().toISOString(); };
  // Local start-of-day as an instant: 'Today' and the custom range work on the
  // operator's calendar day, consistent with each other; 7d/30d/90d stay rolling.
  var startOfTodayIso = function () {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  };
  // <input type=date> gives 'YYYY-MM-DD' meaning the operator's local calendar day.
  // new Date('YYYY-MM-DD') would parse as UTC midnight (off by the UTC offset), so
  // build the instant from local Y/M/D. addDays advances whole calendar days.
  var localDayIso = function (value, addDays) {
    var parts = value.split('-');
    return new Date(+parts[0], +parts[1] - 1, +parts[2] + (addDays || 0)).toISOString();
  };
  var widgets = [];
  var loaded = false;

  var Beacon = {
    basePath: (document.body.dataset.basePath || ''),
    state: { productId: null, after: isoDaysAgo(30), before: nowIso() },
    schema: null,
    getJson: function (url) {
      return fetch(url).then(function (r) {
        if (!r.ok) { throw new Error('request failed: ' + r.status + ' ' + url); }
        return r.json();
      });
    },
    queryUrl: function (endpoint, extra) {
      var p = new URLSearchParams();
      if (Beacon.state.productId) { p.set('product_id', Beacon.state.productId); }
      p.set('after', Beacon.state.after);
      p.set('before', Beacon.state.before);
      if (extra) {
        Object.keys(extra).forEach(function (k) {
          if (extra[k] != null && extra[k] !== '') { p.set(k, extra[k]); }
        });
      }
      return Beacon.basePath + endpoint + '?' + p.toString();
    },
    eventTypeNames: function (productId) {
      // schema.event_types: [{product_id, event_type, ...}] — read .event_type, dedup.
      var rows = (Beacon.schema && Beacon.schema.event_types) || [];
      var seen = {};
      var names = [];
      rows.forEach(function (r) {
        if (productId && r.product_id !== productId) { return; }
        if (!seen[r.event_type]) { seen[r.event_type] = true; names.push(r.event_type); }
      });
      return names;
    },
    registerWidget: function (fn) {
      widgets.push(fn);
      if (loaded) { runWidget(fn); }
    },
    refreshAll: function () {
      return Promise.all(widgets.map(runWidget));
    },
  };

  function runWidget(fn) {
    try {
      return Promise.resolve(fn(Beacon)).catch(reportError);
    } catch (e) {
      reportError(e);
      return Promise.resolve();
    }
  }
  function reportError(e) { console.error('[beacon-dashboard] widget failed', e); }

  function populateProducts(products) {
    var sel = document.getElementById('beacon-product-select');
    (products || []).forEach(function (pid) {
      var opt = document.createElement('option');
      opt.value = pid;
      opt.textContent = pid;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      Beacon.state.productId = sel.value || null;
      Beacon.refreshAll();
    });
  }

  function wireDateControls() {
    var presetDays = { '7d': 7, '30d': 30, '90d': 90 };
    document.querySelectorAll('[data-range]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var range = btn.getAttribute('data-range');
        // 'Today' = local start-of-day → now (calendar day). The others are rolling
        // windows ending now, matching their last-N-days labels.
        Beacon.state.after = range === 'today' ? startOfTodayIso() : isoDaysAgo(presetDays[range] || 30);
        Beacon.state.before = nowIso();
        Beacon.refreshAll();
      });
    });
    var after = document.getElementById('beacon-range-after');
    var before = document.getElementById('beacon-range-before');
    function applyCustom() {
      // The query API filters timestamp < before (exclusive), so the 'To' bound is
      // the START of the day AFTER the picked end day — otherwise the whole selected
      // end day (and a From==To single-day pick) would fall outside the window.
      if (after.value) { Beacon.state.after = localDayIso(after.value, 0); }
      if (before.value) { Beacon.state.before = localDayIso(before.value, 1); }
      Beacon.refreshAll();
    }
    after.addEventListener('change', applyCustom);
    before.addEventListener('change', applyCustom);
  }

  window.Beacon = Beacon;

  function showStatus(message) {
    var el = document.getElementById('beacon-status');
    if (el) { el.textContent = message; el.hidden = false; }
  }

  document.addEventListener('DOMContentLoaded', function () {
    wireDateControls();
    Beacon.getJson(Beacon.basePath + '/schema')
      .then(function (schema) {
        Beacon.schema = schema;
        populateProducts(schema.products);
        loaded = true;
        return Beacon.refreshAll();
      })
      .catch(function (e) {
        // Schema load is the bootstrap precondition: without it refreshAll never
        // runs and the operator would see four blank cards indistinguishable from
        // 'no data'. Surface a visible, reloadable error instead of failing silent.
        console.error('[beacon-dashboard] schema load failed', e);
        showStatus('Could not load dashboard data. Check the connection and reload the page.');
      });
  });
})();`;

/**
 * Render the full dashboard HTML page. The header carries the product selector
 * and date-range controls; <main> holds one card per widget. The browser contract
 * (window.Beacon) and bootstrap script are added in the next step.
 */
export function renderShell(opts: RenderShellOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Beacon Analytics</title>
<style>${STYLE}</style>
<script src="${CHART_JS_CDN}"></script>
</head>
<body data-base-path="${opts.basePath}">
<header>
  <h1>Beacon</h1>
  <label>Product
    <select id="beacon-product-select"><option value="">All products</option></select>
  </label>
  <span>
    <button type="button" data-range="today">Today</button>
    <button type="button" data-range="7d">7d</button>
    <button type="button" data-range="30d">30d</button>
    <button type="button" data-range="90d">90d</button>
  </span>
  <label>From <input type="date" id="beacon-range-after" /></label>
  <label>To <input type="date" id="beacon-range-before" /></label>
</header>
<p id="beacon-status" role="alert" hidden></p>
<main>
  ${widgetCard(WIDGET_CONTAINER_IDS.overview, 'Overview')}
  ${widgetCard(WIDGET_CONTAINER_IDS.topPages, 'Top Pages')}
  ${widgetCard(WIDGET_CONTAINER_IDS.attribution, 'Attribution')}
  ${widgetCard(WIDGET_CONTAINER_IDS.funnel, 'Funnel')}
</main>
<script>${BOOTSTRAP_SCRIPT}</script>
${renderWidgetScripts()}
</body>
</html>`;
}

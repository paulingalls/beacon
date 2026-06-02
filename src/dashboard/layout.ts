// Server-rendered admin dashboard shell (REQUIREMENTS.md §9). A pure function of
// { basePath } — no DB, no async, no per-request state — so the route handler is
// just `c.html(renderShell({ basePath }))` and this module is unit-testable as a
// plain string. There is no client-side build step (CLAUDE.md): all CSS is inline
// in a <style> tag and the browser script is plain JS authored as a template
// literal, with Chart.js pulled from a CDN. Widget stories (002-005) render into
// the container divs declared here and drive everything through the window.Beacon
// browser contract (added in the next step).

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
`;

/** A widget card with its heading and the container the widget renders into. */
function widgetCard(id: string, title: string): string {
  return `<section class="widget"><h2>${title}</h2><div id="${id}"></div></section>`;
}

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
<main>
  ${widgetCard(WIDGET_CONTAINER_IDS.overview, 'Overview')}
  ${widgetCard(WIDGET_CONTAINER_IDS.topPages, 'Top Pages')}
  ${widgetCard(WIDGET_CONTAINER_IDS.attribution, 'Attribution')}
  ${widgetCard(WIDGET_CONTAINER_IDS.funnel, 'Funnel')}
</main>
</body>
</html>`;
}

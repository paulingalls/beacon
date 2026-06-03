// Dashboard widget registry. renderShell (layout.ts) injects renderWidgetScripts()
// once, after the window.Beacon bootstrap, so every widget's registerWidget(...) call
// runs in the browser. Adding a widget = one entry in the list below; no layout.ts
// change. Container ids are read here at call time (from WIDGET_CONTAINER_IDS) and
// passed to each widget builder — call-time access keeps the layout<->widgets import
// cycle init-safe.

import { WIDGET_CONTAINER_IDS } from '../layout';
import { attributionWidgetScript } from './attribution';
import { funnelWidgetScript } from './funnel';
import { overviewWidgetScript } from './overview';
import { topPagesWidgetScript } from './topPages';

/** The widgets' inline scripts, each wrapped in its own <script> tag. */
export function renderWidgetScripts(): string {
  return [
    overviewWidgetScript(WIDGET_CONTAINER_IDS.overview),
    topPagesWidgetScript(WIDGET_CONTAINER_IDS.topPages),
    attributionWidgetScript(WIDGET_CONTAINER_IDS.attribution),
    funnelWidgetScript(WIDGET_CONTAINER_IDS.funnel),
  ]
    .map((script) => `<script>${script}</script>`)
    .join('\n');
}

// Dashboard widget registry. renderShell (layout.ts) injects renderWidgetScripts()
// once, after the window.Beacon bootstrap, so every widget's registerWidget(...) call
// runs in the browser. Adding a widget = one entry in the list below; no layout.ts
// change. Container ids are read here at call time (from WIDGET_CONTAINER_IDS) and
// passed to each widget builder — call-time access keeps the layout<->widgets import
// cycle init-safe.

import { WIDGET_CONTAINER_IDS } from '../layout';
import { overviewWidgetScript } from './overview';

/** The widgets' inline scripts, each wrapped in its own <script> tag. */
export function renderWidgetScripts(): string {
  return [overviewWidgetScript(WIDGET_CONTAINER_IDS.overview)]
    .map((script) => `<script>${script}</script>`)
    .join('\n');
}

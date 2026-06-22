import type { Handler } from 'hono';

import { type RenderShellOptions, renderShell } from './layout';

// Dashboard route handler (REQUIREMENTS.md §9.3 GET {basePath}/dashboard). The
// admin gate is applied at mount time (src/index.ts), mirroring the query routes —
// this factory just serves the page. renderShell is a pure function of { basePath },
// so the HTML is built ONCE at factory time and reused on every request (the same
// build-once rationale as the query handlers; nothing per-request varies).

/**
 * Build the dashboard handler for a given mount prefix. Renders the §9 shell once
 * and returns it via `c.html()` (text/html). Mount behind the admin gate.
 */
export function createDashboardHandler(opts: RenderShellOptions): Handler {
  const page = renderShell(opts);
  return (c) => c.html(page);
}

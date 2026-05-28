# Phase 7: Admin Dashboard

## Relevant Sections

- `REQUIREMENTS.md` → §9 Admin Dashboard (§9.1 Implementation, §9.2 Views, §9.3 Dashboard Route)
- `REQUIREMENTS.md` → §5.4 Endpoints (the query API the dashboard consumes)
- `BEACON_OVERVIEW.md` → Query API → Admin Dashboard

## Goal

Build a simple, server-rendered admin dashboard that provides at-a-glance product analytics. It consumes the same query API built in Phase 5, serving as both a useful tool and a reference implementation for the API. No build step, no client-side framework — just HTML with minimal inline JavaScript.

---

## Milestones

### 7.1 — Dashboard Layout & Shell

**Deliverables:**

- `packages/beacon/src/dashboard/index.ts` — Hono route handler for `GET {basePath}/dashboard`:
  - Protected by `isAdmin(c)` — returns `403` if false
  - Returns a self-contained HTML page via `c.html()`
  - All CSS is inline in a `<style>` tag — clean, minimal, responsive
  - All JavaScript is inline in a `<script>` tag
  - No external CSS or JS dependencies except a charting library loaded from CDN (Chart.js)
  - Layout: header with product selector and date range picker, main content area with widget cards
- Product selector: dropdown populated by calling `GET {basePath}/schema` on page load
- Date range selector: preset buttons (Today, 7d, 30d, 90d) and a custom date range input
- Selecting a product or date range re-fetches all widgets via the query API

**Tests:**

- Dashboard route returns `200` with HTML content type for admin users
- Dashboard route returns `403` for non-admin users
- HTML contains all expected structural elements (product selector, date picker, widget containers)

### 7.2 — Overview Widget

**Deliverables:**

- Top-level metrics card showing:
  - Total events (via `/analytics/aggregate?metric=count`)
  - Unique users (via `/analytics/aggregate?metric=unique_users`)
  - Unique visitors (via `/analytics/aggregate?metric=unique_visitors`)
- Daily event volume chart:
  - Bar or line chart via Chart.js
  - Data from `/analytics/aggregate?metric=count&group_by=day`
- All queries scoped to the selected product and date range

### 7.3 — Top Pages Widget

**Deliverables:**

- Table showing top 20 paths by event count:
  - Data from `/analytics/events` or a custom aggregate query grouping by `properties->>'path'` where `event_type = 'request'`
  - Columns: Path, Views, Unique Users
- Sorted by views descending

### 7.4 — Attribution Widget

**Deliverables:**

- Table grouped by `utm_source` (default):
  - Data from `/analytics/attribution`
  - Columns: Source, Clicks, Conversions, Conversion Rate
- Dropdown to switch `group_by` dimension (source, medium, campaign)
- Sorted by clicks descending

### 7.5 — Funnel Widget

**Deliverables:**

- Step selector: multi-select or ordered input allowing the admin to pick 2–5 event types from the known types (fetched from schema)
- Visual funnel display:
  - Horizontal bars showing count at each step with drop-off percentage between steps
  - Overall conversion rate displayed at the bottom
  - Data from `/analytics/funnel`
- Default funnel: `request → signup` (if those event types exist)

### 7.6 — Polish & Integration

**Deliverables:**

- Loading states: show a spinner or skeleton while widgets fetch data
- Error states: if a query fails, show an inline error message in the widget (not a full-page error)
- Empty states: if no data exists for the selected filters, show a helpful message
- Responsive: dashboard is usable on tablet-width screens (not necessarily mobile-optimized)
- Mount the dashboard route in `beacon.router()` at `{basePath}/dashboard`
- Verify all widgets update correctly when product or date range is changed

**Tests (integration):**

- Dashboard loads and renders with test data in the database
- Changing product filter updates widget content
- Changing date range updates widget content
- Dashboard with no data shows empty states rather than errors

---

## Exit Criteria

- Admin dashboard is accessible at `{basePath}/dashboard` behind admin auth
- Overview, Top Pages, Attribution, and Funnel widgets all render correctly
- Dashboard consumes the Phase 5 query API — no direct database queries
- No build step required — all assets are inline
- Responsive and handles loading/error/empty states gracefully
- All tests pass
- `bun test` at root passes (no regressions from Phases 1–6)

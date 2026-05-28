# MILESTONES.md — Beacon Build Plan

This document is the master build plan for Beacon. Each phase has its own detailed document in the `phases/` directory. Phase documents reference specific sections of `REQUIREMENTS.md` and `BEACON_OVERVIEW.md` so each Claude Code session has the focused context it needs.

---

## Phase Order

| Phase | Document | Description | Dependencies |
|---|---|---|---|
| 1 | `phases/PHASE_1_FOUNDATION.md` | Repo setup, workspace config, Postgres connection, migration runner | None |
| 2 | `phases/PHASE_2_MIDDLEWARE.md` | Request logging middleware, event buffer, flush pipeline | Phase 1 |
| 3 | `phases/PHASE_3_VISITOR_ATTRIBUTION.md` | Visitor token system, UTM/attribution capture, visitor-to-user association | Phase 2 |
| 4 | `phases/PHASE_4_CUSTOM_EVENTS.md` | Server-side track helper, client batch ingest endpoint | Phase 2 |
| 5 | `phases/PHASE_5_QUERY_API.md` | Schema, events, aggregate, funnel, attribution endpoints; rate limiting; error handling | Phase 1 |
| 6 | `phases/PHASE_6_SHORTENER.md` | URL shortener: code generation, redirect, caching, campaign attribution | Phases 2, 5 |
| 7 | `phases/PHASE_7_DASHBOARD.md` | Server-rendered admin dashboard consuming the query API | Phase 5 |
| 8 | `phases/PHASE_8_CLIENT_SDK.md` | `beacon-client` package: core, React Native wrapper, optional web wrapper | Phase 4 |

---

## Repo & Distribution

- **GitHub:** `paulingalls/beacon` (personal account)
- **Package scope:** `@pi-innovations/beacon`, `@pi-innovations/beacon-client` (scope is a naming convention, not tied to an npm org)
- **Distribution:** Git dependencies via `"github:paulingalls/beacon"` in consumer repos. No npm publishing in v1.
- **Monorepo:** Bun workspaces with packages in `packages/beacon` and `packages/beacon-client`

---

## Definition of Done (Per Phase)

Each phase is complete when:

1. All milestones in the phase document are implemented
2. Unit tests pass for all new code
3. Integration tests pass (where applicable — phases touching Postgres)
4. No regressions in previously completed phases (`bun test` passes at the root)
5. Code is committed and pushed to `paulingalls/beacon`

---

## How to Use These Documents

When starting a Claude Code session for a phase:

1. Open the relevant phase document (e.g., `phases/PHASE_2_MIDDLEWARE.md`)
2. The phase document lists which sections of `REQUIREMENTS.md` and `BEACON_OVERVIEW.md` are relevant — read those sections for full implementation detail
3. Follow the milestones in order within the phase
4. Reference `CLAUDE.md` for conventions, tech stack, and repo structure

/**
 * Event-shape limits shared across the agnostic emit path and the Hono track()
 * helper (REQUIREMENTS.md §6.1). Extracted to its own hono-free module so the
 * createHttpBeacon graph can import the cap without pulling in track.ts (whose
 * Context-typed public API belongs to the ./hono subpath). Both httpBeacon.ts
 * and hono/track.ts read MAX_EVENT_TYPE_LENGTH from here so the cap stays
 * identical across transports.
 */

/** Max event_type length (REQUIREMENTS.md §6.1). */
export const MAX_EVENT_TYPE_LENGTH = 100;

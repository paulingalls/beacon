import type { BeaconEvent } from '../types';

// The emit seam for captured events (execution_plan.json §Milestone 3,
// REQUIREMENTS.md §1.2). The capture layer (requestLogger/track/ingest) pushes
// events to an EventSink rather than knowing about a concrete buffer, so the same
// capture logic can target the Postgres-backed EventBuffer (the deployed Hono
// host) or an HttpSink (a Bun.serve product emitting over the trusted ingest
// boundary, story-003). EventBuffer.push already satisfies this structurally.

/** A destination the capture layer pushes finished events to (fire-and-forget). */
export interface EventSink {
  push(event: BeaconEvent): void;
}

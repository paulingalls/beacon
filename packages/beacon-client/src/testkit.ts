// Shared test-only scaffolding for the beacon-client suites (sprint-010 / Milestone 2
// duplication paydown). The core, reactNative, and web suites each re-declared the same
// fetch/timer/clock/storage stubs and a client-construction factory inline; this module is
// the single home for them. It is NOT referenced by package.json `exports` (only `.`,
// `./react-native`, `./web`), so it can never leak into the shipped surface — only *.test.ts
// files import it. Platform-specific fakes (makeRN, makeWeb) stay in their own suites.

import { APP_CONTEXT_HEADER, type AppContext } from './context/appContext';
import { BeaconClient } from './core/client';
import type { BeaconClientConfig, BeaconClientDeps } from './core/types';

export { APP_CONTEXT_HEADER };

/** Default app context for client construction. Suites that assert on platform override it. */
export const APP_CONTEXT: AppContext = { appVersion: '1.0.0', platform: 'ios' };

/** Let all pending microtasks (a fire-and-forget flush chain) settle. */
export const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

export interface FetchStep {
  status?: number;
  retryAfter?: number | string;
  throw?: boolean;
  /** `product_id_used` returned by the stub's res.json() (the 202 ingest body shape). */
  productIdUsed?: string;
}

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: { product_id?: string; events: Array<Record<string, unknown>> };
}

/** Scripted fetch stub: records each call, replays `plan` (last step repeats). */
export function makeFetch(plan: FetchStep[] = [{ status: 202 }]): {
  fetchFn: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn = (async (url: string, opts: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const step = plan[Math.min(i, plan.length - 1)] ?? { status: 202 };
    i += 1;
    if (step.throw) throw new Error('network down');
    const status = step.status ?? 202;
    const headers = {
      get: (k: string) =>
        k.toLowerCase() === 'retry-after' && step.retryAfter != null
          ? String(step.retryAfter)
          : null,
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      // Mirrors the server's 202 ingest body {accepted, product_id_used}; only onSent reads it.
      json: async () => ({ product_id_used: step.productIdUsed }),
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Manual interval scheduler — bun:test has no fake timers. `fire()` runs the handler.
 * Module-local: `build()` wires it into every client; no suite needs it directly. */
function makeTimer() {
  let handler: (() => void) | undefined;
  let cleared = false;
  const seam = {
    setInterval: ((h: () => void) => {
      handler = h;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as BeaconClientDeps['setInterval'],
    clearInterval: (() => {
      cleared = true;
    }) as BeaconClientDeps['clearInterval'],
    fire: () => handler?.(),
    get cleared() {
      return cleared;
    },
  };
  return seam;
}

export function makeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** In-memory storage adapter spy. `loadValue` seeds a restored queue. */
export function makeStorage(loadValue: Array<{ eventType: string }> = []) {
  const saved: Array<Array<{ eventType: string }>> = [];
  let cleared = 0;
  let loadResolve: ((v: Array<{ eventType: string }>) => void) | undefined;
  const adapter = {
    load: () =>
      loadValue === null
        ? new Promise<Array<{ eventType: string }>>((r) => {
            loadResolve = r;
          })
        : Promise.resolve(loadValue),
    save: async (events: Array<{ eventType: string }>) => {
      saved.push(events);
    },
    clear: async () => {
      cleared += 1;
    },
  };
  return {
    adapter: adapter as unknown as BeaconClientConfig['storage'],
    get saved() {
      return saved;
    },
    get cleared() {
      return cleared;
    },
    resolveLoad: (v: Array<{ eventType: string }>) => loadResolve?.(v),
  };
}

/** Flatten every event POSTed across all recorded fetch calls. */
export function allEvents(calls: RecordedCall[]): Array<Record<string, unknown>> {
  return calls.flatMap((c) => c.body.events);
}

/**
 * Construct a BeaconClient with test defaults and the scripted fetch + firing timer seams.
 * Pass `deps.fetch` to drive a custom transport (and track its calls yourself); otherwise an
 * internal `makeFetch()` is wired and its `calls` are returned. `config` merges over the
 * defaults (endpoint, productId 'clipcast', APP_CONTEXT).
 */
export function build(
  config: Partial<BeaconClientConfig> = {},
  deps: BeaconClientDeps = {},
): { client: BeaconClient; calls: RecordedCall[]; timer: ReturnType<typeof makeTimer> } {
  const fetchStub = deps.fetch ? { fetchFn: deps.fetch, calls: [] as RecordedCall[] } : makeFetch();
  const timer = makeTimer();
  const client = new BeaconClient(
    {
      endpoint: 'https://ingest.test/events',
      productId: 'clipcast',
      appContext: APP_CONTEXT,
      ...config,
    },
    {
      fetch: fetchStub.fetchFn,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      ...deps,
    },
  );
  return { client, calls: fetchStub.calls, timer };
}

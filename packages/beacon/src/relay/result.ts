// Shared trusted-forward contract for the client-relay interface (execution_plan.json
// §Milestone 7). Both relays — ingest (relayBatch) and identify (relayIdentify) — forward
// a JSON body to a deployed Beacon endpoint under the M2 trusted bearer and map the
// outcome the same way. This module is the single enforcement point for that contract, so
// the two relays can never drift (decision relay-outcome-mapping). The bearer token is
// NEVER logged.

/** Forward-and-await result: tells the caller whether to retry or give up. */
export type RelayResult = {
  /**
   * `ok` — upstream accepted the forward.
   * `caller_error` — a genuine caller-fault (malformed body, 400); retrying won't help.
   * `retryable` — a relay/operator fault (bad bearer, non-allowlisted product, 5xx) or a
   *   network error; the work is valid and must NOT be dropped (lesson: never lose valid
   *   events) — the device should retry until the operator fixes the config.
   */
  outcome: 'ok' | 'caller_error' | 'retryable';
  /** Upstream HTTP status, or 0 for a network/transport error. */
  status: number;
};

/** Map an upstream HTTP status to a retry-shaped outcome. */
export function classify(status: number): RelayResult {
  if (status >= 200 && status < 300) return { outcome: 'ok', status };
  // Only a malformed body (400) is the caller's fault and unfixable by retry. Any other
  // non-2xx (401/403 bad bearer or non-allowlisted product, 429, 3xx, 5xx) is a
  // relay/operator/transient fault: keep the valid work retryable, never drop it.
  if (status === 400) return { outcome: 'caller_error', status };
  return { outcome: 'retryable', status };
}

/** Map a RelayResult to the status a device's HttpSink acts on: 204 ok, 400 drop, 502 retry. */
export function resultToResponse(result: RelayResult): Response {
  if (result.outcome === 'ok') return new Response(null, { status: 204 });
  if (result.outcome === 'caller_error') return new Response(null, { status: 400 });
  return new Response(null, { status: 502 });
}

/**
 * POST a JSON body to a trusted Beacon endpoint under the bearer, forward-and-await, and
 * return the classified outcome. Fails closed — throws if the token is unset, never
 * forwarding over an unauthenticated path. The token never appears in a thrown message or
 * a log. `label` distinguishes the warn line per caller (e.g. relayBatch / relayIdentify).
 */
export async function forwardJson(
  endpoint: string,
  trustedIngestToken: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = globalThis.fetch,
  label = 'relay',
): Promise<RelayResult> {
  if (!trustedIngestToken) {
    throw new Error(`[beacon] ${label}: trustedIngestToken is required (fail-closed)`);
  }

  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${trustedIngestToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network/transport error — transient, retryable. (token never in the message)
    console.warn(`[beacon] ${label}: POST failed (network): ${String(err)}`);
    return { outcome: 'retryable', status: 0 };
  }

  const result = classify(res.status);
  if (result.outcome === 'retryable') {
    console.warn(`[beacon] ${label}: upstream returned ${res.status}; retryable`);
  }
  return result;
}

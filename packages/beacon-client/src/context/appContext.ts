// X-App-Context request-header builder (REQUIREMENTS.md §8.2 / PHASE_8 §8.3). The SDK
// attaches this header to every outgoing request; the server middleware parses it back
// (parseAppContext in packages/beacon/src/middleware/requestContext.ts) into the event
// `context` JSONB. parseAppContext accepts only a plain JSON object — arrays, primitives,
// and malformed JSON are silently ignored (platform then defaults to 'web') — so the
// builder's sole job is to JSON.stringify a plain appContext object under the header name.

export const APP_CONTEXT_HEADER = 'X-App-Context';

/**
 * Device/app context attached to every request. `appVersion` and `platform` are the
 * minimum (§8.3); the optional fields are populated by platform wrappers (e.g. story-003's
 * getDeviceContext) or set manually. This is the SDK's source-of-truth type for app
 * context — story-002's BeaconClientConfig builds on it.
 */
export interface AppContext {
  appVersion: string;
  platform: 'ios' | 'android' | 'web';
  os?: string;
  device?: string;
  screen?: string;
}

/**
 * Build the `X-App-Context` header from the SDK's app context. `JSON.stringify` drops unset
 * optional fields, so the server stores only the fields that were actually provided.
 */
export function buildAppContextHeader(appContext: AppContext): Record<string, string> {
  return { [APP_CONTEXT_HEADER]: JSON.stringify(appContext) };
}

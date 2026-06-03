// Public API for @pi-innovations/beacon-client — the platform-agnostic core (PHASE_8 §8.6).
// The React Native and web lifecycle wrappers ship via the './react-native' and './web' subpath
// exports (see package.json), so they stay out of this platform-agnostic entry point.

export type { AppContext } from './context/appContext';
export { APP_CONTEXT_HEADER, buildAppContextHeader } from './context/appContext';
export { BeaconClient } from './core/client';
export type { BeaconClientConfig, BeaconEvent, BeaconStorageAdapter } from './core/types';
export {
  DEFAULT_FLUSH_INTERVAL,
  DEFAULT_MAX_BATCH_SIZE,
  MAX_EVENTS_PER_REQUEST,
  MAX_QUEUE_SIZE,
  MAX_RETRY_ATTEMPTS,
} from './core/types';

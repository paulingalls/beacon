// Hosts inject their bundled framework instances to avoid duplicate React / RN copies.

import type { AppContext } from '../context/appContext';
import type { BeaconClient } from '../core/client';

type EffectCleanup = (() => void) | undefined;

export interface ReactNativeBindings {
  useEffect: (effect: () => EffectCleanup, deps?: readonly unknown[]) => void;
  AppState: {
    addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
  };
  Platform: { OS: string; Version: string | number };
  Dimensions: { get(dimension: 'window'): { width: number; height: number } };
}

/**
 * Subscribe a BeaconClient to the app lifecycle: flush on background, track an
 * `app_foreground` marker on a real foreground (background→active), and unsubscribe on
 * unmount. The foreground marker is gated on a prior `background` so transient iOS
 * `inactive→active` blips (Control Center, notification shade) don't over-count it.
 * Never tears the client down — unsent events survive a foreground.
 *
 * Pass a STABLE `rn` reference (module-scope, not an inline object literal). The effect
 * deps are `[client, rn]`, so a fresh object identity each render re-subscribes the listener.
 */
export function useBeaconLifecycle(client: BeaconClient, rn: ReactNativeBindings): void {
  rn.useEffect(() => {
    let wasBackground = false;
    const subscription = rn.AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        wasBackground = true;
        void client.flush();
      } else if (state === 'active' && wasBackground) {
        wasBackground = false;
        client.track('app_foreground');
      }
    });
    return () => subscription.remove();
  }, [client, rn]);
}

/**
 * Device/app context fields to merge into `appContext`, read from RN/Expo primitives:
 * `os` from Platform, `screen` as "WIDTHxHEIGHT" from the window dimensions. Device model
 * needs an optional host library (e.g. `expo-device`) and is intentionally left to the host.
 */
export function getDeviceContext(
  rn: Pick<ReactNativeBindings, 'Platform' | 'Dimensions'>,
): Pick<AppContext, 'os' | 'screen'> {
  const { width, height } = rn.Dimensions.get('window');
  return {
    os: `${rn.Platform.OS} ${rn.Platform.Version}`,
    screen: `${Math.round(width)}x${Math.round(height)}`,
  };
}

export interface ReactScreenBindings {
  useEffect: (effect: () => undefined | (() => void), deps?: readonly unknown[]) => void;
  useRef: <T>(initialValue: T) => { current: T };
}

export function useBeaconScreenViews(
  client: BeaconClient,
  route: string | null,
  react: ReactScreenBindings,
): void {
  const lastScreen = react.useRef<string | null>(null);
  react.useEffect(() => {
    if (route === null || route === lastScreen.current) return undefined;
    client.screenView(route);
    lastScreen.current = route;
    return undefined;
  }, [client, route, react]);
}

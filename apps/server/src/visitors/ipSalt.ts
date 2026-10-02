import { createHmac, randomBytes } from 'node:crypto';
import { hashIp } from '@pi-innovations/beacon-sdk';
import type { BeaconConfig } from '../types';

export type IpMode = 'sha256' | 'daily-salt' | 'none';
export interface IpPolicy {
  storage(ip: string | undefined): string | undefined;
  rateKey(ip: string | undefined, legacyHashIPs?: boolean): string | undefined;
  stop(): void;
}
export interface IpPolicyDependencies {
  now?: () => number;
  salt?: () => Buffer;
  schedule?: (callback: () => void, delay: number) => () => void;
}
const DAY_MS = 86_400_000;

export function validateIpMode(value: unknown): IpMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'sha256' || value === 'daily-salt' || value === 'none') return value;
  throw new Error('[beacon] invalid ipMode');
}

export function createIpPolicy(
  config: Pick<BeaconConfig, 'ipMode' | 'hashIPs'>,
  deps: IpPolicyDependencies = {},
): IpPolicy {
  const explicit = validateIpMode(config.ipMode);
  if (explicit !== undefined && config.hashIPs === false) {
    throw new Error('[beacon] ipMode conflicts with hashIPs: false');
  }
  const mode = explicit ?? (config.hashIPs === false ? 'raw' : 'sha256');
  const now = deps.now ?? Date.now;
  const entropy = deps.salt ?? (() => randomBytes(32));
  const schedule =
    deps.schedule ??
    ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    });
  let day = Math.floor(now() / DAY_MS);
  let salt = mode === 'daily-salt' ? entropy() : undefined;
  let cancel: (() => void) | undefined;
  let stopped = false;
  const rotate = () => {
    const current = Math.floor(now() / DAY_MS);
    if (current !== day) {
      salt?.fill(0);
      salt = entropy();
      day = current;
    }
  };
  const arm = () => {
    const instant = now();
    cancel = schedule(
      () => {
        if (stopped) return;
        rotate();
        arm();
      },
      (Math.floor(instant / DAY_MS) + 1) * DAY_MS - instant,
    );
  };
  if (mode === 'daily-salt') arm();
  const storage = (ip: string | undefined): string | undefined => {
    if (stopped) throw new Error('[beacon] IP policy is stopped');
    if (mode === 'none') return undefined;
    if (mode === 'raw') return ip;
    if (mode === 'sha256') return hashIp(ip, true);
    rotate();
    return ip === undefined
      ? undefined
      : createHmac('sha256', salt as Buffer)
          .update(ip)
          .digest('hex');
  };
  return {
    storage,
    rateKey: (ip, legacyHashIPs) =>
      explicit === undefined && legacyHashIPs !== undefined
        ? hashIp(ip, legacyHashIPs)
        : mode === 'none'
          ? ip
          : storage(ip),
    stop: () => {
      stopped = true;
      cancel?.();
      salt?.fill(0);
      salt = undefined;
    },
  };
}

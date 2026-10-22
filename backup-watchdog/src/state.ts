/** KV 通知状态：读写与冷却计算 */

import { DEFAULT_COOLDOWN_HOURS } from "./config";
import type { Env, NotifyState } from "./types";

export async function readState(env: Env, key: string): Promise<NotifyState | null> {
  const raw = await env.STATE.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NotifyState;
  } catch {
    return null;
  }
}

export function writeState(env: Env, key: string, state: NotifyState): Promise<void> {
  return env.STATE.put(key, JSON.stringify(state));
}

export function cooldownMs(env: Env): number {
  const hours = Number(env.COOLDOWN_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_COOLDOWN_HOURS) * 3600_000;
}

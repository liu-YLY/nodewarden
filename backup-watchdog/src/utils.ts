/** 通用工具：响应、时间格式、带超时的请求、常量时间比较 */

import { CST_OFFSET_MS, REQUEST_TIMEOUT_MS } from "./config";
import type { Env } from "./types";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // 控制接口包含运行状态，禁止任何中间层缓存
  "cache-control": "no-store",
};

export function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

export function baseUrl(env: Env): string {
  return (env.NW_BASE_URL || "").trim().replace(/\/+$/, "");
}

/** 固定按东八区展示，避免依赖运行时的时区数据 */
export function formatTime(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "无";
  const local = new Date(ms + CST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(
    local.getUTCHours()
  )}:${pad(local.getUTCMinutes())}`;
}

export function hoursAgo(iso: string | null | undefined, now: number): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "";
  const hours = (now - ms) / 3600_000;
  if (hours < 1) return "（不到 1 小时前）";
  return `（约 ${hours.toFixed(1)} 小时前）`;
}

/** 所有出站请求走这里，统一加超时，避免上游挂起拖死 Cron */
export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 常量时间比较：先各自 SHA-256，再逐字节异或。
 * 避免通过响应时间差逐位探测口令。
 */
export async function secureEquals(expected: string, provided: string): Promise<boolean> {
  if (!expected || !provided) return false;
  const encoder = new TextEncoder();
  const [expectedDigest, providedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  const a = new Uint8Array(expectedDigest);
  const b = new Uint8Array(providedDigest);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

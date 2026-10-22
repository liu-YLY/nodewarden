/**
 * NodeWarden 备份看门狗
 *
 * 零侵入：不改 NodeWarden 任何代码，只以管理员身份轮询它的备份设置接口，
 * 发现「失败 / 过期未更新 / 从未成功 / 站点不可达」时推送到飞书群。
 *
 * 认证链路（与 Bitwarden 客户端一致）：
 *   POST /identity/connect/token  grant_type=client_credentials, scope=api
 *   GET  /api/admin/backup/settings  Authorization: Bearer <access_token>
 *
 * 状态去重：KV 里按目的地记录上次通知类型与时间，避免每 30 分钟炸一次群。
 */

const TOKEN_CACHE_KEY = "nw:access-token";
const UNREACHABLE_KEY = "global:unreachable";
const DEFAULT_COOLDOWN_HOURS = 6;
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Env {
  STATE: KVNamespaceLike;
  NW_BASE_URL: string;
  NW_CLIENT_ID: string;
  NW_CLIENT_SECRET: string;
  FEISHU_WEBHOOK: string;
  FEISHU_SECRET?: string;
  WATCHDOG_TOKEN: string;
  COOLDOWN_HOURS?: string;
  STALE_GRACE_HOURS?: string;
}

interface BackupRuntimeState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  lastUploadedFileName: string | null;
}

interface BackupDestination {
  id: string;
  name: string;
  type: string;
  schedule: {
    enabled: boolean;
    intervalHours: number;
    startTime: string;
    timezone: string;
  };
  runtime: BackupRuntimeState;
}

interface BackupSettings {
  destinations: BackupDestination[];
}

type HealthKind = "ok" | "skipped" | "failed" | "stale" | "never";

interface Health {
  kind: HealthKind;
  line: string;
}

interface NotifyState {
  kind: string;
  notifiedAt: number;
}

interface RunResult {
  checkedAt: string;
  destinations: Array<{ id: string; name: string; kind: HealthKind }>;
  notified: string[];
  error?: string;
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 飞书签名：以 `${timestamp}\n${secret}` 作为 HMAC 密钥，对空串做 HMAC-SHA256 后 Base64 */
async function feishuSign(secret: string): Promise<{ timestamp: string; sign: string }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array(0));
  return { timestamp, sign: base64(new Uint8Array(signature)) };
}

async function sendFeishu(env: Env, text: string): Promise<void> {
  const webhook = (env.FEISHU_WEBHOOK || "").trim();
  if (!webhook) throw new Error("FEISHU_WEBHOOK 未配置");

  const payload: Record<string, unknown> = {
    msg_type: "text",
    content: { text },
  };
  if (env.FEISHU_SECRET) {
    const { timestamp, sign } = await feishuSign(env.FEISHU_SECRET);
    payload.timestamp = timestamp;
    payload.sign = sign;
  }

  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  // 飞书业务失败通常也返回 HTTP 200，需要看 body 里的 code
  let code: number | null = null;
  try {
    const parsed = JSON.parse(body) as { code?: number; StatusCode?: number };
    code = typeof parsed.code === "number" ? parsed.code : parsed.StatusCode ?? null;
  } catch {
    code = null;
  }
  if (!response.ok || code !== 0) {
    throw new Error(`飞书返回异常：HTTP ${response.status} ${body}`);
  }
}

function baseUrl(env: Env): string {
  return (env.NW_BASE_URL || "").trim().replace(/\/+$/, "");
}

async function getAccessToken(env: Env, forceRefresh: boolean): Promise<string> {
  if (!forceRefresh) {
    const cached = await env.STATE.get(TOKEN_CACHE_KEY);
    if (cached) return cached;
  }

  const response = await fetch(`${baseUrl(env)}/identity/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: env.NW_CLIENT_ID,
      client_secret: env.NW_CLIENT_SECRET,
      scope: "api",
    }),
  });

  if (!response.ok) {
    throw new Error(`获取访问令牌失败：HTTP ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("获取访问令牌失败：响应里没有 access_token");

  // 令牌默认 2 小时，提前 10 分钟过期，避免边界情况
  const ttl = Math.max(120, Number(data.expires_in || 7200) - 600);
  await env.STATE.put(TOKEN_CACHE_KEY, data.access_token, { expirationTtl: ttl });
  return data.access_token;
}

async function fetchBackupSettings(env: Env): Promise<BackupSettings> {
  let token = await getAccessToken(env, false);
  let response = await fetch(`${baseUrl(env)}/api/admin/backup/settings`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });

  if (response.status === 401) {
    await env.STATE.delete(TOKEN_CACHE_KEY);
    token = await getAccessToken(env, true);
    response = await fetch(`${baseUrl(env)}/api/admin/backup/settings`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  }

  if (!response.ok) {
    throw new Error(`读取备份设置失败：HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as BackupSettings;
}

/** 固定按东八区展示，避免依赖运行时的时区数据 */
function formatTime(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "无";
  const local = new Date(ms + CST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(
    local.getUTCHours()
  )}:${pad(local.getUTCMinutes())}`;
}

function hoursAgo(iso: string | null | undefined, now: number): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "";
  const hours = (now - ms) / 3600_000;
  if (hours < 1) return "（不到 1 小时前）";
  return `（约 ${hours.toFixed(1)} 小时前）`;
}

function evaluateDestination(
  destination: BackupDestination,
  now: number,
  staleGraceHours: number
): Health {
  const schedule = destination.schedule;
  if (!schedule?.enabled) {
    return { kind: "skipped", line: "" };
  }

  const intervalHours = Number(schedule.intervalHours) > 0 ? Number(schedule.intervalHours) : 24;
  const graceHours = staleGraceHours > 0 ? staleGraceHours : Math.max(2, intervalHours * 0.25);
  const runtime = destination.runtime || ({} as BackupRuntimeState);

  const lastSuccessMs = runtime.lastSuccessAt ? Date.parse(runtime.lastSuccessAt) : NaN;
  const lastErrorMs = runtime.lastErrorAt ? Date.parse(runtime.lastErrorAt) : NaN;
  const hasSuccess = Number.isFinite(lastSuccessMs);

  // 最近一次记录是错误，且错误晚于（或没有）成功记录
  if (Number.isFinite(lastErrorMs) && (!hasSuccess || lastErrorMs > lastSuccessMs)) {
    const detail = runtime.lastErrorMessage ? `\n    原因：${runtime.lastErrorMessage}` : "";
    return {
      kind: "failed",
      line: `• ${destination.name}（${destination.type}）— 备份失败\n    最近尝试：${formatTime(
        runtime.lastAttemptAt
      )}\n    上次成功：${formatTime(runtime.lastSuccessAt)}${hasSuccess ? hoursAgo(runtime.lastSuccessAt, now) : ""}${detail}`,
    };
  }

  if (!hasSuccess) {
    return {
      kind: "never",
      line: `• ${destination.name}（${destination.type}）— 从未成功备份\n    最近尝试：${formatTime(
        runtime.lastAttemptAt
      )}`,
    };
  }

  const overdueMs = (intervalHours + graceHours) * 3600_000;
  if (now - lastSuccessMs > overdueMs) {
    return {
      kind: "stale",
      line: `• ${destination.name}（${destination.type}）— 备份已过期\n    上次成功：${formatTime(
        runtime.lastSuccessAt
      )}${hoursAgo(runtime.lastSuccessAt, now)}\n    计划间隔：每 ${intervalHours} 小时`,
    };
  }

  return { kind: "ok", line: "" };
}

async function readState(env: Env, key: string): Promise<NotifyState | null> {
  const raw = await env.STATE.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NotifyState;
  } catch {
    return null;
  }
}

async function writeState(env: Env, key: string, state: NotifyState): Promise<void> {
  await env.STATE.put(key, JSON.stringify(state));
}

function cooldownMs(env: Env): number {
  const hours = Number(env.COOLDOWN_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_COOLDOWN_HOURS) * 3600_000;
}

async function runCheck(env: Env): Promise<RunResult> {
  const now = Date.now();
  const result: RunResult = {
    checkedAt: new Date(now).toISOString(),
    destinations: [],
    notified: [],
  };

  let settings: BackupSettings;
  try {
    settings = await fetchBackupSettings(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = message;

    // 站点不可达单独去重，避免连续刷屏
    const previous = await readState(env, UNREACHABLE_KEY);
    const shouldNotify = !previous || now - previous.notifiedAt > cooldownMs(env);
    if (shouldNotify) {
      await sendFeishu(
        env,
        `【NodeWarden 监控异常】${formatTime(new Date(now).toISOString())}\n无法读取备份状态：${message}`
      );
      await writeState(env, UNREACHABLE_KEY, { kind: "unreachable", notifiedAt: now });
      result.notified.push("unreachable");
    }
    return result;
  }

  // 读取成功，若之前处于不可达状态则提示恢复
  const unreachable = await readState(env, UNREACHABLE_KEY);
  const lines: string[] = [];
  if (unreachable?.kind === "unreachable") {
    lines.push("✅ NodeWarden 备份状态已恢复可读取");
    await writeState(env, UNREACHABLE_KEY, { kind: "ok", notifiedAt: now });
    result.notified.push("unreachable-recovered");
  }

  const graceHours = Number(env.STALE_GRACE_HOURS) > 0 ? Number(env.STALE_GRACE_HOURS) : 0;
  const cooldown = cooldownMs(env);

  for (const destination of settings.destinations || []) {
    const health = evaluateDestination(destination, now, graceHours);
    result.destinations.push({ id: destination.id, name: destination.name, kind: health.kind });

    const key = `dest:${destination.id}`;
    const previous = await readState(env, key);

    if (health.kind === "ok" || health.kind === "skipped") {
      if (previous && previous.kind !== "ok") {
        lines.push(`✅ ${destination.name}（${destination.type}）— 已恢复正常`);
        result.notified.push(`${destination.id}:recovered`);
      }
      await writeState(env, key, { kind: "ok", notifiedAt: now });
      continue;
    }

    const repeatedSameIssue =
      previous && previous.kind === health.kind && now - previous.notifiedAt < cooldown;
    if (repeatedSameIssue) {
      // 保持原通知时间，不重置冷却
      await writeState(env, key, previous);
      continue;
    }

    lines.push(health.line);
    await writeState(env, key, { kind: health.kind, notifiedAt: now });
    result.notified.push(`${destination.id}:${health.kind}`);
  }

  if (lines.length > 0) {
    const header = `【NodeWarden 备份告警】${formatTime(new Date(now).toISOString())}\n\n`;
    await sendFeishu(env, header + lines.join("\n\n"));
  }

  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        name: "backup-watchdog",
        schedule: "每 30 分钟巡检一次",
        endpoints: {
          "/probe?token=***": "发一条飞书测试消息",
          "/run?token=***": "立即执行一次巡检（含通知）",
        },
      });
    }

    if (url.pathname !== "/probe" && url.pathname !== "/run") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const token = url.searchParams.get("token") || "";
    if (!env.WATCHDOG_TOKEN || token !== env.WATCHDOG_TOKEN) {
      return json({ ok: false, error: "invalid_token" }, 403);
    }

    try {
      if (url.pathname === "/probe") {
        await sendFeishu(
          env,
          `[NodeWarden] 通知通道探针\n如果这条消息出现在群里，说明飞书 webhook 可用。\n时间：${formatTime(
            new Date().toISOString()
          )}`
        );
        return json({ ok: true, message: "测试消息已发送" });
      }

      const result = await runCheck(env);
      return json({ ok: !result.error, ...result });
    } catch (error: unknown) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        500
      );
    }
  },

  async scheduled(
    _event: { scheduledTime: number; cron: string },
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<void> {
    ctx.waitUntil(
      runCheck(env).catch((error) => {
        console.error("watchdog run failed", error instanceof Error ? error.message : error);
      })
    );
  },
};

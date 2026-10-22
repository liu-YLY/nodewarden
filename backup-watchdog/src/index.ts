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
const FEISHU_TOKEN_KEY = "feishu:tenant-token";
const UNREACHABLE_KEY = "global:unreachable";
const DEFAULT_COOLDOWN_HOURS = 6;
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";

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
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  FEISHU_CHAT_ID: string;
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

type AlertLevel = "error" | "warning" | "ok";

/** 一条告警/恢复条目，最终渲染成卡片里的一段 */
interface AlertItem {
  level: AlertLevel;
  title: string;
  lines: string[];
}

interface Health {
  kind: HealthKind;
  alert?: AlertItem;
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

/** 应用机器人：tenant_access_token 有效期 2 小时，缓存到 KV，提前 10 分钟过期 */
async function getFeishuToken(env: Env, forceRefresh: boolean): Promise<string> {
  if (!forceRefresh) {
    const cached = await env.STATE.get(FEISHU_TOKEN_KEY);
    if (cached) return cached;
  }

  const response = await fetch(FEISHU_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data = (await response.json()) as {
    code?: number;
    msg?: string;
    expire?: number;
    tenant_access_token?: string;
  };

  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`获取飞书令牌失败：HTTP ${response.status} ${JSON.stringify(data)}`);
  }

  const ttl = Math.max(120, Number(data.expire || 7200) - 600);
  await env.STATE.put(FEISHU_TOKEN_KEY, data.tenant_access_token, { expirationTtl: ttl });
  return data.tenant_access_token;
}

async function sendFeishuMessage(
  token: string,
  chatId: string,
  msgType: string,
  content: string
): Promise<{ code?: number; msg?: string }> {
  const response = await fetch(FEISHU_MESSAGE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    // 飞书要求 content 是字符串化的 JSON，不是嵌套对象
    body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
  });
  return (await response.json()) as { code?: number; msg?: string };
}

/** 把若干条告警渲染成一张飞书卡片 */
function buildCard(env: Env, items: AlertItem[]): Record<string, unknown> {
  const hasError = items.some((item) => item.level === "error");
  const hasWarning = items.some((item) => item.level === "warning");
  const allOk = items.every((item) => item.level === "ok");

  const template = hasError ? "red" : hasWarning ? "orange" : allOk ? "green" : "blue";
  const title = hasError
    ? "NodeWarden 备份告警"
    : hasWarning
      ? "NodeWarden 备份提醒"
      : allOk
        ? "NodeWarden 备份恢复"
        : "NodeWarden 备份状态";

  const elements: Array<Record<string, unknown>> = [];
  items.forEach((item, index) => {
    if (index > 0) elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: [`**${item.title}**`, ...item.lines].join("\n"),
      },
    });
  });

  elements.push({ tag: "hr" });
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: `巡检时间 ${formatTime(new Date().toISOString())}（Asia/Shanghai）`,
      },
    ],
  });
  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "打开 NodeWarden" },
        type: "primary",
        url: baseUrl(env),
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: title } },
    elements,
  };
}

async function sendFeishu(env: Env, items: AlertItem[]): Promise<void> {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_CHAT_ID) {
    throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID 未配置");
  }

  const card = JSON.stringify(buildCard(env, items));
  let token = await getFeishuToken(env, false);
  let result = await sendFeishuMessage(token, env.FEISHU_CHAT_ID, "interactive", card);

  // 令牌失效时刷新重试一次
  if (result.code !== 0 && [99991661, 99991663, 99991668].includes(Number(result.code))) {
    await env.STATE.delete(FEISHU_TOKEN_KEY);
    token = await getFeishuToken(env, true);
    result = await sendFeishuMessage(token, env.FEISHU_CHAT_ID, "interactive", card);
  }

  if (result.code !== 0) {
    throw new Error(`飞书发消息失败：code=${result.code} msg=${result.msg || ""}`);
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
  const scheduleEnabled = Boolean(schedule?.enabled);

  const intervalHours = Number(schedule?.intervalHours) > 0 ? Number(schedule.intervalHours) : 24;
  const graceHours = staleGraceHours > 0 ? staleGraceHours : Math.max(2, intervalHours * 0.25);
  const runtime = destination.runtime || ({} as BackupRuntimeState);

  const lastSuccessMs = runtime.lastSuccessAt ? Date.parse(runtime.lastSuccessAt) : NaN;
  const lastErrorMs = runtime.lastErrorAt ? Date.parse(runtime.lastErrorAt) : NaN;
  const hasSuccess = Number.isFinite(lastSuccessMs);
  const caption = scheduleEnabled
    ? `存储类型 ${destination.type} · 计划间隔 每 ${intervalHours} 小时`
    : `存储类型 ${destination.type} · 未开启定时备份`;

  // 无论定时是否开启，手动执行失败同样会写 lastErrorAt，都要告警
  if (Number.isFinite(lastErrorMs) && (!hasSuccess || lastErrorMs > lastSuccessMs)) {
    return {
      kind: "failed",
      alert: {
        level: "error",
        title: `${destination.name} · 备份失败`,
        lines: [
          caption,
          `上次成功：${formatTime(runtime.lastSuccessAt)}`,
          `最近尝试：${formatTime(runtime.lastAttemptAt)}`,
          ...(runtime.lastErrorMessage ? [`失败原因：${runtime.lastErrorMessage}`] : []),
        ],
      },
    };
  }

  // 未开启定时的目的地只关心失败，不判断“过期”“从未成功”
  if (!scheduleEnabled) {
    return { kind: "skipped" };
  }

  if (!hasSuccess) {
    return {
      kind: "never",
      alert: {
        level: "warning",
        title: `${destination.name} · 从未成功备份`,
        lines: [caption, `最近尝试：${formatTime(runtime.lastAttemptAt)}`],
      },
    };
  }

  const overdueMs = (intervalHours + graceHours) * 3600_000;
  if (now - lastSuccessMs > overdueMs) {
    return {
      kind: "stale",
      alert: {
        level: "warning",
        title: `${destination.name} · 备份已过期`,
        lines: [
          caption,
          `上次成功：${formatTime(runtime.lastSuccessAt)}${hoursAgo(runtime.lastSuccessAt, now)}`,
          `已超过 ${intervalHours + graceHours} 小时的预期周期`,
        ],
      },
    };
  }

  return { kind: "ok" };
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
      await sendFeishu(env, [
        {
          level: "error",
          title: "无法读取 NodeWarden 备份状态",
          lines: [`地址：${baseUrl(env)}`, `错误：${message}`],
        },
      ]);
      await writeState(env, UNREACHABLE_KEY, { kind: "unreachable", notifiedAt: now });
      result.notified.push("unreachable");
    }
    return result;
  }

  // 读取成功，若之前处于不可达状态则提示恢复
  const unreachable = await readState(env, UNREACHABLE_KEY);
  const alerts: AlertItem[] = [];
  if (unreachable?.kind === "unreachable") {
    alerts.push({ level: "ok", title: "NodeWarden 状态已恢复可读取", lines: [`地址：${baseUrl(env)}`] });
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
        alerts.push({
          level: "ok",
          title: `${destination.name} · 已恢复正常`,
          lines: [
            `存储类型 ${destination.type}`,
            `上次成功：${formatTime(destination.runtime?.lastSuccessAt)}`,
          ],
        });
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

    if (health.alert) alerts.push(health.alert);
    await writeState(env, key, { kind: health.kind, notifiedAt: now });
    result.notified.push(`${destination.id}:${health.kind}`);
  }

  if (alerts.length > 0) {
    await sendFeishu(env, alerts);
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
        await sendFeishu(env, [
          {
            level: "ok",
            title: "通知通道探针",
            lines: ["如果你看到这张卡片，说明 NodeWarden 的飞书通知链路已经接通。", "这条消息由手动触发，不代表备份状态。"],
          },
        ]);
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

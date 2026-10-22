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

import { REQUIRED_ENV_KEYS } from "./config";
import { sendFeishu } from "./feishu";
import type { Env } from "./types";
import { json, secureEquals } from "./utils";
import { runCheck } from "./watchdog";

interface ScheduledEventLike {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

function missingConfigKeys(env: Env): string[] {
  const record = env as unknown as Record<string, unknown>;
  return REQUIRED_ENV_KEYS.filter((key) => !String(record[key] || "").trim());
}

/** 优先读 Authorization: Bearer，兼容旧的 ?token= 形式 */
function readToken(request: Request, url: URL): string {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return url.searchParams.get("token") || "";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        name: "backup-watchdog",
        schedule: "每 30 分钟巡检一次",
        auth: "Authorization: Bearer <WATCHDOG_TOKEN>（兼容 ?token=）",
        endpoints: {
          "/probe": "发一条飞书测试卡片",
          "/run": "立即执行一次巡检（含通知）",
        },
      });
    }

    if (url.pathname !== "/probe" && url.pathname !== "/run") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    // 只读端点，其余方法直接拒绝，减少无谓执行面
    if (request.method !== "GET") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    const missing = missingConfigKeys(env);
    if (missing.length > 0) {
      return json({ ok: false, error: "missing_config", missing }, 503);
    }

    const token = readToken(request, url);
    if (!(await secureEquals(env.WATCHDOG_TOKEN, token))) {
      return json({ ok: false, error: "invalid_token" }, 403);
    }

    try {
      if (url.pathname === "/probe") {
        await sendFeishu(env, [
          {
            level: "ok",
            title: "通知通道探针",
            lines: [
              "如果你看到这张卡片，说明 NodeWarden 的飞书通知链路已经接通。",
              "这条消息由手动触发，不代表备份状态。",
            ],
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
    _event: ScheduledEventLike,
    env: Env,
    ctx: ExecutionContextLike
  ): Promise<void> {
    ctx.waitUntil(
      runCheck(env).catch((error) => {
        console.error("watchdog run failed", error instanceof Error ? error.message : error);
      })
    );
  },
};

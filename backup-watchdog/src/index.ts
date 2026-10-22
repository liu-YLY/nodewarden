/**
 * 通知通道探针（飞书版）
 *
 * 目的只有一个：验证这条通道在当前环境下能不能真的把消息送到。
 * 访问 /probe?token=*** 触发一条测试消息，并把飞书返回的原始响应吐出来。
 *
 * 为什么用飞书自定义机器人：
 * - 免费，无需域名、无需邮件计划
 * - 只需一个 webhook 地址，可用签名校验兜底
 */

interface Env {
  FEISHU_WEBHOOK: string;
  // 机器人开启“签名校验”后需要，未开启可留空
  FEISHU_SECRET?: string;
  PROBE_TOKEN: string;
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

/**
 * 飞书签名：以 `${timestamp}\n${secret}` 作为 HMAC 密钥，对空串做 HMAC-SHA256，
 * 再 Base64 编码。校验时间戳与当前时间相差不超过 1 小时。
 */
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        name: "backup-watchdog probe",
        usage: "GET /probe?token=<PROBE_TOKEN>",
        webhookConfigured: Boolean(env.FEISHU_WEBHOOK && !env.FEISHU_WEBHOOK.includes("请替换")),
      });
    }

    if (url.pathname !== "/probe") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    // 简单口令，避免端点被当成任意发消息的入口
    const token = url.searchParams.get("token") || "";
    if (!env.PROBE_TOKEN || token !== env.PROBE_TOKEN) {
      return json({ ok: false, error: "invalid_token" }, 403);
    }

    const webhook = (env.FEISHU_WEBHOOK || "").trim();
    if (!webhook || webhook.includes("请替换")) {
      return json({ ok: false, error: "FEISHU_WEBHOOK 未配置" }, 400);
    }

    const payload: Record<string, unknown> = {
      msg_type: "text",
      content: {
        text: `[NodeWarden] 通知通道探针\n\n如果这条消息出现在群里，说明飞书 webhook 可用。\n时间：${new Date().toISOString()}`,
      },
    };

    // 开启签名校验时必须带 timestamp + sign
    if (env.FEISHU_SECRET) {
      const { timestamp, sign } = await feishuSign(env.FEISHU_SECRET);
      payload.timestamp = timestamp;
      payload.sign = sign;
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
      const body = await response.text();

      // 飞书即使业务失败也常返回 200，所以要看 body 里的 code
      return json({
        ok: response.ok && body.includes('"code":0'),
        httpStatus: response.status,
        feishuResponse: body,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - startedAt,
        },
        500
      );
    }
  },
};

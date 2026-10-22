/**
 * 邮件发送能力探针
 *
 * 目的只有一个：在当前 Cloudflare 账号 + 当前计划下，验证 send_email 绑定能否真的发出邮件，
 * 并把平台返回的错误码原样吐出来。
 *
 * 访问 /probe?token=*** 触发一封测试邮件。
 * - 成功：返回 ok=true 与 messageId，说明这条路 $0 可用
 * - 失败：返回 ok=false 与 Cloudflare 的错误码，据此判断卡在哪一步
 */

interface EmailSendResult {
  messageId: string;
}

interface EmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<EmailSendResult>;
}

interface Env {
  EMAIL: EmailBinding;
  MAIL_FROM: string;
  MAIL_TO: string;
  PROBE_TOKEN: string;
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        name: "backup-watchdog probe",
        usage: "GET /probe?token=<PROBE_TOKEN>[&to=<已验证地址>]",
        mailFrom: env.MAIL_FROM || null,
        mailTo: env.MAIL_TO || null,
      });
    }

    if (url.pathname !== "/probe") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    // 简单口令，避免端点被人当成免费发信机
    const token = url.searchParams.get("token") || "";
    if (!env.PROBE_TOKEN || token !== env.PROBE_TOKEN) {
      return json({ ok: false, error: "invalid_token" }, 403);
    }

    const from = (env.MAIL_FROM || "").trim();
    const to = (url.searchParams.get("to") || env.MAIL_TO || "").trim();
    if (!from || !to) {
      return json({ ok: false, error: "MAIL_FROM / MAIL_TO 未配置" }, 400);
    }

    const startedAt = Date.now();
    try {
      const result = await env.EMAIL.send({
        to,
        from,
        subject: "[NodeWarden] 邮件通道探针",
        text: `这是一封来自 backup-watchdog 的测试邮件。\n\n如果收到这封信，说明 Cloudflare Email 绑定在你当前计划下可用。\n时间：${new Date().toISOString()}`,
        html: `<p>这是一封来自 <strong>backup-watchdog</strong> 的测试邮件。</p>
<p>如果收到这封信，说明 Cloudflare Email 绑定在你当前计划下可用。</p>
<p>时间：${new Date().toISOString()}</p>`,
      });

      return json({
        ok: true,
        messageId: result?.messageId ?? null,
        from,
        to,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      // Cloudflare 的错误带有 code 字段，是判断卡点的关键信息
      const err = error as { code?: string; message?: string };
      return json(
        {
          ok: false,
          code: err?.code ?? null,
          message: err?.message ?? String(error),
          from,
          to,
          elapsedMs: Date.now() - startedAt,
        },
        500
      );
    }
  },
};

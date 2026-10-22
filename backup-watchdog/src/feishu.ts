/** 飞书应用机器人：令牌缓存 + 卡片消息渲染与发送 */

import {
  FEISHU_MESSAGE_URL,
  FEISHU_TOKEN_ERROR_CODES,
  FEISHU_TOKEN_URL,
  FEISHU_TOKEN_KEY,
} from "./config";
import type { AlertItem, Env, FeishuMessageResponse, FeishuTokenResponse } from "./types";
import { baseUrl, fetchWithTimeout, formatTime } from "./utils";

/** tenant_access_token 有效期 2 小时，缓存到 KV，提前 10 分钟过期 */
async function getFeishuToken(env: Env, forceRefresh: boolean): Promise<string> {
  if (!forceRefresh) {
    const cached = await env.STATE.get(FEISHU_TOKEN_KEY);
    if (cached) return cached;
  }

  const response = await fetchWithTimeout(FEISHU_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data = (await response.json()) as FeishuTokenResponse;

  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`获取飞书令牌失败：HTTP ${response.status} ${JSON.stringify(data)}`);
  }

  const ttl = Math.max(120, Number(data.expire || 7200) - 600);
  await env.STATE.put(FEISHU_TOKEN_KEY, data.tenant_access_token, { expirationTtl: ttl });
  return data.tenant_access_token;
}

function postMessage(
  token: string,
  chatId: string,
  msgType: string,
  content: string
): Promise<FeishuMessageResponse> {
  return fetchWithTimeout(FEISHU_MESSAGE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    // 飞书要求 content 是字符串化的 JSON，不是嵌套对象
    body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
  }).then((response) => response.json() as Promise<FeishuMessageResponse>);
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

export async function sendFeishu(env: Env, items: AlertItem[]): Promise<void> {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_CHAT_ID) {
    throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID 未配置");
  }
  if (items.length === 0) return;

  const card = JSON.stringify(buildCard(env, items));
  let token = await getFeishuToken(env, false);
  let result = await postMessage(token, env.FEISHU_CHAT_ID, "interactive", card);

  // 令牌失效时刷新重试一次
  if (result.code !== 0 && FEISHU_TOKEN_ERROR_CODES.includes(Number(result.code))) {
    await env.STATE.delete(FEISHU_TOKEN_KEY);
    token = await getFeishuToken(env, true);
    result = await postMessage(token, env.FEISHU_CHAT_ID, "interactive", card);
  }

  if (result.code !== 0) {
    throw new Error(`飞书发消息失败：code=${result.code} msg=${result.msg || ""}`);
  }
}

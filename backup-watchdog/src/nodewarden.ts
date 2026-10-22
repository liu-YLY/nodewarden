/** NodeWarden 管理端：client_credentials 换令牌 + 读取备份设置 */

import { TOKEN_CACHE_KEY } from "./config";
import type { BackupSettings, Env } from "./types";
import { baseUrl, fetchWithTimeout } from "./utils";

async function getAccessToken(env: Env, forceRefresh: boolean): Promise<string> {
  if (!forceRefresh) {
    const cached = await env.STATE.get(TOKEN_CACHE_KEY);
    if (cached) return cached;
  }

  const response = await fetchWithTimeout(`${baseUrl(env)}/identity/connect/token`, {
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

function requestSettings(token: string, env: Env): Promise<Response> {
  return fetchWithTimeout(`${baseUrl(env)}/api/admin/backup/settings`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
}

export async function fetchBackupSettings(env: Env): Promise<BackupSettings> {
  let token = await getAccessToken(env, false);
  let response = await requestSettings(token, env);

  // 令牌可能被服务端提前作废，刷新后重试一次
  if (response.status === 401) {
    await env.STATE.delete(TOKEN_CACHE_KEY);
    token = await getAccessToken(env, true);
    response = await requestSettings(token, env);
  }

  if (!response.ok) {
    throw new Error(`读取备份设置失败：HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as BackupSettings;
}

/** 常量集中管理，避免散落在各模块里 */

export const TOKEN_CACHE_KEY = "nw:access-token";
export const FEISHU_TOKEN_KEY = "feishu:tenant-token";
export const UNREACHABLE_KEY = "global:unreachable";

export const DEFAULT_COOLDOWN_HOURS = 6;
export const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 外部请求统一超时，避免某个上游卡住整个 Cron 周期 */
export const REQUEST_TIMEOUT_MS = 10_000;

export const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
export const FEISHU_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";

/** 飞书令牌失效类错误码，命中后刷新令牌重试一次 */
export const FEISHU_TOKEN_ERROR_CODES = [99991661, 99991663, 99991668];

/** 运行时必需配置，缺失时直接返回 503 而不是发一条内容空洞的告警 */
export const REQUIRED_ENV_KEYS = [
  "NW_BASE_URL",
  "NW_CLIENT_ID",
  "NW_CLIENT_SECRET",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_CHAT_ID",
  "WATCHDOG_TOKEN",
] as const;

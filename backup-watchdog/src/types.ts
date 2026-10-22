/** 所有跨模块共享的类型定义 */

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
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

export interface BackupRuntimeState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  lastUploadedFileName: string | null;
}

export interface BackupScheduleConfig {
  enabled: boolean;
  intervalHours: number;
  startTime: string;
  timezone: string;
}

export interface BackupDestination {
  id: string;
  name: string;
  type: string;
  schedule: BackupScheduleConfig;
  runtime: BackupRuntimeState;
}

export interface BackupSettings {
  destinations: BackupDestination[];
}

export type HealthKind = "ok" | "skipped" | "failed" | "stale" | "never";

export type AlertLevel = "error" | "warning" | "ok";

/** 一条告警/恢复条目，最终渲染成卡片里的一段 */
export interface AlertItem {
  level: AlertLevel;
  title: string;
  lines: string[];
}

export interface Health {
  kind: HealthKind;
  alert?: AlertItem;
}

export interface NotifyState {
  kind: string;
  notifiedAt: number;
}

export interface RunResult {
  checkedAt: string;
  destinations: Array<{ id: string; name: string; kind: HealthKind }>;
  notified: string[];
  error?: string;
}

export interface FeishuTokenResponse {
  code?: number;
  msg?: string;
  expire?: number;
  tenant_access_token?: string;
}

export interface FeishuMessageResponse {
  code?: number;
  msg?: string;
}

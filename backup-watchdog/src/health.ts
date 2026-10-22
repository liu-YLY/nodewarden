/** 备份健康判定：纯函数，不产生副作用，便于单独推演和测试 */

import type { BackupDestination, BackupRuntimeState, Health } from "./types";
import { formatTime, hoursAgo } from "./utils";

export function evaluateDestination(
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

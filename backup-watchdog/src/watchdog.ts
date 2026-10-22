/** 巡检主流程：读取状态 → 判定 → 聚合告警 → 发送 → 落状态 */

import { UNREACHABLE_KEY } from "./config";
import { sendFeishu } from "./feishu";
import { evaluateDestination } from "./health";
import { fetchBackupSettings } from "./nodewarden";
import { cooldownMs, readState, writeState } from "./state";
import type { AlertItem, BackupSettings, Env, NotifyState, RunResult } from "./types";
import { baseUrl, formatTime } from "./utils";

interface PendingWrite {
  key: string;
  state: NotifyState;
}

export async function runCheck(env: Env): Promise<RunResult> {
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
    if (!previous || now - previous.notifiedAt > cooldownMs(env)) {
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

  const destinations = settings.destinations || [];

  // 一次并行读完所有状态，避免按目的地串行往返
  const [unreachable, ...destinationStates] = await Promise.all([
    readState(env, UNREACHABLE_KEY),
    ...destinations.map((destination) => readState(env, `dest:${destination.id}`)),
  ]);

  const alerts: AlertItem[] = [];
  const pendingWrites: PendingWrite[] = [];

  // 读取成功，若之前处于不可达状态则提示恢复
  if (unreachable?.kind === "unreachable") {
    alerts.push({
      level: "ok",
      title: "NodeWarden 状态已恢复可读取",
      lines: [`地址：${baseUrl(env)}`],
    });
    pendingWrites.push({ key: UNREACHABLE_KEY, state: { kind: "ok", notifiedAt: now } });
    result.notified.push("unreachable-recovered");
  }

  const graceHours = Number(env.STALE_GRACE_HOURS) > 0 ? Number(env.STALE_GRACE_HOURS) : 0;
  const cooldown = cooldownMs(env);

  destinations.forEach((destination, index) => {
    const health = evaluateDestination(destination, now, graceHours);
    result.destinations.push({ id: destination.id, name: destination.name, kind: health.kind });

    const key = `dest:${destination.id}`;
    const previous = destinationStates[index];

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
      // 已经是 ok 就不重复写，减少 KV 写入
      if (!previous || previous.kind !== "ok") {
        pendingWrites.push({ key, state: { kind: "ok", notifiedAt: now } });
      }
      return;
    }

    const repeatedSameIssue =
      previous && previous.kind === health.kind && now - previous.notifiedAt < cooldown;
    if (repeatedSameIssue) return;

    if (health.alert) alerts.push(health.alert);
    pendingWrites.push({ key, state: { kind: health.kind, notifiedAt: now } });
    result.notified.push(`${destination.id}:${health.kind}`);
  });

  // 先发送再落状态：发送失败时下个周期还能重试，不会静默吞掉告警
  if (alerts.length > 0) {
    await sendFeishu(env, alerts);
  }
  if (pendingWrites.length > 0) {
    await Promise.all(pendingWrites.map((item) => writeState(env, item.key, item.state)));
  }

  return result;
}

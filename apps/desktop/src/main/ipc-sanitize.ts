import type { DesktopExecutorInbound, DesktopNotification } from "../shared/desktop-bridge";

// 渲染层 IPC 载荷的校验（纯函数，不 import electron，供 ipc.ts 与单测共用）。

const MAX_ID = 128;
const MAX_TITLE = 200;
const MAX_BODY = 1000;
/** 中心签发的会话 token 是短字符串；超长视为形状不对，丢弃而不是截断（截断会存下一个永远无效的 token）。 */
const MAX_TOKEN = 4096;

/** 渲染层来的载荷只当数据：字段类型与长度都校验，超长截断，形状不对丢弃。 */
export function sanitizeNotification(payload: unknown): DesktopNotification | null {
  if (!payload || typeof payload !== "object") return null;
  const { workspaceId, title, body, notificationId, taskId } = payload as Record<string, unknown>;
  if (typeof workspaceId !== "string" || typeof title !== "string" || typeof body !== "string") return null;
  if (!workspaceId || !title) return null;
  if (notificationId !== undefined && (typeof notificationId !== "string" || !notificationId || notificationId.length > MAX_ID)) return null;
  if (taskId !== undefined && (typeof taskId !== "string" || !taskId || taskId.length > MAX_ID)) return null;
  return { workspaceId: workspaceId.slice(0, MAX_ID), title: title.slice(0, MAX_TITLE), body: body.slice(0, MAX_BODY),
    ...(typeof notificationId === "string" ? { notificationId } : {}), ...(typeof taskId === "string" ? { taskId } : {}) };
}

export function sanitizeBadgeCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isFinite(payload)) return null;
  return Math.min(999, Math.max(0, Math.floor(payload)));
}

/** 会话 token：非空、不超长、不含控制字符/空白的字符串才落盘。 */
export function sanitizeSessionToken(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  if (payload.length === 0 || payload.length > MAX_TOKEN) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(payload)) return null;
  return payload;
}

// ===== executor（plan 116）=====
//
// 这批载荷的源头是 daemon 经 device 通道推来的帧，由渲染层转进主进程。渲染层是同一个 app 因而可信，
// 但帧的内容不是我们自己造的，照样按「只当数据」处理：类型不对丢弃，超长截断。
// 唯一不能截断的是 runId——截出来的是一个指向别处的合法 id，比丢弃更危险。

const MAX_RUN_ID = 128;
const MAX_PROMPT = 64 * 1024;
const MAX_PATH = 4096;
const MAX_REASON = 2000;
const MAX_PROVIDER = 64;
const MAX_MODEL_ID = 200;
/** 各家 provider 的 key 长度不一，给个宽上限；超了视为形状不对 */
const MAX_API_KEY = 4096;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return value;
}

export function sanitizeExecutorInbound(payload: unknown): DesktopExecutorInbound | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  switch (record.kind) {
    case "assign": {
      const runId = boundedString(record.runId, MAX_RUN_ID);
      const workspaceRoot = boundedString(record.workspaceRoot, MAX_PATH);
      const workspaceId = boundedString(record.workspaceId, MAX_ID);
      if (!runId || !workspaceRoot || !workspaceId) return null;
      if (typeof record.prompt !== "string" || record.prompt.length === 0) return null;
      // 必须是绝对路径：相对路径会被解析到主进程的 cwd 上，那是 app 的目录而不是用户的仓库
      if (!workspaceRoot.startsWith("/")) return null;
      return {
        kind: "assign",
        runId,
        prompt: record.prompt.slice(0, MAX_PROMPT),
        write: record.write === true,
        workspaceId,
        workspaceRoot,
        submittedAt: typeof record.submittedAt === "number" && Number.isFinite(record.submittedAt) ? record.submittedAt : 0,
      };
    }
    case "cancel":
    case "ack": {
      const runId = boundedString(record.runId, MAX_RUN_ID);
      return runId ? { kind: record.kind, runId } : null;
    }
    case "registered": {
      const ids = Array.isArray(record.reconcileRunIds) ? record.reconcileRunIds : [];
      return {
        kind: "registered",
        ok: record.ok === true,
        error: typeof record.error === "string" ? record.error.slice(0, MAX_REASON) : undefined,
        reconcileRunIds: ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_RUN_ID),
      };
    }
    default:
      return null;
  }
}

/** 设置面的两项。空串合法，等于清空配置。 */
export function sanitizeExecutorModel(payload: unknown): { provider: string; modelId: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const { provider, modelId } = payload as Record<string, unknown>;
  if (typeof provider !== "string" || typeof modelId !== "string") return null;
  if (provider.length > MAX_PROVIDER || modelId.length > MAX_MODEL_ID) return null;
  return { provider, modelId };
}

/** API key：空串 = 清除。trim 交给配置层做（贴进来的 key 常带换行）。 */
export function sanitizeExecutorApiKey(payload: unknown): string | null {
  if (typeof payload !== "string" || payload.length > MAX_API_KEY) return null;
  return payload;
}

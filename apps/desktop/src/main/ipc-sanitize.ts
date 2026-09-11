import type { DesktopNotification } from "../shared/desktop-bridge";

// 渲染层 IPC 载荷的校验（纯函数，不 import electron，供 ipc.ts 与单测共用）。

const MAX_ID = 128;
const MAX_TITLE = 200;
const MAX_BODY = 1000;

/** 渲染层来的载荷只当数据：字段类型与长度都校验，超长截断，形状不对丢弃。 */
export function sanitizeNotification(payload: unknown): DesktopNotification | null {
  if (!payload || typeof payload !== "object") return null;
  const { workspaceId, title, body } = payload as Record<string, unknown>;
  if (typeof workspaceId !== "string" || typeof title !== "string" || typeof body !== "string") return null;
  if (!workspaceId || !title) return null;
  return { workspaceId: workspaceId.slice(0, MAX_ID), title: title.slice(0, MAX_TITLE), body: body.slice(0, MAX_BODY) };
}

export function sanitizeBadgeCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isFinite(payload)) return null;
  return Math.min(999, Math.max(0, Math.floor(payload)));
}

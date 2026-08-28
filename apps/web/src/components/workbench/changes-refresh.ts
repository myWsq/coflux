export type ChangesRefreshObservation = {
  active: boolean;
  workspaceId: string;
  defaultBranch: string;
  additions: number;
  deletions: number;
  /** 用户点击刷新时递增；让“内容变了但行数统计没变”也有显式失效入口。 */
  manualRevision: number;
};

/**
 * 变更内容没有来自 daemon 的内容 revision，不能把 additions/deletions 当缓存版本。
 * 行数只用于活跃期间的快速自动刷新；重新进入 tab 或手动刷新都必须重新取正文。
 */
export function shouldRefreshChanges(
  previous: ChangesRefreshObservation | null,
  current: ChangesRefreshObservation,
): boolean {
  if (!current.active) return false;
  if (!previous) return true;
  return (
    !previous.active ||
    previous.workspaceId !== current.workspaceId ||
    previous.defaultBranch !== current.defaultBranch ||
    previous.additions !== current.additions ||
    previous.deletions !== current.deletions ||
    previous.manualRevision !== current.manualRevision
  );
}

/**
 * 通用"请求-响应关联"登记表。
 *
 * 服务器向 daemon 发出异步请求（project.validate / worktree.add / session.replay），
 * 用 requestId 关联其回应。统一管理超时、按 daemon 掉线清理、按 client 断开清理，
 * 避免在 hub 里到处手搓重复的 timer/Map 代码。
 */
type Timeout = ReturnType<typeof setTimeout>;

export interface Pending<C, D> {
  requestId: string;
  daemonId: string;
  client: C;
  data: D;
}

export class PendingRegistry<C, D> {
  private map = new Map<string, Pending<C, D> & { timer: Timeout }>();

  constructor(private timeoutMs: number) {}

  register(requestId: string, daemonId: string, client: C, data: D, onTimeout: (p: Pending<C, D>) => void, timeoutMs?: number): void {
    const timer = setTimeout(() => {
      this.map.delete(requestId);
      onTimeout({ requestId, daemonId, client, data });
    }, timeoutMs ?? this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    this.map.set(requestId, { requestId, daemonId, client, data, timer });
  }

  /** 只读取不删除（用于校验归属后再 take） */
  get(requestId: string): Pending<C, D> | undefined {
    return this.map.get(requestId);
  }

  /** 取出并删除（清除超时定时器） */
  take(requestId: string): Pending<C, D> | undefined {
    const e = this.map.get(requestId);
    if (!e) return undefined;
    clearTimeout(e.timer);
    this.map.delete(requestId);
    return e;
  }

  removeByDaemon(daemonId: string, cb?: (p: Pending<C, D>) => void): void {
    for (const [id, e] of this.map) {
      if (e.daemonId !== daemonId) continue;
      clearTimeout(e.timer);
      this.map.delete(id);
      cb?.(e);
    }
  }

  removeByClient(client: C, cb?: (p: Pending<C, D>) => void): void {
    for (const [id, e] of this.map) {
      if (e.client !== client) continue;
      clearTimeout(e.timer);
      this.map.delete(id);
      cb?.(e);
    }
  }

  clear(): void {
    for (const e of this.map.values()) clearTimeout(e.timer);
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

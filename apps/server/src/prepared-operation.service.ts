/**
 * durable prepared operation 的投递协调器。
 *
 * 这里只管理“准备记录 → daemon 安装 → client 得到可执行帧”这一段易失运行时状态：
 * 重试定时器、等待安装确认的 client，以及 daemon 重连后的恢复投递。业务结果如何落库、
 * 如何广播仍由 Hub 的收敛事务负责，避免把 transport 生命周期和领域副作用揉成一个对象。
 *
 * plan 091 起中心自己也能做发起方（MCP 写 tools）：记录 metadata 带 `initiator: "server"`，
 * 安装确认后不是把帧交给 client，而是由中心经控制 WS 下发 PreparedDeviceOperationExecute；
 * server 重启后 restore 重装模板→daemon 再次 installed→再次 Execute（worker 侧幂等）。
 * 超时/取消对 server 发起的记录经 host.failServerOperation 唤醒 Hub 的完成原语，而不是
 * 发给不存在的 client。浏览器分支的行为零变化。
 */
import {
  create,
  DEVICE_PROTOCOL_VERSION,
  DeviceEnvelopeSchema,
  encodeDeviceEnvelope,
  type AccountId,
  type DaemonId,
  type DeviceEnvelopePayload,
  type ServerToClientPayload,
  type ServerToDaemonPayload,
} from "@coflux/protocol";
import { createLogger } from "@coflux/core";
import { config } from "./config.js";
import type { NewPreparedOperation, PreparedOperationRecord, Store } from "./store.js";

const log = createLogger("prepared-operation");

export const MAX_PREPARED_FRAME_BYTES = 1024 * 1024;
const MAX_ACTIVE_PREPARED_PER_DAEMON = 128;
const INSTALL_RETRY_MS = 1_000;
const MAX_RETRY_QUERY_FAILURES = 5;

function isInstallableState(state: PreparedOperationRecord["state"]): boolean {
  return state === "pending_install" || state === "installed" || state === "install_failed";
}

/** metadata 里的发起方标记（plan 091）；带它的记录由中心自己触发执行、结果通知完成原语。 */
export const SERVER_INITIATOR = "server";

/** server 发起（plan 091）：metadata 是 JSON 文本，解析失败按 client 发起处理（不会误触发 Execute）。 */
export function isServerInitiated(operation: Pick<PreparedOperationRecord, "metadata">): boolean {
  try {
    const parsed: unknown = JSON.parse(operation.metadata);
    return parsed !== null && typeof parsed === "object" && (parsed as Record<string, unknown>).initiator === SERVER_INITIATOR;
  } catch {
    return false;
  }
}

interface PreparedDaemon {
  info: { daemonId: DaemonId };
  accountId: AccountId;
}

interface PreparedWaiter<Client> {
  /** null = server 发起（plan 091）：失败时走 host.failServerOperation 而非 sendError。 */
  client: Client | null;
  timer: ReturnType<typeof setTimeout>;
  operation: Pick<PreparedOperationRecord, "operationId" | "daemonId" | "kind" | "expiresAt">;
}

interface PreparedRetry {
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  queryFailures: number;
  operation: Pick<PreparedOperationRecord, "operationId" | "daemonId" | "kind" | "expiresAt">;
}

type PrepareAdmission =
  | { case: "resume"; operation: PreparedOperationRecord }
  | { case: "created"; operation: PreparedOperationRecord }
  | { case: "full" }
  | { case: "conflict" }
  | { case: "rejected"; message: string }
  | { case: "unavailable" };

export type PreparedOperationAdmissionCheck = (tx: Store) => Promise<string | undefined>;

/** server 发起的 prepare 结果（plan 091）：admission 作为返回值而不是发给 client。 */
export type PrepareServerOutcome =
  | { case: "accepted"; operation: PreparedOperationRecord }
  | { case: "rejected"; message: string };

export interface PreparedOperationHost<Client, Daemon extends PreparedDaemon> {
  getDaemon(daemonId: DaemonId): Daemon | undefined;
  isCurrentDaemon(daemon: Daemon): boolean;
  sendDaemon(daemon: Daemon, payload: ServerToDaemonPayload): boolean;
  sendClient(client: Client, payload: ServerToClientPayload, initialSnapshot: boolean): boolean;
  validControlId(value: string): boolean;
  /** server 发起的记录在安装阶段失败/超时/被取消：唤醒 Hub 的完成原语（无 client 可通知）。
   * 可选：只持 client 语义的宿主（单测）不必实现。 */
  failServerOperation?(operationId: string, message: string): void;
}

export interface PreparedOperationService<Client, Daemon extends PreparedDaemon> {
  createFrame(operationId: string, payload: DeviceEnvelopePayload): Uint8Array;
  prepare(
    client: Client,
    operation: NewPreparedOperation,
    admissionCheck?: PreparedOperationAdmissionCheck,
  ): Promise<void>;
  /** 无 client 入口（plan 091）：同一套 admission；接受后由本服务安装并在 installed 时下发 Execute。 */
  prepareServer(
    operation: NewPreparedOperation,
    admissionCheck?: PreparedOperationAdmissionCheck,
  ): Promise<PrepareServerOutcome>;
  restore(daemon: Daemon): Promise<void>;
  dispatch(operation: PreparedOperationRecord): void;
  resumeForClient(client: Client, operation: PreparedOperationRecord): Promise<void>;
  handleInstalled(daemon: Daemon, operationId: string, ok: boolean, error?: string): Promise<void>;
  sendReadyToClient(client: Client, accountId: AccountId, initialSnapshot?: boolean): Promise<void>;
  complete(operationId: string): void;
  cancelMany(operationIds: readonly string[], message: string): void;
  cancelDaemon(daemonId: DaemonId, message: string): void;
  removeClient(client: Client): void;
  shutdown(): void;
}

export function createPreparedOperationService<Client, Daemon extends PreparedDaemon>(
  store: Store,
  host: PreparedOperationHost<Client, Daemon>,
): PreparedOperationService<Client, Daemon> {
  const waitersByOperation = new Map<string, Set<PreparedWaiter<Client>>>();
  const retriesByOperation = new Map<string, PreparedRetry>();
  // 只保留当前代际；旧 token 仅由当时已在途的 async continuation 持有，结束后可回收。
  // 这样 complete 能让未知 operationId 的 prepare/restore 结果失效，又不积累 completed tombstone。
  let completionToken: object = {};
  let stopped = false;

  const sendError = (client: Client, message: string): void => {
    if (stopped) return;
    host.sendClient(client, { case: "error", value: { message } }, false);
  };

  const createFrame = (operationId: string, payload: DeviceEnvelopePayload): Uint8Array => {
    if (!host.validControlId(operationId)) throw new Error("prepared operationId 无效");
    const frame = encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      channelId: "",
      payload,
    }));
    if (frame.byteLength === 0 || frame.byteLength > MAX_PREPARED_FRAME_BYTES) {
      throw new Error("prepared operation frame 超限");
    }
    return frame;
  };

  const emitToClient = (
    client: Client,
    operation: PreparedOperationRecord,
    initialSnapshot = false,
  ): void => {
    if (
      stopped ||
      operation.completed ||
      operation.state !== "installed" ||
      operation.expiresAt <= Date.now()
    ) return;
    host.sendClient(client, {
      case: "preparedDeviceOperation",
      value: {
        operationId: operation.operationId,
        daemonId: operation.daemonId,
        frame: operation.frame,
        expiresAt: operation.expiresAt,
      },
    }, initialSnapshot);
  };

  const clearWaiters = (operationId: string): void => {
    const waiters = waitersByOperation.get(operationId);
    if (waiters) for (const waiter of waiters) clearTimeout(waiter.timer);
    waitersByOperation.delete(operationId);
  };

  const cancelRetry = (operationId: string): void => {
    const retry = retriesByOperation.get(operationId);
    if (retry) {
      retry.cancelled = true;
      if (retry.timer) clearTimeout(retry.timer);
    }
    retriesByOperation.delete(operationId);
  };

  const complete = (operationId: string): void => {
    completionToken = {};
    cancelRetry(operationId);
    clearWaiters(operationId);
  };

  const failWaiters = (
    operation: Pick<PreparedOperationRecord, "operationId" | "daemonId" | "kind">,
    message: string,
  ): void => {
    if (stopped) {
      clearWaiters(operation.operationId);
      return;
    }
    log.warn("prepared operation 失败", {
      operationId: operation.operationId,
      daemonId: operation.daemonId,
      kind: operation.kind,
      reason: message,
    });
    const waiters = waitersByOperation.get(operation.operationId);
    if (waiters) {
      for (const waiter of waiters) {
        if (waiter.client) sendError(waiter.client, message);
        else host.failServerOperation?.(operation.operationId, message);
      }
    }
    clearWaiters(operation.operationId);
  };

  const cancelMany = (operationIds: readonly string[], message: string): void => {
    if (operationIds.length === 0) return;
    // 先整体推进代际，再逐项摘 timer/waiter。这样已在途的 admission/ready/restore 查询
    // 无论针对哪一项，都必须稳定重读数据库中的 expired 终态。
    completionToken = {};
    for (const operationId of new Set(operationIds)) {
      const retry = retriesByOperation.get(operationId);
      const waiters = waitersByOperation.get(operationId);
      const waiter = waiters?.values().next().value as PreparedWaiter<Client> | undefined;
      const operation = retry?.operation ?? waiter?.operation;
      cancelRetry(operationId);
      if (operation) failWaiters(operation, message);
      else clearWaiters(operationId);
      // server 发起的记录在 installed→执行中阶段没有 waiter/retry；按 ID 直接唤醒完成原语
      // （没有等待者时是空操作）。
      host.failServerOperation?.(operationId, message);
    }
  };

  const expireDueOperations = async (now: number): Promise<void> => {
    const expiredCount = await store.expirePreparedOperations(now);
    if (!expiredCount) return;
    completionToken = {};
    // SQL 只返回计数，避免 server 停机很久后一次 RETURNING 全部过期行撑大内存；易失状态
    // 本来就在这两个有界 Map 中，按本地 deadline 找出需要即时通知/取消的项即可。
    const due = new Map<string, Pick<PreparedOperationRecord, "operationId" | "daemonId" | "kind">>();
    for (const retry of retriesByOperation.values()) {
      if (retry.operation.expiresAt <= now) due.set(retry.operation.operationId, retry.operation);
    }
    for (const waiters of waitersByOperation.values()) {
      for (const waiter of waiters) {
        if (waiter.operation.expiresAt <= now) {
          due.set(waiter.operation.operationId, waiter.operation);
          break;
        }
      }
    }
    for (const [operationId, operation] of due) {
      cancelRetry(operationId);
      failWaiters(operation, "prepared operation 安装超时，可安全重试");
    }
  };

  const watch = (
    operation: Pick<PreparedOperationRecord, "operationId" | "daemonId" | "kind" | "expiresAt">,
    client: Client | null,
  ): void => {
    if (stopped) return;
    const { operationId } = operation;
    const waiters = waitersByOperation.get(operationId) ?? new Set<PreparedWaiter<Client>>();
    if ([...waiters].some((waiter) => waiter.client === client)) return;
    const waiter: PreparedWaiter<Client> = {
      client,
      operation,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        if (stopped) return;
        if (waiters.size === 0) {
          waitersByOperation.delete(operationId);
          log.warn("prepared operation 安装确认超时", {
            operationId,
            daemonId: operation.daemonId,
            kind: operation.kind,
            timeoutMs: config.pendingTimeoutMs,
          });
        }
        if (client) sendError(client, "prepared operation 安装确认超时");
        else host.failServerOperation?.(operationId, "prepared operation 安装确认超时");
      }, config.pendingTimeoutMs),
    };
    waiter.timer.unref?.();
    waiters.add(waiter);
    waitersByOperation.set(operationId, waiters);
  };

  let dispatch: (operation: PreparedOperationRecord) => void;

  const finishRetry = (operationId: string, attempt: PreparedRetry): void => {
    if (retriesByOperation.get(operationId) === attempt) {
      retriesByOperation.delete(operationId);
    }
  };

  const retryIsCurrent = (operationId: string, attempt: PreparedRetry): boolean =>
    !stopped && !attempt.cancelled && retriesByOperation.get(operationId) === attempt;

  const scheduleRetry = (operationId: string, attempt: PreparedRetry, delay = INSTALL_RETRY_MS): boolean => {
    try {
      const timer = setTimeout(() => {
        void retry(operationId, attempt).catch((error) => {
          // retry 自身会收口预期的数据库异常；这里兜住未来新增的同步异常，既不能制造
          // unhandledRejection，也不能让一个已触发的 attempt 永久挂在 Map 里。
          if (retriesByOperation.get(operationId) === attempt) {
            attempt.cancelled = true;
            retriesByOperation.delete(operationId);
          }
          log.error("prepared operation retry 异常", {
            operationId,
            daemonId: attempt.operation.daemonId,
            kind: attempt.operation.kind,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      }, delay);
      timer.unref?.();
      attempt.timer = timer;
      return true;
    } catch (error) {
      log.error("prepared operation retry 定时器创建失败", {
        operationId,
        daemonId: attempt.operation.daemonId,
        kind: attempt.operation.kind,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const handleRetryReadFailure = (
    operationId: string,
    attempt: PreparedRetry,
    error: unknown,
  ): void => {
    if (!retryIsCurrent(operationId, attempt)) return;
    attempt.queryFailures += 1;
    const now = Date.now();
    const expired = attempt.operation.expiresAt <= now;
    const exhausted = attempt.queryFailures >= MAX_RETRY_QUERY_FAILURES;
    log.warn("prepared operation retry 查询失败", {
      operationId,
      daemonId: attempt.operation.daemonId,
      kind: attempt.operation.kind,
      attempt: attempt.queryFailures,
      maxAttempts: MAX_RETRY_QUERY_FAILURES,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (expired || exhausted) {
      finishRetry(operationId, attempt);
      failWaiters(
        attempt.operation,
        expired
          ? "prepared operation 安装超时，可安全重试"
          : "prepared operation 状态查询失败，可安全重试",
      );
      return;
    }
    const remaining = attempt.operation.expiresAt - now;
    const delay = Math.min(
      INSTALL_RETRY_MS * (2 ** (attempt.queryFailures - 1)),
      remaining,
    );
    if (!scheduleRetry(operationId, attempt, delay)) {
      finishRetry(operationId, attempt);
      failWaiters(attempt.operation, "prepared operation 状态查询失败，可安全重试");
    }
  };

  const retry = async (operationId: string, attempt: PreparedRetry): Promise<void> => {
    // timer 触发后仍保留 attempt，直到这条 async continuation 结束或被替换；否则
    // complete/shutdown 无法取消正在等待数据库、手里仍可能拿到旧 pending 记录的 retry。
    if (!retryIsCurrent(operationId, attempt)) return;
    let operation: PreparedOperationRecord | undefined;
    try {
      operation = await store.getPreparedOperation(operationId);
    } catch (error) {
      handleRetryReadFailure(operationId, attempt, error);
      return;
    }
    if (!retryIsCurrent(operationId, attempt)) return;
    if (
      !operation ||
      operation.completed ||
      operation.state === "installed" ||
      !isInstallableState(operation.state)
    ) {
      finishRetry(operationId, attempt);
      return;
    }
    if (operation.expiresAt <= Date.now()) {
      try {
        await expireDueOperations(Date.now());
      } catch (error) {
        if (!retryIsCurrent(operationId, attempt)) return;
        log.warn("prepared operation 过期收口失败", {
          operationId,
          daemonId: operation.daemonId,
          kind: operation.kind,
          reason: error instanceof Error ? error.message : String(error),
        });
        finishRetry(operationId, attempt);
        failWaiters(operation, "prepared operation 安装超时，可安全重试");
        return;
      }
      if (!retryIsCurrent(operationId, attempt)) return;
      finishRetry(operationId, attempt);
      failWaiters(operation, "prepared operation 安装超时，可安全重试");
      return;
    }
    if (!host.getDaemon(operation.daemonId)) {
      finishRetry(operationId, attempt);
      return;
    }
    dispatch(operation);
  };

  dispatch = (operation: PreparedOperationRecord): void => {
    if (stopped) return;
    const daemon = host.getDaemon(operation.daemonId);
    if (
      !daemon ||
      daemon.accountId !== operation.accountId ||
      operation.completed ||
      !isInstallableState(operation.state) ||
      operation.expiresAt <= Date.now()
    ) return;
    host.sendDaemon(daemon, {
      case: "preparedDeviceOperation",
      value: {
        operationId: operation.operationId,
        daemonId: operation.daemonId,
        frame: operation.frame,
        expiresAt: operation.expiresAt,
      },
    });
    const attempt: PreparedRetry = {
      cancelled: false,
      queryFailures: 0,
      operation: {
        operationId: operation.operationId,
        daemonId: operation.daemonId,
        kind: operation.kind,
        expiresAt: operation.expiresAt,
      },
    };
    // 新 timer 建成后再替换旧 attempt；即使极端资源耗尽使 setTimeout 同步抛错，旧 attempt
    // 也不会先被取消后遗留成无 timer 的僵尸项。
    if (!scheduleRetry(operation.operationId, attempt)) {
      cancelRetry(operation.operationId);
      return;
    }
    const previous = retriesByOperation.get(operation.operationId);
    if (previous) {
      previous.cancelled = true;
      if (previous.timer) clearTimeout(previous.timer);
    }
    retriesByOperation.set(operation.operationId, attempt);
  };

  /** server 发起的记录已安装：由中心经控制 WS 触发执行（plan 091）。发送失败不另起 retry——
   * daemon 断开/换代时 Hub 会以可读错误唤醒完成原语，重连后 restore 再走一遍安装→Execute。 */
  const sendExecute = (operation: PreparedOperationRecord): void => {
    if (stopped || operation.completed || operation.state !== "installed" || operation.expiresAt <= Date.now()) return;
    const daemon = host.getDaemon(operation.daemonId);
    if (!daemon || daemon.accountId !== operation.accountId) return;
    host.sendDaemon(daemon, {
      case: "preparedDeviceOperationExecute",
      value: { operationId: operation.operationId },
    });
  };

  const resumeCurrentForServer = (operation: PreparedOperationRecord): void => {
    if (stopped) return;
    if (operation.state === "installed") {
      sendExecute(operation);
      return;
    }
    watch(operation, null);
    dispatch(operation);
  };

  const resumeCurrentForClient = (client: Client, operation: PreparedOperationRecord): void => {
    if (stopped) return;
    if (operation.state === "installed") {
      emitToClient(client, operation);
      return;
    }
    watch(operation, client);
    dispatch(operation);
  };

  const readActiveOperation = async (operationId: string): Promise<PreparedOperationRecord | undefined> => {
    while (!stopped) {
      const readAtToken = completionToken;
      const current = await store.getPreparedOperation(operationId);
      if (
        stopped ||
        !current ||
        current.completed ||
        !isInstallableState(current.state) ||
        current.expiresAt <= Date.now()
      ) return undefined;
      if (readAtToken === completionToken) return current;
    }
    return undefined;
  };

  const resumeForClient = async (client: Client, operation: PreparedOperationRecord): Promise<void> => {
    // 调用方可能先查 active，再跨 await 到这里；complete 不保留 tombstone，因此不能信任
    // 传入对象的 completed/state。始终按真实 ID 稳定重读，把该外部查询也纳入代际边界。
    const current = await readActiveOperation(operation.operationId);
    if (current) resumeCurrentForClient(client, current);
  };

  /** prepare / prepareServer 共用的 admission 事务（顺序：device 父行锁 → admissionCheck →
   * target resume → 并发上限 → insert）。两条入口只差“结果通知谁”。 */
  const admit = async (
    operation: NewPreparedOperation,
    admissionCheck?: PreparedOperationAdmissionCheck,
  ): Promise<PrepareAdmission> => {
    return await store.transaction<PrepareAdmission>(async (tx) => {
      // prepared operation 是 device 的持久子记录。父行既是 admission 的串行化锚点，
      // 也让 count + insert 与 removeDevice 的 revoke/delete 形成同一事务顺序。
      const device = await tx.claimActiveDevice(operation.daemonId, operation.accountId);
      if (!device) return { case: "unavailable" };

      const now = Date.now();
      const rejection = await admissionCheck?.(tx);
      if (rejection) return { case: "rejected", message: rejection };
      if (operation.targetId) {
        const existing = await tx.findActivePreparedOperation(
          operation.accountId,
          operation.kind,
          operation.targetId,
          now,
        );
        if (existing) return { case: "resume", operation: existing };
      }
      if (
        await tx.countActivePreparedOperations(operation.accountId, operation.daemonId, now)
        >= MAX_ACTIVE_PREPARED_PER_DAEMON
      ) return { case: "full" };

      const created = await tx.createPreparedOperation(operation);
      if (created) return { case: "created", operation: created };
      if (operation.targetId) {
        const raced = await tx.findActivePreparedOperation(
          operation.accountId,
          operation.kind,
          operation.targetId,
          now,
        );
        if (raced) return { case: "resume", operation: raced };
      }
      return { case: "conflict" };
    });
  };

  /** admission 通过后按真实 ID 稳定重读（target resume 可能返回别的 ID；期间 report 完成会推进 token）。 */
  const stableAdmitted = async (
    admission: Extract<PrepareAdmission, { case: "resume" | "created" }>,
    admissionToken: object,
  ): Promise<PreparedOperationRecord | undefined> => {
    let current: PreparedOperationRecord | undefined = admission.operation;
    let observedToken = admissionToken;
    while (observedToken !== completionToken) {
      observedToken = completionToken;
      current = await store.getPreparedOperation(admission.operation.operationId);
      if (stopped) return undefined;
    }
    if (
      !current ||
      current.completed ||
      !isInstallableState(current.state) ||
      current.expiresAt <= Date.now()
    ) return undefined;
    return current;
  };

  const prepare = async (
    client: Client,
    operation: NewPreparedOperation,
    admissionCheck?: PreparedOperationAdmissionCheck,
  ): Promise<void> => {
    await expireDueOperations(Date.now());
    if (stopped) return;
    const admissionToken = completionToken;
    const admission = await admit(operation, admissionCheck);
    // transaction 已提交后才触碰 waiter/timer/WS；shutdown 可在任一 DB await 期间同步置位。
    if (stopped) return;
    if (admission.case === "resume" || admission.case === "created") {
      const current = await stableAdmitted(admission, admissionToken);
      if (!current) return;
      resumeCurrentForClient(client, current);
      return;
    }
    if (admission.case === "full") {
      log.warn("prepared operation 达 daemon 并发上限", {
        daemonId: operation.daemonId,
        kind: operation.kind,
        targetId: operation.targetId,
        ...(operation.kind === "session.create" ? { taskId: operation.targetId } : {}),
        limit: MAX_ACTIVE_PREPARED_PER_DAEMON,
      });
      sendError(client, "该 daemon 的 prepared operation 已达上限，请稍后重试");
      return;
    }
    if (admission.case === "unavailable") {
      sendError(client, "daemon 已撤销或不属于本账号");
      return;
    }
    if (admission.case === "rejected") {
      sendError(client, admission.message);
      return;
    }
    sendError(client, "prepared operation ID 冲突");
  };

  const prepareServer = async (
    operation: NewPreparedOperation,
    admissionCheck?: PreparedOperationAdmissionCheck,
  ): Promise<PrepareServerOutcome> => {
    if (!isServerInitiated(operation)) throw new Error("prepareServer 需要 metadata.initiator = server");
    await expireDueOperations(Date.now());
    if (stopped) return { case: "rejected", message: "中心正在关闭" };
    const admissionToken = completionToken;
    const admission = await admit(operation, admissionCheck);
    if (stopped) return { case: "rejected", message: "中心正在关闭" };
    if (admission.case === "resume" || admission.case === "created") {
      const current = await stableAdmitted(admission, admissionToken);
      if (!current) return { case: "rejected", message: "prepared operation 已完成或已过期，请重试" };
      // target resume 命中的可能是 browser 发起的同目标记录：它的帧已交给/将交给浏览器执行，
      // 中心不再重复触发；调用方仍按 operationId 等完成原语（report 收敛时按 ID 唤醒）。
      if (isServerInitiated(current)) resumeCurrentForServer(current);
      else resumeForClientless(current);
      return { case: "accepted", operation: current };
    }
    if (admission.case === "full") {
      log.warn("prepared operation 达 daemon 并发上限", {
        daemonId: operation.daemonId,
        kind: operation.kind,
        targetId: operation.targetId,
        limit: MAX_ACTIVE_PREPARED_PER_DAEMON,
      });
      return { case: "rejected", message: "该 daemon 的 prepared operation 已达上限，请稍后重试" };
    }
    if (admission.case === "unavailable") return { case: "rejected", message: "daemon 已撤销或不属于本账号" };
    if (admission.case === "rejected") return { case: "rejected", message: admission.message };
    return { case: "rejected", message: "prepared operation ID 冲突" };
  };

  /** 复用到 browser 发起的同目标记录时只保证它在投递（安装重试），不接管它的通知。 */
  const resumeForClientless = (operation: PreparedOperationRecord): void => {
    if (stopped || operation.state === "installed") return;
    dispatch(operation);
  };

  const restore = async (daemon: Daemon): Promise<void> => {
    if (stopped) return;
    await expireDueOperations(Date.now());
    if (stopped || !host.isCurrentDaemon(daemon)) return;
    let operations: PreparedOperationRecord[];
    while (true) {
      const listedAtToken = completionToken;
      operations = await store.listInstallablePreparedOperations(daemon.info.daemonId, Date.now());
      if (stopped || !host.isCurrentDaemon(daemon)) return;
      if (listedAtToken === completionToken) break;
    }
    for (const operation of operations) {
      if (operation.accountId === daemon.accountId) dispatch(operation);
    }
  };

  const sendReadyToClient = async (
    client: Client,
    accountId: AccountId,
    initialSnapshot = false,
  ): Promise<void> => {
    if (stopped) return;
    let operations: PreparedOperationRecord[];
    while (true) {
      const listedAtToken = completionToken;
      operations = await store.listReadyPreparedOperations(accountId, Date.now());
      if (stopped) return;
      if (listedAtToken === completionToken) break;
    }
    // token 检查后到发送结束没有 await，complete 无法在中间插入并复活旧列表。
    // server 发起的记录由中心自己 Execute，绝不交给浏览器执行（否则会二次执行）。
    for (const operation of operations) {
      if (!isServerInitiated(operation)) emitToClient(client, operation, initialSnapshot);
    }
  };

  const handleInstalled = async (
    daemon: Daemon,
    operationId: string,
    ok: boolean,
    error?: string,
  ): Promise<void> => {
    if (stopped || !host.validControlId(operationId) || !host.isCurrentDaemon(daemon)) return;
    const operation = await store.markPreparedOperationInstalled(
      operationId,
      daemon.info.daemonId,
      ok,
      error ?? null,
    );
    // Hub 的 generation gate 防连接换代；这里的复核额外覆盖同步 shutdown 不等待 gate。
    if (stopped || !host.isCurrentDaemon(daemon)) return;
    if (!operation || operation.accountId !== daemon.accountId) return;
    cancelRetry(operationId);
    if (!ok) {
      failWaiters(operation, error ?? "daemon 拒绝 prepared operation");
      return;
    }
    if (isServerInitiated(operation)) {
      // 中心发起：安装确认即触发执行；restore 重装后的再次 installed 也走这里（worker 侧幂等）。
      clearWaiters(operationId);
      sendExecute(operation);
      return;
    }
    const waiters = waitersByOperation.get(operationId);
    if (waiters) for (const waiter of waiters) if (waiter.client) emitToClient(waiter.client, operation);
    clearWaiters(operationId);
  };

  const cancelDaemon = (daemonId: DaemonId, message: string): void => {
    // 永久撤销本身也是否定所有旧查询快照的线性化事件；即使当前没有 retry/waiter，
    // 仍要推进 token，阻止已在途的 ready/restore 列表在提交后复活。
    completionToken = {};
    let retryCount = 0;
    let waiterCount = 0;
    for (const [operationId, retry] of [...retriesByOperation]) {
      if (retry.operation.daemonId !== daemonId) continue;
      retryCount += 1;
      cancelRetry(operationId);
    }
    for (const [operationId, waiters] of [...waitersByOperation]) {
      const belongsToDaemon = [...waiters].some((waiter) => waiter.operation.daemonId === daemonId);
      if (!belongsToDaemon) continue;
      for (const waiter of waiters) {
        waiterCount += 1;
        if (waiter.client) sendError(waiter.client, message);
        else host.failServerOperation?.(operationId, message);
      }
      clearWaiters(operationId);
    }
    if (retryCount > 0 || waiterCount > 0) {
      log.warn("daemon prepared operation 已取消", { daemonId, retryCount, waiterCount });
    }
  };

  const removeClient = (client: Client): void => {
    for (const [operationId, waiters] of waitersByOperation) {
      for (const waiter of [...waiters]) {
        if (waiter.client !== client) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
      }
      if (waiters.size === 0) waitersByOperation.delete(operationId);
    }
  };

  const shutdown = (): void => {
    stopped = true;
    for (const retry of retriesByOperation.values()) {
      retry.cancelled = true;
      if (retry.timer) clearTimeout(retry.timer);
    }
    retriesByOperation.clear();
    for (const waiters of waitersByOperation.values()) {
      for (const waiter of waiters) clearTimeout(waiter.timer);
    }
    waitersByOperation.clear();
  };

  return {
    createFrame,
    prepare,
    prepareServer,
    restore,
    dispatch,
    resumeForClient,
    handleInstalled,
    sendReadyToClient,
    complete,
    cancelMany,
    cancelDaemon,
    removeClient,
    shutdown,
  };
}

import Foundation

/// Device 协议常量。真相源 `packages/protocol/src/index.ts:45,50` 与 `proto/coflux/v1/device.proto:11-12`；
/// Swift 无法 import TS 包，硬编码同值——两端改动必须同步。
enum DeviceProtocol {
    static let version: UInt32 = 1
    static let maxFrameBytes = 30 * 1024 * 1024
    /// cols/rows 在 authority 边界钳制为 [1, 1000]（device.proto:12）。
    static func clampDim(_ n: UInt32, fallback: UInt32) -> UInt32 {
        (1 ... 1000).contains(n) ? n : fallback
    }
}

struct DeviceRouteError: Error {
    let message: String
    let code: String
    init(_ message: String, code: String = "route_unavailable") {
        self.message = message
        self.code = code
    }
}

/// PTY 数据面事件出口。输出字节**不进 @Observable 状态**（store.ts:107-110 同构）：
/// snapshot/output 直达终端 feed；只有控制面事实（attached/detached/exited/blocked）进状态。
struct DeviceRouterCallbacks {
    var sendControl: (Coflux_V1_ClientToServer.OneOf_Payload) -> Void
    var onSessionSnapshot: (_ daemonID: String, _ taskID: String, _ sessionID: String, _ data: Data) -> Void
    var onSessionOutput: (_ daemonID: String, _ taskID: String, _ sessionID: String, _ data: Data) -> Void
    var onSessionAttached: (_ daemonID: String, _ taskID: String, _ sessionID: String) -> Void
    var onSessionDetached: (_ daemonID: String, _ taskID: String, _ sessionID: String, _ reason: String) -> Void
    var onSessionExited: (_ daemonID: String, _ taskID: String, _ sessionID: String, _ exitCode: Int32) -> Void
    var onCatalog: (_ daemonID: String, _ catalog: Coflux_V1_DeviceSessionCatalog) -> Void
    var onError: (_ message: String) -> Void
    var onInputBlocked: (_ sessionID: String, _ blocked: Bool) -> Void
}

/// relay-only Device 数据路由（plan 045）。语义基准 `packages/client/src/device-router.ts` 的
/// relay 子集：per-daemon route（session/elevated 两条 lane）、transport generation 单调、
/// attach 三重匹配 + snapshot/resume、输入/resize 台账与累计 ACK 重投、prepared operation
/// 台账、按需建连与空闲释放。direct/loopback、pair/lease、心跳、fs/exec RPC 不移植
/// （iOS 永不与 daemon 同机；ceiling 见 plan 045 Maintenance）。
///
/// 与 CofluxClient 同在 MainActor：单线程状态机与 TS 版一一对应；网络 IO 在子 Task，
/// 回 MainActor 提交状态。
@MainActor
final class DeviceRouter {
    private enum LaneKind { case session, elevated }

    // 与 TS 同参数（device-router.ts:37-56 relay-only 子集）
    private static let controlRequestTimeout: Duration = .seconds(10)
    private static let deviceRequestTimeout: Duration = .seconds(20)
    private static let relayConnectTimeout: Duration = .seconds(10)
    private static let recoverBaseMS = 350.0
    private static let recoverMaxMS = 5_000.0
    private static let inputRetry: Duration = .milliseconds(500)
    private static let catalogInterval: Duration = .seconds(3)
    private static let maxRetainedInputs = 256
    private static let maxRetainedInputBytes = 1024 * 1024

    private struct RetainedInput {
        let requestID: String
        let seq: UInt64
        let data: Data
    }

    private struct RetainedResize {
        let requestID: String
        let seq: UInt64
        let cols: UInt32
        let rows: UInt32
    }

    /// @unchecked Sendable：所有可变状态仅在 MainActor 上访问；标注只为让
    /// Task<Channel, Error>（lane attempt）跨隔离边界携带结果。
    private final class Channel: @unchecked Sendable {
        let channelID: String
        let generation: UInt64
        let lane: LaneKind
        let connection: any TransportConnection
        var closed = false
        var receiveTask: Task<Void, Never>?
        /// 串行发送链：input_seq 连续性契约要求帧不乱序（plan 042）。
        var sendChain: Task<Void, Never>?

        init(channelID: String, generation: UInt64, lane: LaneKind, connection: any TransportConnection) {
            self.channelID = channelID
            self.generation = generation
            self.lane = lane
            self.connection = connection
        }
    }

    private final class RoutedSession {
        let daemonID: String
        var taskID: String
        let sessionID: String
        var desired = false
        /// 被其它客户端接管：desired 一并置 false，普通 attach 不得自动重挂（plan 026 语义），
        /// 仅 force 接管清除。
        var detached = false
        var cols: UInt32
        var rows: UInt32
        var holderEpoch: UInt64?
        /// 仅在当前 consumer 实际应用过 live snapshot/delta 后有值。
        var outputSeq: UInt64?
        var hasLiveSnapshot = false
        var inputSeq: UInt64 = 0
        var ackedInputSeq: UInt64 = 0
        var resizeSeq: UInt64 = 0
        var retainedInputs: [RetainedInput] = []
        var retainedInputBytes = 0
        var retainedResize: RetainedResize?
        var attachRequestID: String?
        var attachGeneration: UInt64?
        var attachedGeneration: UInt64?
        var inputRetryTask: Task<Void, Never>?
        var holderWaiters: [UUID: CheckedContinuation<Void, any Error>] = [:]

        init(daemonID: String, taskID: String, sessionID: String, cols: UInt32, rows: UInt32) {
            self.daemonID = daemonID
            self.taskID = taskID
            self.sessionID = sessionID
            self.cols = cols
            self.rows = rows
        }
    }

    private struct PendingRequest {
        let requestID: String
        let lane: LaneKind
        let payload: Coflux_V1_DeviceEnvelope.OneOf_Payload
        var sentGeneration: UInt64?
        let continuation: CheckedContinuation<Coflux_V1_DeviceEnvelope.OneOf_Payload, any Error>
        var timeoutTask: Task<Void, Never>?
    }

    private struct PendingOperation {
        let operationID: String
        let requestID: String?
        let payload: Coflux_V1_DeviceEnvelope.OneOf_Payload
        let expiresAt: Double
        var sentGeneration: UInt64?
    }

    private final class Lane {
        let kind: LaneKind
        var token = 0
        var active: Channel?
        var attempt: Task<Channel, any Error>?
        var recoveryAttempts = 0
        var recoveryTask: Task<Void, Never>?

        init(kind: LaneKind) { self.kind = kind }
    }

    private final class Route {
        let daemonID: String
        let sessionLane = Lane(kind: .session)
        let elevatedLane = Lane(kind: .elevated)
        var sessions: [String: RoutedSession] = [:]
        var pendingRequests: [String: PendingRequest] = [:]
        var pendingOperations: [String: PendingOperation] = [:]
        var catalogTask: Task<Void, Never>?

        init(daemonID: String) { self.daemonID = daemonID }
    }

    private struct RelayWaiter {
        let daemonID: String
        let continuation: CheckedContinuation<String, any Error>
        var timeoutTask: Task<Void, Never>?
    }

    private let transport: any Transport
    private let callbacks: DeviceRouterCallbacks
    /// epoch ms，可注入（prepared operation 过期判定；测试注入假时钟）。
    private let now: () -> Double

    private var routes: [String: Route] = [:]
    /// generation 属于 logical client/daemon 而非可释放的 route：reset/重建都不能回退
    /// （device-router.ts:330-331）。
    private var generations: [String: UInt64] = [:]
    private var relayWaiters: [String: RelayWaiter] = [:]
    private var clientInstanceID = UUID().uuidString
    private var controlOnline = false
    private var destroyed = false

    init(
        transport: any Transport,
        callbacks: DeviceRouterCallbacks,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.transport = transport
        self.callbacks = callbacks
        self.now = now
    }

    // MARK: - 控制面接线

    /// 消费控制面里属于 device 域的负载；返回 true 表示已消费（store.ts:324 同构）。
    func handleControlPayload(_ payload: Coflux_V1_ServerToClient.OneOf_Payload) -> Bool {
        switch payload {
        case .deviceRelayGrant(let grant):
            guard let waiter = relayWaiters.removeValue(forKey: grant.channelID) else { return true }
            waiter.timeoutTask?.cancel()
            if grant.ok, grant.hasRelayURL, !grant.relayURL.isEmpty {
                waiter.continuation.resume(returning: grant.relayURL)
            } else {
                waiter.continuation.resume(throwing: DeviceRouteError(grant.hasError ? grant.error : "relay rendezvous 失败"))
            }
            return true
        case .preparedDeviceOperation(let operation):
            executePrepared(operation)
            return true
        default:
            return false
        }
    }

    func setControlOnline(_ online: Bool) {
        guard controlOnline != online else { return }
        controlOnline = online
        if !online {
            // rendezvous 与 relay 存活都依赖中心：中心断线立即关掉一切，不留半死管道
            // （device-router.ts:2196-2209）。
            rejectRelayWaiters("中心连接已断开")
            for route in routes.values {
                if let channel = route.sessionLane.active { loseChannel(route, channel, reason: "中心 relay 已断开") }
                if let channel = route.elevatedLane.active { loseChannel(route, channel, reason: "中心 relay 已断开") }
            }
            return
        }
        for route in routes.values {
            if sessionLaneDemand(route) { kickLane(route, route.sessionLane) }
            if elevatedLaneDemand(route) { kickLane(route, route.elevatedLane) }
        }
    }

    /// 登出：关全部通道 + 更换 logical client identity（旧 clientInstanceID 的 input 游标
    /// 在 sessiond 侧有累计账，复用会碰撞，device-router.ts:2228-2238）。
    func reset() {
        rejectRelayWaiters("Device router 已重置")
        for route in routes.values { closeRoute(route, reason: "Device router 已重置") }
        routes.removeAll()
        clientInstanceID = UUID().uuidString
        generations.removeAll()
    }

    // MARK: - Session 对外操作（store.ts / device-router.ts 对外面）

    func attachSession(daemonID: String, taskID: String, sessionID: String, cols: UInt32, rows: UInt32, force: Bool = false) {
        let route = routeFor(daemonID)
        let session: RoutedSession
        if let existing = route.sessions[sessionID] {
            existing.taskID = taskID
            if existing.detached && !force { return }
            existing.desired = true
            if force { existing.detached = false }
            existing.cols = DeviceProtocol.clampDim(cols, fallback: existing.cols)
            existing.rows = DeviceProtocol.clampDim(rows, fallback: existing.rows)
            session = existing
        } else {
            session = RoutedSession(
                daemonID: daemonID, taskID: taskID, sessionID: sessionID,
                cols: DeviceProtocol.clampDim(cols, fallback: 80),
                rows: DeviceProtocol.clampDim(rows, fallback: 24)
            )
            session.desired = true
            route.sessions[sessionID] = session
        }
        if force { session.holderEpoch = nil }
        ensureLaneThen(route, route.sessionLane) { [weak self] in
            self?.sendAttach(route, session, requireSnapshot: false)
        }
    }

    /// terminal consumer 释放（页面离开）：desired 置 false，空闲则释放通道。
    func suspendSession(daemonID: String, sessionID: String) {
        guard let route = routes[daemonID], let session = route.sessions[sessionID] else { return }
        session.desired = false
        session.holderEpoch = nil
        session.outputSeq = nil
        session.hasLiveSnapshot = false
        session.attachRequestID = nil
        session.attachGeneration = nil
        session.attachedGeneration = nil
        clearInputRetry(session)
        rejectHolderWaiters(session, DeviceRouteError("terminal consumer 已释放"))
        releaseIdle(route)
    }

    func forgetSession(daemonID: String, sessionID: String) {
        guard let route = routes[daemonID] else { return }
        if let session = route.sessions[sessionID] {
            clearInputRetry(session)
            rejectHolderWaiters(session, DeviceRouteError("session route 已释放"))
        }
        route.sessions[sessionID] = nil
        releaseIdle(route)
    }

    @discardableResult
    func sendInput(daemonID: String, sessionID: String, data: Data) -> Bool {
        guard let route = routes[daemonID], let session = route.sessions[sessionID],
              session.desired, !session.detached, !data.isEmpty else { return false }
        if session.retainedInputs.count >= Self.maxRetainedInputs
            || session.retainedInputBytes + data.count > Self.maxRetainedInputBytes {
            callbacks.onInputBlocked(sessionID, true)
            return false
        }
        session.inputSeq += 1
        let input = RetainedInput(requestID: UUID().uuidString, seq: session.inputSeq, data: data)
        session.retainedInputs.append(input)
        session.retainedInputBytes += data.count
        let blocked = session.retainedInputs.count >= Self.maxRetainedInputs
            || session.retainedInputBytes >= Self.maxRetainedInputBytes
        callbacks.onInputBlocked(sessionID, blocked)
        if let channel = route.sessionLane.active, !channel.closed, session.holderEpoch != nil {
            sendInputFrame(route, channel, session, input)
            scheduleInputRetry(route, session)
        } else {
            ensureLaneThen(route, route.sessionLane) { [weak self] in
                self?.sendAttach(route, session, requireSnapshot: false)
            }
        }
        return true
    }

    func resize(daemonID: String, sessionID: String, cols: UInt32, rows: UInt32) {
        guard let route = routes[daemonID], let session = route.sessions[sessionID], session.desired else { return }
        session.cols = DeviceProtocol.clampDim(cols, fallback: session.cols)
        session.rows = DeviceProtocol.clampDim(rows, fallback: session.rows)
        session.resizeSeq += 1
        let resize = RetainedResize(requestID: UUID().uuidString, seq: session.resizeSeq, cols: session.cols, rows: session.rows)
        session.retainedResize = resize
        if let channel = route.sessionLane.active, !channel.closed, session.holderEpoch != nil {
            sendResizeFrame(route, channel, session, resize)
        }
    }

    /// stop 需先持有 holder（device-router.ts:2017-2034）：无 holder 先强制 attach 等裁决。
    func stopSession(daemonID: String, sessionID: String) async throws {
        let route = routeFor(daemonID)
        guard let session = route.sessions[sessionID] else {
            throw DeviceRouteError("本地没有该 session 的路由状态")
        }
        if session.holderEpoch == nil {
            attachSession(daemonID: daemonID, taskID: session.taskID, sessionID: sessionID,
                          cols: session.cols, rows: session.rows, force: true)
            try await waitForSessionHolder(session)
        }
        guard let holderEpoch = session.holderEpoch else {
            throw DeviceRouteError("session holder 不可用")
        }
        var stop = Coflux_V1_DeviceSessionStop()
        stop.requestID = UUID().uuidString
        stop.operationID = UUID().uuidString
        stop.sessionID = sessionID
        stop.holderEpoch = holderEpoch
        let response = try await request(route, lane: .session, requestID: stop.requestID, payload: .sessionStop(stop))
        if case .operationAck(let ack) = response, !ack.ok {
            throw DeviceRouteError(ack.hasError ? ack.error : "停止 session 失败")
        }
    }

    /// 中心 prepared operation（启动任务等）：校验后填 channel_id 经 LIFECYCLE lane 发出。
    /// frame 除 channel_id 外不可改写任何字段——daemon 逐字段比对模板（device.proto:489-495）。
    func executePrepared(_ operation: Coflux_V1_PreparedDeviceOperation) {
        guard !operation.operationID.isEmpty, !operation.daemonID.isEmpty,
              operation.expiresAt.isFinite, operation.expiresAt > now(),
              !operation.frame.isEmpty, operation.frame.count <= DeviceProtocol.maxFrameBytes,
              let envelope = try? Coflux_V1_DeviceEnvelope(serializedBytes: operation.frame),
              envelope.protocolVersion == DeviceProtocol.version,
              envelope.channelID.isEmpty,
              let payload = envelope.payload,
              Self.preparedOperationID(payload) == operation.operationID
        else {
            callbacks.onError("server 下发了无效 prepared device operation")
            return
        }
        let route = routeFor(operation.daemonID)
        route.pendingOperations[operation.operationID] = PendingOperation(
            operationID: operation.operationID,
            requestID: Self.requestID(of: payload),
            payload: payload,
            expiresAt: operation.expiresAt
        )
        ensureLaneThen(route, route.elevatedLane) { [weak self] in
            self?.flushLane(route, .elevated)
        }
    }

    // MARK: - Lane 生命周期

    private func routeFor(_ daemonID: String) -> Route {
        if let route = routes[daemonID] { return route }
        let route = Route(daemonID: daemonID)
        routes[daemonID] = route
        return route
    }

    private func nextGeneration(_ daemonID: String) -> UInt64 {
        let next = (generations[daemonID] ?? 0) + 1
        generations[daemonID] = next
        return next
    }

    /// ensure + 成功后续动作；失败走有界 recovery。
    private func ensureLaneThen(_ route: Route, _ lane: Lane, _ then: @escaping () -> Void) {
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.ensureLane(route, lane)
                then()
            } catch {
                self.scheduleRecovery(route, lane)
            }
        }
    }

    private func kickLane(_ route: Route, _ lane: Lane) {
        ensureLaneThen(route, lane) { [weak self] in
            self?.flushLane(route, lane.kind)
        }
    }

    private func ensureLane(_ route: Route, _ lane: Lane) async throws -> Channel {
        if destroyed { throw DeviceRouteError("Device router 已停止") }
        if let active = lane.active, !active.closed { return active }
        if let attempt = lane.attempt { return try await attempt.value }
        guard controlOnline else { throw DeviceRouteError("中心 rendezvous 不可用") }

        lane.token += 1
        let token = lane.token
        let attempt = Task<Channel, any Error> { [weak self] in
            guard let self else { throw DeviceRouteError("Device router 已停止") }
            return try await self.openRelayChannel(route, lane)
        }
        lane.attempt = attempt
        defer { if lane.token == token { lane.attempt = nil } }
        let channel = try await attempt.value
        // 竞态守卫：等待期间 lane 被 close/重建则丢弃本次结果
        guard !destroyed, routes[route.daemonID] === route, lane.token == token else {
            closeChannel(channel)
            throw DeviceRouteError("lane 已重建")
        }
        activate(route, lane, channel)
        return channel
    }

    /// relay rendezvous（plan 043）：deviceRelayConnect → deviceRelayGrant（带 token 的完整
    /// wss URL，**单次有效**——失败重试必须重新 rendezvous，不得复用 URL）→ 拨 relay WS。
    private func openRelayChannel(_ route: Route, _ lane: Lane) async throws -> Channel {
        let channelID = "relay-\(UUID().uuidString)"
        let generation = nextGeneration(route.daemonID)
        let relayURL: String = try await withCheckedThrowingContinuation { continuation in
            var waiter = RelayWaiter(daemonID: route.daemonID, continuation: continuation, timeoutTask: nil)
            waiter.timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: Self.controlRequestTimeout)
                guard !Task.isCancelled, let self else { return }
                guard let pending = self.relayWaiters.removeValue(forKey: channelID) else { return }
                pending.continuation.resume(throwing: DeviceRouteError("中心 relay rendezvous 超时", code: "control_timeout"))
            }
            relayWaiters[channelID] = waiter
            var connect = Coflux_V1_DeviceRelayConnect()
            connect.daemonID = route.daemonID
            connect.channelID = channelID
            connect.clientInstanceID = clientInstanceID
            connect.transportGeneration = generation
            connect.protocolVersion = DeviceProtocol.version
            callbacks.sendControl(.deviceRelayConnect(connect))
        }
        guard let url = URL(string: relayURL) else {
            throw DeviceRouteError("relay URL 无效")
        }
        let connection = try await withTimeout(Self.relayConnectTimeout, message: "连接 relay 超时") { [transport] in
            try await transport.connect(to: url)
        }
        return Channel(channelID: channelID, generation: generation, lane: lane.kind, connection: connection)
    }

    /// 收帧循环在 activate 时才启动：relay 对端在我们发帧前不会主动发帧，激活前无早帧；
    /// 这样避免 TS 版 earlyFrames 缓冲（device-router.ts:709-756）对应的激活前竞态窗口。
    private func startReceiveLoop(_ route: Route, _ channel: Channel) {
        let connection = channel.connection
        channel.receiveTask = Task { [weak self] in
            do {
                while true {
                    let data = try await connection.receive()
                    guard let self, !Task.isCancelled else { return }
                    self.receiveFrame(route, channel, data)
                }
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.loseChannel(route, channel, reason: "relay 连接已关闭")
            }
        }
    }

    /// 激活语义（device-router.ts:1083-1127 relay 子集）：重置全部 attach 状态、
    /// 重挂 desired session、重投 pending、打一发 catalog 并起轮询。
    private func activate(_ route: Route, _ lane: Lane, _ channel: Channel) {
        if let previous = lane.active, previous !== channel {
            // generation 更小的候选一律丢弃，不回退
            if channel.generation <= previous.generation {
                closeChannel(channel)
                return
            }
        }
        let previous = lane.active
        lane.active = channel
        lane.recoveryAttempts = 0
        lane.recoveryTask?.cancel()
        lane.recoveryTask = nil
        startReceiveLoop(route, channel)
        if lane.kind == .session {
            for session in route.sessions.values {
                session.attachRequestID = nil
                session.attachGeneration = nil
                session.attachedGeneration = nil
                if session.desired { sendAttach(route, session, requireSnapshot: false) }
            }
            for requestID in route.pendingRequests.keys where route.pendingRequests[requestID]?.lane == .session {
                route.pendingRequests[requestID]?.sentGeneration = nil
            }
            flushLane(route, .session)
            sendCatalogRequest(route)
            maintainCatalogTimer(route)
        } else {
            for requestID in route.pendingRequests.keys where route.pendingRequests[requestID]?.lane == .elevated {
                route.pendingRequests[requestID]?.sentGeneration = nil
            }
            for operationID in route.pendingOperations.keys {
                route.pendingOperations[operationID]?.sentGeneration = nil
            }
            flushLane(route, .elevated)
        }
        if let previous, previous !== channel { closeChannel(previous) }
    }

    private func closeChannel(_ channel: Channel) {
        guard !channel.closed else { return }
        channel.closed = true
        channel.receiveTask?.cancel()
        let connection = channel.connection
        Task { await connection.close() }
    }

    private func loseChannel(_ route: Route, _ channel: Channel, reason: String) {
        guard !channel.closed else { return }
        let lane = channel.lane == .session ? route.sessionLane : route.elevatedLane
        closeChannel(channel)
        guard lane.active === channel else { return }
        lane.active = nil
        if lane.kind == .session {
            for requestID in route.pendingRequests.keys where route.pendingRequests[requestID]?.lane == .session {
                route.pendingRequests[requestID]?.sentGeneration = nil
            }
            for session in route.sessions.values {
                session.attachRequestID = nil
                session.attachGeneration = nil
                session.attachedGeneration = nil
            }
        } else {
            for requestID in route.pendingRequests.keys where route.pendingRequests[requestID]?.lane == .elevated {
                route.pendingRequests[requestID]?.sentGeneration = nil
            }
            for operationID in route.pendingOperations.keys {
                route.pendingOperations[operationID]?.sentGeneration = nil
            }
        }
        scheduleRecovery(route, lane)
    }

    private func closeLane(_ route: Route, _ lane: Lane, reason: String) {
        lane.token += 1
        lane.recoveryTask?.cancel()
        lane.recoveryTask = nil
        lane.attempt?.cancel()
        lane.attempt = nil
        if let active = lane.active {
            lane.active = nil
            closeChannel(active)
        }
        if lane.kind == .session {
            for session in route.sessions.values {
                session.attachRequestID = nil
                session.attachGeneration = nil
                session.attachedGeneration = nil
            }
        }
    }

    /// 有界退避恢复（350ms 起步 5s 封顶 + 抖动，device-router.ts:1173-1191）。
    /// 中心离线时不空转——setControlOnline(true) 会统一重踢。
    private func scheduleRecovery(_ route: Route, _ lane: Lane) {
        let needed = lane.kind == .session ? sessionLaneDemand(route) : elevatedLaneDemand(route)
        guard !destroyed, controlOnline, lane.recoveryTask == nil, needed else { return }
        let base = min(Self.recoverMaxMS, Self.recoverBaseMS * pow(2, Double(min(lane.recoveryAttempts, 4))))
        let delayMS = base * (1 + Double.random(in: 0 ... 0.2))
        lane.recoveryAttempts += 1
        lane.recoveryTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(delayMS)))
            guard !Task.isCancelled, let self else { return }
            lane.recoveryTask = nil
            let stillNeeded = lane.kind == .session ? self.sessionLaneDemand(route) : self.elevatedLaneDemand(route)
            guard stillNeeded else {
                self.releaseIdle(route)
                return
            }
            self.kickLane(route, lane)
        }
    }

    // MARK: - 需求判定与空闲释放

    private func sessionLaneDemand(_ route: Route) -> Bool {
        if route.sessions.values.contains(where: { $0.desired }) { return true }
        return route.pendingRequests.values.contains { $0.lane == .session }
    }

    private func elevatedLaneDemand(_ route: Route) -> Bool {
        pruneExpiredOperations(route)
        if !route.pendingOperations.isEmpty { return true }
        return route.pendingRequests.values.contains { $0.lane == .elevated }
    }

    private func pruneExpiredOperations(_ route: Route) {
        var expired = false
        for (operationID, operation) in route.pendingOperations where operation.expiresAt <= now() {
            route.pendingOperations[operationID] = nil
            expired = true
        }
        if expired { callbacks.onError("prepared device operation 已过期，请重试") }
    }

    private func releaseIdle(_ route: Route) {
        if !sessionLaneDemand(route) {
            route.catalogTask?.cancel()
            route.catalogTask = nil
            closeLane(route, route.sessionLane, reason: "session lane 已释放")
        } else {
            maintainCatalogTimer(route)
        }
        if !elevatedLaneDemand(route) {
            closeLane(route, route.elevatedLane, reason: "elevated lane 已释放")
        }
    }

    private func closeRoute(_ route: Route, reason: String) {
        route.catalogTask?.cancel()
        route.catalogTask = nil
        closeLane(route, route.sessionLane, reason: reason)
        closeLane(route, route.elevatedLane, reason: reason)
        for session in route.sessions.values {
            clearInputRetry(session)
            rejectHolderWaiters(session, DeviceRouteError(reason))
        }
        for requestID in route.pendingRequests.keys {
            finishPending(route, requestID: requestID, with: .failure(DeviceRouteError(reason)))
        }
        route.pendingOperations.removeAll()
    }

    // MARK: - 发送

    private func encodeFrame(_ channel: Channel, _ payload: Coflux_V1_DeviceEnvelope.OneOf_Payload) -> Data? {
        var envelope = Coflux_V1_DeviceEnvelope()
        envelope.protocolVersion = DeviceProtocol.version
        envelope.channelID = channel.channelID
        envelope.payload = payload
        guard let frame = try? envelope.serializedBytes() as Data,
              !frame.isEmpty, frame.count <= DeviceProtocol.maxFrameBytes else { return nil }
        return frame
    }

    /// 帧入串行发送链保序发出；发送失败按通道丢失处理（TS sendOn=false 同收敛路径）。
    private func sendOn(_ route: Route, _ channel: Channel, _ payload: Coflux_V1_DeviceEnvelope.OneOf_Payload) {
        guard !channel.closed, let frame = encodeFrame(channel, payload) else { return }
        let connection = channel.connection
        let previous = channel.sendChain
        channel.sendChain = Task { [weak self] in
            await previous?.value
            do {
                try await connection.send(frame)
            } catch {
                guard let self, !channel.closed else { return }
                self.loseChannel(route, channel, reason: "Device 帧发送失败")
            }
        }
    }

    private func flushLane(_ route: Route, _ laneKind: LaneKind) {
        let lane = laneKind == .session ? route.sessionLane : route.elevatedLane
        guard let channel = lane.active, !channel.closed else {
            scheduleRecovery(route, lane)
            return
        }
        for requestID in route.pendingRequests.keys {
            guard var pending = route.pendingRequests[requestID], pending.lane == laneKind,
                  pending.sentGeneration != channel.generation else { continue }
            pending.sentGeneration = channel.generation
            route.pendingRequests[requestID] = pending
            sendOn(route, channel, pending.payload)
        }
        guard laneKind == .elevated else { return }
        pruneExpiredOperations(route)
        for operationID in route.pendingOperations.keys {
            guard var operation = route.pendingOperations[operationID],
                  operation.sentGeneration != channel.generation else { continue }
            operation.sentGeneration = channel.generation
            route.pendingOperations[operationID] = operation
            sendOn(route, channel, operation.payload)
        }
        if !elevatedLaneDemand(route) { releaseIdle(route) }
    }

    // MARK: - attach / 输出 / 输入台账（exactly-once 契约的客户端半边，plan 042）

    private func sendAttach(_ route: Route, _ session: RoutedSession, requireSnapshot: Bool) {
        guard session.desired, !session.detached else { return }
        guard let channel = route.sessionLane.active, !channel.closed else {
            ensureLaneThen(route, route.sessionLane) { [weak self] in
                self?.sendAttach(route, session, requireSnapshot: requireSnapshot)
            }
            return
        }
        if session.attachRequestID != nil, session.attachGeneration == channel.generation { return }
        if !requireSnapshot, session.attachedGeneration == channel.generation, session.holderEpoch != nil { return }
        let requestID = UUID().uuidString
        session.attachRequestID = requestID
        session.attachGeneration = channel.generation
        var attach = Coflux_V1_DeviceSessionAttach()
        attach.requestID = requestID
        attach.sessionID = session.sessionID
        attach.clientInstanceID = clientInstanceID
        attach.transportGeneration = channel.generation
        attach.cols = session.cols
        attach.rows = session.rows
        // resume_from_seq 显式 presence：不带 = 要完整 snapshot；带 N = 请求从 N+1 续传
        if !requireSnapshot, session.hasLiveSnapshot, let outputSeq = session.outputSeq {
            attach.resumeFromSeq = outputSeq
        }
        sendOn(route, channel, .sessionAttach(attach))
    }

    /// 三重匹配（requestId + 发起代际 + 当前 active channel）；resume 被拒必须转
    /// requireSnapshot 重发，不得就地采信（device-router.ts:1487-1510）。
    private func handleAttached(_ route: Route, _ channel: Channel, _ attached: Coflux_V1_DeviceSessionAttached) {
        guard let session = route.sessions[attached.sessionID], session.desired,
              route.sessionLane.active === channel else { return }
        guard let attachRequestID = session.attachRequestID, attached.requestID == attachRequestID else { return }
        guard session.attachGeneration == channel.generation else { return }
        session.attachRequestID = nil
        session.attachGeneration = nil
        session.attachedGeneration = channel.generation
        session.holderEpoch = attached.holderEpoch
        resolveHolderWaiters(session)
        if attached.hasAnsiSnapshot {
            session.outputSeq = attached.snapshotSeq
            session.hasLiveSnapshot = true
            callbacks.onSessionSnapshot(route.daemonID, session.taskID, session.sessionID, attached.ansiSnapshot)
        } else if !session.hasLiveSnapshot || session.outputSeq == nil || attached.snapshotSeq != session.outputSeq {
            session.outputSeq = nil
            session.hasLiveSnapshot = false
            session.attachedGeneration = nil
            sendAttach(route, session, requireSnapshot: true)
            return
        }
        callbacks.onSessionAttached(route.daemonID, session.taskID, session.sessionID)
        replayControl(route, session)
    }

    /// 连续性硬校验：from_seq 必须是 outputSeq+1 且 to_seq 自洽，否则整段丢弃走 snapshot
    /// recovery——禁止猜测缺口（device.proto:298）。
    private func handleOutput(_ route: Route, _ channel: Channel, _ output: Coflux_V1_DevicePtyOutput) {
        guard let session = route.sessions[output.sessionID], session.desired,
              session.attachedGeneration == channel.generation, !output.data.isEmpty else { return }
        let expected = (session.outputSeq ?? 0) + 1
        guard output.fromSeq == expected,
              output.toSeq == output.fromSeq + UInt64(output.data.count) - 1 else {
            requestSnapshotRecovery(route, session)
            return
        }
        session.outputSeq = output.toSeq
        callbacks.onSessionOutput(route.daemonID, session.taskID, session.sessionID, output.data)
    }

    private func requestSnapshotRecovery(_ route: Route, _ session: RoutedSession) {
        session.outputSeq = nil
        session.hasLiveSnapshot = false
        session.attachedGeneration = nil
        sendAttach(route, session, requireSnapshot: true)
    }

    /// attach 成功后重投全部未确认输入前缀与最新 resize（authority 幂等裁决）。
    private func replayControl(_ route: Route, _ session: RoutedSession) {
        guard let channel = route.sessionLane.active, !channel.closed, session.holderEpoch != nil else { return }
        for input in session.retainedInputs {
            sendInputFrame(route, channel, session, input)
        }
        if let resize = session.retainedResize {
            sendResizeFrame(route, channel, session, resize)
        }
        scheduleInputRetry(route, session)
    }

    private func sendInputFrame(_ route: Route, _ channel: Channel, _ session: RoutedSession, _ input: RetainedInput) {
        guard let holderEpoch = session.holderEpoch else { return }
        var payload = Coflux_V1_DevicePtyInput()
        payload.requestID = input.requestID
        payload.sessionID = session.sessionID
        payload.holderEpoch = holderEpoch
        payload.inputSeq = input.seq
        payload.data = input.data
        sendOn(route, channel, .ptyInput(payload))
    }

    private func sendResizeFrame(_ route: Route, _ channel: Channel, _ session: RoutedSession, _ resize: RetainedResize) {
        guard let holderEpoch = session.holderEpoch else { return }
        var payload = Coflux_V1_DevicePtyResize()
        payload.requestID = resize.requestID
        payload.sessionID = session.sessionID
        payload.holderEpoch = holderEpoch
        payload.resizeSeq = resize.seq
        payload.cols = resize.cols
        payload.rows = resize.rows
        sendOn(route, channel, .ptyResize(payload))
    }

    private func clearInputRetry(_ session: RoutedSession) {
        session.inputRetryTask?.cancel()
        session.inputRetryTask = nil
    }

    /// ACK 可能在 transport 存活时丢失：500ms 后严格按 seq 重投全部未确认前缀
    /// （device-router.ts:1762-1787）。
    private func scheduleInputRetry(_ route: Route, _ session: RoutedSession, immediate: Bool = false) {
        guard session.desired, !session.detached, !session.retainedInputs.isEmpty else {
            clearInputRetry(session)
            return
        }
        if session.inputRetryTask != nil {
            guard immediate else { return }
            clearInputRetry(session)
        }
        session.inputRetryTask = Task { [weak self] in
            if !immediate {
                try? await Task.sleep(for: Self.inputRetry)
            }
            guard !Task.isCancelled, let self else { return }
            session.inputRetryTask = nil
            guard session.desired, !session.detached, !session.retainedInputs.isEmpty else { return }
            guard let channel = route.sessionLane.active, !channel.closed, session.holderEpoch != nil else {
                self.ensureLaneThen(route, route.sessionLane) { [weak self] in
                    self?.sendAttach(route, session, requireSnapshot: false)
                }
                return
            }
            for input in session.retainedInputs {
                self.sendInputFrame(route, channel, session, input)
            }
            self.scheduleInputRetry(route, session)
        }
    }

    private func handleInputAck(_ route: Route, _ session: RoutedSession, appliedThroughSeq: UInt64) {
        guard appliedThroughSeq > session.ackedInputSeq else { return }
        guard appliedThroughSeq <= session.inputSeq else {
            callbacks.onError("PTY input ACK 越界：\(session.sessionID)")
            return
        }
        session.ackedInputSeq = appliedThroughSeq
        while let first = session.retainedInputs.first, first.seq <= appliedThroughSeq {
            session.retainedInputs.removeFirst()
            session.retainedInputBytes -= first.data.count
        }
        clearInputRetry(session)
        let blocked = session.retainedInputs.count >= Self.maxRetainedInputs
            || session.retainedInputBytes >= Self.maxRetainedInputBytes
        callbacks.onInputBlocked(session.sessionID, blocked)
        if !session.retainedInputs.isEmpty { scheduleInputRetry(route, session) }
    }

    // MARK: - holder 等待（stop 前置）

    private func waitForSessionHolder(_ session: RoutedSession) async throws {
        if session.holderEpoch != nil { return }
        let waiterID = UUID()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            session.holderWaiters[waiterID] = continuation
            Task {
                try? await Task.sleep(for: Self.controlRequestTimeout)
                guard !Task.isCancelled else { return }
                if let pending = session.holderWaiters.removeValue(forKey: waiterID) {
                    pending.resume(throwing: DeviceRouteError("等待 session holder 超时"))
                }
            }
        }
    }

    private func resolveHolderWaiters(_ session: RoutedSession) {
        let waiters = session.holderWaiters
        session.holderWaiters.removeAll()
        for continuation in waiters.values { continuation.resume() }
    }

    private func rejectHolderWaiters(_ session: RoutedSession, _ error: DeviceRouteError) {
        let waiters = session.holderWaiters
        session.holderWaiters.removeAll()
        for continuation in waiters.values { continuation.resume(throwing: error) }
    }

    // MARK: - request/response

    private func request(
        _ route: Route,
        lane: LaneKind,
        requestID: String,
        payload: Coflux_V1_DeviceEnvelope.OneOf_Payload
    ) async throws -> Coflux_V1_DeviceEnvelope.OneOf_Payload {
        try await withCheckedThrowingContinuation { continuation in
            var pending = PendingRequest(
                requestID: requestID, lane: lane, payload: payload,
                sentGeneration: nil, continuation: continuation, timeoutTask: nil
            )
            pending.timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: Self.deviceRequestTimeout)
                guard !Task.isCancelled, let self else { return }
                self.finishPending(route, requestID: requestID,
                                   with: .failure(DeviceRouteError("Device request 超时", code: "request_timeout")))
            }
            route.pendingRequests[requestID] = pending
            let laneRef = lane == .session ? route.sessionLane : route.elevatedLane
            ensureLaneThen(route, laneRef) { [weak self] in
                self?.flushLane(route, lane)
            }
        }
    }

    private func finishPending(
        _ route: Route,
        requestID: String,
        with result: Result<Coflux_V1_DeviceEnvelope.OneOf_Payload, DeviceRouteError>
    ) {
        guard let pending = route.pendingRequests.removeValue(forKey: requestID) else { return }
        pending.timeoutTask?.cancel()
        switch result {
        case .success(let payload): pending.continuation.resume(returning: payload)
        case .failure(let error): pending.continuation.resume(throwing: error)
        }
        releaseIdle(route)
    }

    // MARK: - 收帧

    private func receiveFrame(_ route: Route, _ channel: Channel, _ data: Data) {
        let active = channel.lane == .session ? route.sessionLane.active : route.elevatedLane.active
        guard active === channel, !channel.closed,
              !data.isEmpty, data.count <= DeviceProtocol.maxFrameBytes,
              let envelope = try? Coflux_V1_DeviceEnvelope(serializedBytes: data),
              envelope.protocolVersion == DeviceProtocol.version,
              envelope.channelID == channel.channelID,
              let payload = envelope.payload else { return }
        handleDevicePayload(route, channel, payload)
    }

    private func handleDevicePayload(_ route: Route, _ channel: Channel, _ payload: Coflux_V1_DeviceEnvelope.OneOf_Payload) {
        switch payload {
        case .sessionCatalog(let catalog):
            callbacks.onCatalog(route.daemonID, catalog)
            let eventIDs = catalog.exits.map(\.eventID).filter { !$0.isEmpty }
            if !eventIDs.isEmpty {
                var ack = Coflux_V1_DeviceExitAck()
                ack.eventIds = eventIDs
                sendOn(route, channel, .exitAck(ack))
            }
        case .sessionAttached(let attached):
            handleAttached(route, channel, attached)
        case .ptyOutput(let output):
            handleOutput(route, channel, output)
        case .ptyGap(let gap):
            if let session = route.sessions[gap.sessionID], session.desired {
                requestSnapshotRecovery(route, session)
            }
        case .ptyInputAck(let ack):
            if let session = route.sessions[ack.sessionID] {
                handleInputAck(route, session, appliedThroughSeq: ack.appliedThroughSeq)
            }
        case .sessionDetached(let detached):
            if let session = route.sessions[detached.sessionID] {
                session.desired = false
                session.detached = true
                session.holderEpoch = nil
                session.attachRequestID = nil
                session.attachGeneration = nil
                session.attachedGeneration = nil
                clearInputRetry(session)
                rejectHolderWaiters(session, DeviceRouteError("session holder 已被其它客户端接管", code: "stale_holder"))
                callbacks.onSessionDetached(route.daemonID, session.taskID, session.sessionID,
                                            detached.hasReason ? detached.reason : "holder detached")
                releaseIdle(route)
            }
        case .sessionExited(let exited):
            if let session = route.sessions[exited.sessionID] {
                session.desired = false
                session.detached = false
                session.holderEpoch = nil
                clearInputRetry(session)
                rejectHolderWaiters(session, DeviceRouteError("session 已退出", code: "session_exited"))
                callbacks.onSessionExited(route.daemonID, session.taskID, session.sessionID, exited.exitCode)
                releaseIdle(route)
            }
        case .operationAck(let ack):
            if !ack.operationID.isEmpty { route.pendingOperations[ack.operationID] = nil }
            releaseIdle(route)
        case .error(let deviceError):
            if handleDeviceError(route, channel,
                                 requestID: deviceError.hasRequestID ? deviceError.requestID : nil,
                                 code: deviceError.code, message: deviceError.message) { return }
        default:
            break
        }
        guard let requestID = Self.responseRequestID(payload),
              route.pendingRequests[requestID] != nil else { return }
        finishPending(route, requestID: requestID, with: .success(payload))
    }

    /// 错误码分支语义对照 device-router.ts:1385-1485（relay-only：无心跳/lease 分支）。
    private func handleDeviceError(_ route: Route, _ channel: Channel, requestID: String?, code: String, message: String) -> Bool {
        if let requestID {
            for session in route.sessions.values {
                if session.attachRequestID == requestID {
                    session.attachGeneration = nil
                    session.attachRequestID = nil
                    switch code {
                    case "stale_transport", "scope_denied", "supervisor_busy":
                        closeLane(route, route.sessionLane, reason: message)
                        kickLane(route, route.sessionLane)
                    case "stale_holder":
                        session.desired = false
                        session.detached = true
                        session.holderEpoch = nil
                        clearInputRetry(session)
                        rejectHolderWaiters(session, DeviceRouteError(message, code: code))
                        callbacks.onSessionDetached(route.daemonID, session.taskID, session.sessionID, message)
                        releaseIdle(route)
                    case "session_not_found":
                        // authority 明确说没有这个 session：带 code 拒掉 holder 等待，
                        // 否则 stopSession 要空等到超时（device-router.ts:1423-1431）
                        session.desired = false
                        session.holderEpoch = nil
                        clearInputRetry(session)
                        rejectHolderWaiters(session, DeviceRouteError(message, code: code))
                        callbacks.onError(message)
                        releaseIdle(route)
                    default:
                        callbacks.onError(message)
                    }
                    return true
                }
                if session.retainedInputs.contains(where: { $0.requestID == requestID }) {
                    if code == "input_seq_gap" {
                        scheduleInputRetry(route, session, immediate: true)
                    } else if code != "stale_input" {
                        callbacks.onError(message)
                    }
                    return true
                }
                if session.retainedResize?.requestID == requestID {
                    if code != "stale_resize" { callbacks.onError(message) }
                    return true
                }
            }
            if route.pendingRequests[requestID] != nil {
                if ["scope_denied", "stale_transport", "channel_mismatch", "supervisor_busy"].contains(code) {
                    route.pendingRequests[requestID]?.sentGeneration = nil
                    let lane = route.pendingRequests[requestID]?.lane == .elevated ? route.elevatedLane : route.sessionLane
                    closeLane(route, lane, reason: message)
                    kickLane(route, lane)
                } else {
                    finishPending(route, requestID: requestID, with: .failure(DeviceRouteError(message, code: code)))
                }
                return true
            }
            if let operationID = route.pendingOperations.first(where: { $0.value.requestID == requestID })?.key {
                if ["scope_denied", "stale_transport", "supervisor_busy"].contains(code) {
                    route.pendingOperations[operationID]?.sentGeneration = nil
                    closeLane(route, route.elevatedLane, reason: message)
                    kickLane(route, route.elevatedLane)
                } else {
                    route.pendingOperations[operationID] = nil
                    callbacks.onError(message)
                    releaseIdle(route)
                }
                return true
            }
        }
        callbacks.onError(message)
        return true
    }

    // MARK: - catalog

    private func sendCatalogRequest(_ route: Route) {
        guard sessionLaneDemand(route), let channel = route.sessionLane.active, !channel.closed else { return }
        var request = Coflux_V1_DeviceSessionCatalogRequest()
        request.requestID = UUID().uuidString
        sendOn(route, channel, .sessionCatalogRequest(request))
    }

    private func maintainCatalogTimer(_ route: Route) {
        guard sessionLaneDemand(route), route.sessionLane.active != nil else {
            route.catalogTask?.cancel()
            route.catalogTask = nil
            return
        }
        guard route.catalogTask == nil else { return }
        route.catalogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.catalogInterval)
                guard !Task.isCancelled, let self else { return }
                self.sendCatalogRequest(route)
            }
        }
    }

    // MARK: - 静态映射

    private static func requestID(of payload: Coflux_V1_DeviceEnvelope.OneOf_Payload) -> String? {
        switch payload {
        case .sessionCatalogRequest(let value): return value.requestID
        case .sessionAttach(let value): return value.requestID
        case .sessionSnapshotRequest(let value): return value.requestID
        case .ptyInput(let value): return value.requestID
        case .ptyResize(let value): return value.requestID
        case .sessionStop(let value): return value.requestID
        case .sessionCreate(let value): return value.requestID
        default: return nil
        }
    }

    private static func responseRequestID(_ payload: Coflux_V1_DeviceEnvelope.OneOf_Payload) -> String? {
        switch payload {
        case .sessionCatalog(let value): return value.requestID
        case .sessionAttached(let value): return value.requestID
        case .sessionSnapshot(let value): return value.requestID
        case .operationAck(let value): return value.requestID
        case .error(let value): return value.hasRequestID ? value.requestID : nil
        default: return nil
        }
    }

    private static func preparedOperationID(_ payload: Coflux_V1_DeviceEnvelope.OneOf_Payload) -> String? {
        switch payload {
        case .sessionCreate(let value): return value.operationID
        case .projectValidate(let value): return value.operationID
        case .worktreeAdd(let value): return value.operationID
        case .worktreeRemove(let value): return value.operationID
        default: return nil
        }
    }

    private func rejectRelayWaiters(_ message: String) {
        let waiters = relayWaiters
        relayWaiters.removeAll()
        for waiter in waiters.values {
            waiter.timeoutTask?.cancel()
            waiter.continuation.resume(throwing: DeviceRouteError(message))
        }
    }
}

/// 简单超时竞速：body 与定时器谁先完成用谁；超时抛 DeviceRouteError。
private func withTimeout<T: Sendable>(
    _ timeout: Duration,
    message: String,
    _ body: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await body() }
        group.addTask {
            try await Task.sleep(for: timeout)
            throw DeviceRouteError(message, code: "timeout")
        }
        guard let result = try await group.next() else {
            throw DeviceRouteError(message, code: "timeout")
        }
        group.cancelAll()
        return result
    }
}

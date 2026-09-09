import CofluxProtocol
import Foundation
import Observation

enum AuthCredential: Sendable, Equatable {
    case token(String)
    case password(username: String, password: String)
}

/// /client 链路的连接 + 认证 + 控制面归约。对照 packages/client 的 connection.ts（全部）
/// 与 store.ts（实体归约子集）；PTY 域（device-router/attach/checkpoint/ports）刻意留白，
/// 第二片以 store.ts 为语义基准扩展（plan 044）。
///
/// 归约语义与 TS 版严格一致：按到达顺序应用不做乱序缓冲；每条消息一次原子提交
/// （MainActor 上同步完成，订阅者只见一致状态，store.ts:320-322）。
@MainActor
@Observable
public final class CofluxClient {
    public private(set) var status: ConnectionStatus = .disconnected
    public private(set) var authState: AuthState = .needLogin
    /// 仅使用中心认证结果命名本地配对空间；不以用户输入的账号名推断身份。
    public private(set) var accountID: String?
    public private(set) var syncState: SyncState = .notSubscribed
    public private(set) var loginError = ""
    public private(set) var daemons: [Coflux_V1_DaemonInfo] = []
    public private(set) var projects: [Coflux_V1_Project] = []
    public private(set) var workspaces: [Coflux_V1_Workspace] = []
    public private(set) var tasks: [Coflux_V1_Task] = []
    public private(set) var lastError: ClientError?
    /// 每次 stateSnapshot 自增（store.ts:392）；第二片终端 re-attach 依赖它判定重连边界。
    public private(set) var snapshotRevision = 0
    /// 被其它客户端接管的任务（plan 026 旁观语义）：UI 出横幅，仅强制接管可恢复。
    public private(set) var detachedTaskIDs: Set<String> = []
    /// 仅由显式启动/连接请求进入；后台 RUNNING 不等于正在连接。
    public private(set) var attachingTaskIDs: Set<String> = []
    private var attachIndicatorTimers: [String: Task<Void, Never>] = [:]
    private func finishAttachIndicator(_ taskID: String) {
        attachIndicatorTimers.removeValue(forKey: taskID)?.cancel()
        attachingTaskIDs.remove(taskID)
    }
    private func clearAttachIndicators() {
        for id in Array(attachingTaskIDs) { finishAttachIndicator(id) }
    }
    private func beginAttachIndicator(_ taskID: String, running: Bool) {
        finishAttachIndicator(taskID)
        attachingTaskIDs.insert(taskID)
        attachIndicatorTimers[taskID] = Task { [weak self] in
            // 与 Web 的 attach grace 一样只结束视觉反馈，不据此授予输入控制权。
            try? await Task.sleep(for: running ? .milliseconds(500) : .seconds(15))
            guard !Task.isCancelled else { return }
            self?.finishAttachIndicator(taskID)
        }
    }
    /// server 侧终端镜像（sessionCheckpoint）：无 live session 时的只读回放来源。
    public private(set) var sessionCheckpoints: [String: Coflux_V1_SessionCheckpoint] = [:]
    /// 输入台账触顶的 session（等待 PTY 累计确认）：UI 提示输入受阻。
    public private(set) var blockedSessionIDs: Set<String> = []
    /// 正在上传文件/图片的 session（plan 071）：UI 据此把入口键置忙态、禁重复触发。
    public private(set) var uploadingSessionIDs: Set<String> = []
    /// taskId → 当前端口预览；快照全替换，PortsUpdated 按 task upsert。
    public private(set) var ports: [String: [Coflux_V1_PortPreview]] = [:]

    public struct SessionAgentInfo: Equatable, Sendable {
        public var daemonID: String
        public var session: Coflux_V1_SessionAgentRef

        public init(daemonID: String, session: Coflux_V1_SessionAgentRef) {
            self.daemonID = daemonID
            self.session = session
        }
    }
    public struct LocalSessionInfo: Equatable, Sendable {
        public var daemonID: String
        public var session: Coflux_V1_DeviceSessionInfo
        public var exit: Coflux_V1_DeviceSessionExitTombstone?
    }
    public private(set) var localSessions: [LocalSessionInfo] = []

    /// sessionId → agent presence；StateSnapshot 后清空，server 随后按 daemon 补全。
    public private(set) var sessionAgents: [String: SessionAgentInfo] = [:]

    /// 工作区进度短评（plan 088）：RUNNING 任务的 presence 里第一条非空 progress。
    /// 与活动状态是两个维度——状态由 hooks 自动判定，短评由 agent 经 `cofluxd progress`
    /// 主动播报、跨 hook 事件存活（store.ts workspaceProgress 同语义）。
    public func workspaceProgress(workspaceID: String) -> String? {
        for task in tasks where task.workspaceID == workspaceID && task.status == .running && task.hasSessionID {
            if let info = sessionAgents[task.sessionID], !info.session.progress.isEmpty {
                return info.session.progress
            }
        }
        return nil
    }

    /// 设备面板（plan 077）：per-daemon 传输可观测状态。relayHost = 正在经过的 relay 节点
    /// host；rttMs = 最近一次 DevicePing 往返。仅设备页在场（retainDeviceMeasure）时点亮。
    public struct DeviceTransportInfo: Equatable, Sendable {
        public var relayHost: String?
        public var rttMs: Double?
        public var mode: String?
        public var detail: String

        public init(relayHost: String?, rttMs: Double?, mode: String? = nil, detail: String = "") {
            self.relayHost = relayHost
            self.rttMs = rttMs
            self.mode = mode
            self.detail = detail
        }
    }
    public private(set) var deviceTransports: [String: DeviceTransportInfo] = [:]

    private let configuration: ClientConfiguration
    private let transport: any Transport
    private let tokenStore: any TokenStore
    private let logger: any ClientLogger
    private let clock: any ClientClock
    private let jitter: any RetryJitterSource

    private var token: String?
    /// authOk 后才允许自动重连（store.ts shouldRetry 同语义）；authError/登出/版本失配收回。
    private var shouldRetry = false
    /// 控制面已认证（store.ts controlAuthenticated 同语义）：device rendezvous 与
    /// taskRemove 的前置门。
    private var controlAuthenticated = false
    private var pendingTaskRemovals: [String] = []
    /// 与连接重建分开：同一登录的重连保留记账，显式换凭据则隔离旧异步操作。
    private var removalEpoch = 0
    private func resetPendingTaskRemovals() {
        removalEpoch += 1
        pendingTaskRemovals.removeAll()
    }
    private var reconnectAttempts = 0
    /// 连接代际：每次重建/断开自增，旧循环与旧重连计时器以代际不符自行退出。
    private var generation = 0
    private var connectionTask: Task<Void, Never>?
    private var currentConnection: (any TransportConnection)?
    private var sendTail: Task<Void, Never>?
    private var watchdogTask: Task<Void, Never>?
    private var errorSequence = 0
    private var suspendedInBackground = false

    /// PTY 数据面（plan 046）。输出字节不进可观察状态：经 consumer 闭包直达终端 feed。
    private var deviceRouter: DeviceRouter!
    /// 单 consumer（iOS 同刻只有一个详情页；web 版的多 consumer 集合是超配，store.ts:298）。
    private var sessionConsumers: [String: (Data, _ replace: Bool) -> Void] = [:]
    /// 注册令牌：换绑竞态下旧 release 闭包不得误删新 consumer。
    private var sessionConsumerTokens: [String: UUID] = [:]
    private var liveSessionIDs: Set<String> = []
    /// 设备事实先于中心事实到达的窗口：session 已退出但 server task 还没更新（store.ts:376-384
    /// localSessions 合并语义的最小移植——iOS 无 UI 消费 pid/cwd，只留退出覆盖）。
    private var localExits: [String: Int32] = [:]
    // 保留中心的原始运行事实，不能用设备退出覆盖后的 UI 状态判断是否可以 durable create。
    private var serverRunningSessions: [String: String] = [:]

    public init(
        configuration: ClientConfiguration,
        transport: any Transport,
        tokenStore: any TokenStore,
        localDeviceProvider: (any LocalDeviceTransportProvider)? = nil,
        p2pDeviceProvider: (any P2PDeviceTransportProvider)? = nil,
        logger: any ClientLogger = NoopClientLogger(),
        clock: any ClientClock = SystemClientClock(),
        jitter: any RetryJitterSource = SystemRetryJitterSource()
    ) {
        self.configuration = configuration
        self.transport = transport
        self.tokenStore = tokenStore
        self.logger = logger
        self.clock = clock
        self.jitter = jitter
        var tokenReadError: Error?
        do {
            token = try tokenStore.read()
        } catch {
            token = nil
            tokenReadError = error
        }
        deviceRouter = DeviceRouter(transport: transport, callbacks: DeviceRouterCallbacks(
            sendControl: { [weak self] payload in self?.send(payload) },
            onSessionSnapshot: { [weak self] _, _, sessionID, data in
                self?.liveSessionIDs.insert(sessionID)
                self?.sessionConsumers[sessionID]?(data, true)
            },
            onSessionOutput: { [weak self] _, _, sessionID, data in
                self?.liveSessionIDs.insert(sessionID)
                self?.sessionConsumers[sessionID]?(data, false)
            },
            onSessionAttached: { [weak self] _, taskID, _ in
                self?.finishAttachIndicator(taskID)
                self?.detachedTaskIDs.remove(taskID)
            },
            onSessionDetached: { [weak self] _, taskID, _, _ in
                self?.finishAttachIndicator(taskID)
                self?.detachedTaskIDs.insert(taskID)
            },
            onSessionExited: { [weak self] daemonID, taskID, sessionID, exitCode in
                self?.finishAttachIndicator(taskID)
                self?.recordLocalExit(daemonID: daemonID, taskID: taskID, sessionID: sessionID, exitCode: exitCode)
                self?.markSessionExited(taskID: taskID, sessionID: sessionID, exitCode: exitCode)
            },
            onCatalog: { [weak self] daemonID, catalog in
                self?.updateLocalCatalog(daemonID: daemonID, catalog: catalog)
            },
            onError: { [weak self] message in self?.reportLocalError(message) },
            onInputBlocked: { [weak self] sessionID, blocked in
                if blocked { self?.blockedSessionIDs.insert(sessionID) } else { self?.blockedSessionIDs.remove(sessionID) }
            },
            onDeviceTransport: { [weak self] daemonID, relayHost, rttMs, mode, detail in
                self?.deviceTransports[daemonID] = relayHost == nil && rttMs == nil && mode == nil
                    ? nil : DeviceTransportInfo(relayHost: relayHost, rttMs: rttMs, mode: mode, detail: detail)
            }
        ), localProvider: localDeviceProvider, p2pProvider: p2pDeviceProvider)
        if let tokenReadError {
            reportLocalError("无法读取本机会话：\(Self.describeLocalError(tokenReadError))")
        }
        if let token {
            // 有本地会话 token 时首屏直接 authenticating，避免闪登录页（store.ts:122-127）
            shouldRetry = true
            authState = .authenticating
            startConnection(credential: .token(token))
        }
    }

    // MARK: - 对外操作

    /// 登录：账号密码直发 clientAuth 帧（plan 061——server 侧 local/password 两模式同帧，
    /// 外部 IdP 两跳换票已随 plan 059 退役）。
    public func login(username: String, password: String) {
        clearAttachIndicators()
        resetPendingTaskRemovals()
        deviceRouter.setControlOnline(false)
        deviceRouter.setAccountID(nil)
        loginError = ""
        shouldRetry = false
        authState = .authenticating
        connectAuthenticating(credential: .password(username: username, password: password))
    }

    public func logout() {
        clearAttachIndicators()
        resetPendingTaskRemovals()
        accountID = nil
        shouldRetry = false
        token = nil
        lastError = nil
        errorSequence = 0
        do {
            try tokenStore.clear()
        } catch {
            reportLocalError("无法清除本机会话：\(Self.describeLocalError(error))")
        }
        generation += 1
        connectionTask?.cancel()
        connectionTask = nil
        watchdogTask?.cancel()
        watchdogTask = nil
        let pendingSend = sendTail
        sendTail = nil
        let connection = currentConnection
        currentConnection = nil
        controlAuthenticated = false
        deviceRouter.setControlOnline(false)
        deviceRouter.reset()
        Task {
            // 先投递服务端撤销再关闭（ClientLogout 使会话 token 服务端失效，非仅清本地）
            if let connection {
                await pendingSend?.value
                if let frame = try? Wire.encode(.clientLogout(Coflux_V1_ClientLogout())) {
                    try? await connection.send(frame)
                }
                await connection.close()
            }
        }
        status = .disconnected
        authState = .needLogin
        syncState = .notSubscribed
        daemons = []
        projects = []
        workspaces = []
        tasks = []
        ports = [:]
        sessionAgents = [:]
        detachedTaskIDs = []
        sessionCheckpoints = [:]
        blockedSessionIDs = []
        uploadingSessionIDs = []
        liveSessionIDs = []
        localExits = [:]
        localSessions = []
        serverRunningSessions = [:]
        deviceTransports = [:]
        sessionConsumers = [:]
        sessionConsumerTokens = [:]
        snapshotRevision = 0
    }

    /// 进后台：主动断连并取消重连计时器（iOS 不保证后台 WS 存活；会话韧性在 server/daemon 侧）。
    /// 设备通道随控制面一起关（relay 存活依赖中心）；session desired 保留，回前台重挂。
    public func suspend() {
        clearAttachIndicators()
        guard connectionTask != nil || currentConnection != nil else { return }
        suspendedInBackground = true
        generation += 1
        connectionTask?.cancel()
        connectionTask = nil
        watchdogTask?.cancel()
        watchdogTask = nil
        sendTail = nil
        let connection = currentConnection
        currentConnection = nil
        Task { await connection?.close() }
        status = .disconnected
        controlAuthenticated = false
        deviceRouter.setControlOnline(false)
    }

    /// 回前台：无条件废弃旧连接重建，不探测旧 socket 活性（系统超时可达分钟级）。
    public func resume() {
        guard suspendedInBackground else { return }
        suspendedInBackground = false
        if shouldRetry, let token {
            reconnectAttempts = 0
            startConnection(credential: .token(token))
        } else if authState == .authenticating {
            // 登录中途被切后台：凭证已随连接作废，退回登录页
            authState = .needLogin
        }
    }

    // MARK: - 连接生命周期

    private func connectAuthenticating(credential: AuthCredential) {
        // 断线重登时已 authed 则保持：保留最后快照渲染，由横幅提示（store.ts:517-519）
        if authState != .authed { authState = .authenticating }
        startConnection(credential: credential)
    }

    private func startConnection(credential: AuthCredential) {
        generation += 1
        let gen = generation
        connectionTask?.cancel()
        watchdogTask?.cancel()
        watchdogTask = nil
        sendTail = nil
        let stale = currentConnection
        currentConnection = nil
        status = .connecting
        // 网络重连保留既有 session 的有界宽限；新连接和 elevated 能力立即失效。
        controlAuthenticated = false
        deviceRouter.setControlDisconnected()
        armAuthenticationDeadline(generation: gen)
        connectionTask = Task {
            // 换新连接前先关旧的，否则 server 侧残留幽灵连接（connection.ts:75-77）
            await stale?.close()
            await runConnection(credential: credential, generation: gen)
        }
    }

    private func runConnection(credential: AuthCredential, generation gen: Int) async {
        do {
            let connection = try await transport.connect(to: configuration.serverURL)
            guard generation == gen, !Task.isCancelled else {
                await connection.close()
                return
            }
            currentConnection = connection
            // Swift send 会挂起：必须先武装。否则 send 永不返回时无法自愈，或回包先被
            // receive loop 消费、send 随后返回再误挂一个无人解除的 watchdog。
            try await connection.send(Wire.encode(.clientAuth(authPayload(credential))))
            guard generation == gen, !Task.isCancelled else { return }
            status = .connected
            while true {
                let data = try await connection.receive()
                guard generation == gen else { return }
                if controlAuthenticated {
                    watchdogTask?.cancel()
                    watchdogTask = nil
                }
                if let payload = Wire.decode(data) {
                    apply(payload)
                }
            }
        } catch {
            // 统一走断线路径：具体错误对控制面无区分价值（TS onclose 同语义）
        }
        guard generation == gen, !Task.isCancelled else { return }
        finishFailedConnection(message: "连接已中断，请检查网络后重试。")
    }

    /// 认证总时限覆盖建连、发送和等待认证结果；无关入站不能解除它。
    private func armAuthenticationDeadline(generation gen: Int) {
        let clock = clock
        watchdogTask = Task { [weak self] in
            do { try await clock.sleep(seconds: 10) } catch { return }
            guard let self, !Task.isCancelled, self.generation == gen else { return }
            self.finishFailedConnection(message: "登录超时，请检查网络后重试。")
        }
    }

    private func finishFailedConnection(message: String) {
        // 先废弃代际并恢复界面，不能依赖底层 close 或 connect 及时返回。
        closeCurrentConnection()
        controlAuthenticated = false
        deviceRouter.setControlDisconnected()
        if authState == .authenticating {
            loginError = message
            authState = .authFailed
        }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard shouldRetry, token != nil, !suspendedInBackground else { return }
        let delay = jitter.delay(ceiling: Self.reconnectCeiling(attempt: reconnectAttempts))
        reconnectAttempts += 1
        let gen = generation
        connectionTask = Task {
            try? await clock.sleep(seconds: delay)
            guard !Task.isCancelled, generation == gen, shouldRetry, let token else { return }
            startConnection(credential: .token(token))
        }
    }

    /// 指数退避 ~1s 起步 ~15s 封顶（connection.ts:56-62 同参数）。
    nonisolated static func reconnectCeiling(attempt: Int) -> Double {
        min(15.0, pow(2.0, Double(min(attempt, 10))))
    }

    nonisolated static func reconnectDelay(attempt: Int) -> Double {
        let backoff = reconnectCeiling(attempt: attempt)
        return backoff / 2 + Double.random(in: 0 ... backoff / 2)
    }

    // MARK: - 归约（store.ts handleServerMessage 控制面子集）

    func apply(_ payload: Coflux_V1_ServerToClient.OneOf_Payload) {
        // device 域负载（relayGrant/preparedOperation）先经路由消费（store.ts:324）
        if deviceRouter.handleControlPayload(payload) { return }
        switch payload {
        case .authOk(let value):
            watchdogTask?.cancel()
            watchdogTask = nil
            if accountID != nil && accountID != value.accountID { resetPendingTaskRemovals() }
            accountID = value.accountID.isEmpty ? nil : value.accountID
            deviceRouter.setAccountID(accountID)
            deviceRouter.setIceServers(value.iceServers)
            authState = .authed
            syncState = .awaitingSnapshot
            loginError = ""
            shouldRetry = true
            reconnectAttempts = 0
            controlAuthenticated = true
            deviceRouter.setControlOnline(true)
            if value.hasClientToken, !value.clientToken.isEmpty {
                token = value.clientToken
                do {
                    try tokenStore.write(value.clientToken)
                } catch {
                    reportLocalError("无法保存本机会话：\(Self.describeLocalError(error))")
                }
            }
            send(.clientSubscribe(Coflux_V1_ClientSubscribe()))
            let removals = pendingTaskRemovals
            pendingTaskRemovals.removeAll()
            for taskID in removals { removeTask(taskID: taskID) }

        case .authError:
            clearAttachIndicators()
            resetPendingTaskRemovals()
            accountID = nil
            deviceRouter.setAccountID(nil)
            // token 已被服务端视为无效：清 token + 停重连（继续退避=凭证风暴，store.ts:341-351）
            token = nil
            do {
                try tokenStore.clear()
            } catch {
                reportLocalError("无法清除失效会话：\(Self.describeLocalError(error))")
            }
            shouldRetry = false
            controlAuthenticated = false
            deviceRouter.setControlOnline(false)
            syncState = .notSubscribed
            loginError = "登录失败：账号或密码错误，或会话已过期"
            authState = .authFailed
            closeCurrentConnection()

        case .clientOutdated:
            clearAttachIndicators()
            deviceRouter.setAccountID(nil)
            shouldRetry = false
            controlAuthenticated = false
            deviceRouter.setControlOnline(false)
            syncState = .notSubscribed
            authState = .outdated
            closeCurrentConnection()

        case .stateSnapshot(let value):
            let incomingDaemonIDs = Set(value.daemons.map(\.daemonID))
            for daemon in daemons where !incomingDaemonIDs.contains(daemon.daemonID) {
                deviceRouter.removeDaemon(daemon.daemonID)
                deviceTransports[daemon.daemonID] = nil
            }
            localSessions.removeAll { !incomingDaemonIDs.contains($0.daemonID) }
            let incomingTasks = Dictionary(value.tasks.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
            let staleTasks = tasks.filter { previous in
                guard let incoming = incomingTasks[previous.id] else { return true }
                let previousSession = previous.hasSessionID ? previous.sessionID : nil
                let incomingSession = incoming.hasSessionID ? incoming.sessionID : nil
                return previousSession != incomingSession
            }
            clearDerivedState(for: staleTasks)
            daemons = value.daemons
            projects = value.projects
            workspaces = value.workspaces
            serverRunningSessions = Dictionary(value.tasks.compactMap { task in
                task.status == .running && task.hasSessionID ? (task.id, task.sessionID) : nil
            }, uniquingKeysWith: { _, latest in latest })
            tasks = value.tasks.map(applyLocalExit)
            ports = Dictionary(value.ports.map { ($0.taskID, $0.ports) }, uniquingKeysWith: { _, latest in latest })
            sessionAgents = [:]
            let taskIDs = Set(value.tasks.map(\.id))
            detachedTaskIDs = detachedTaskIDs.intersection(taskIDs)
            snapshotRevision += 1
            syncState = .synced

        case .daemonUpdated(let value):
            // 显式 presence：服务端必填的内嵌 message 缺失按畸形消息丢弃（store.ts:399）
            guard value.hasDaemon else { break }
            upsert(&daemons, value.daemon) { $0.daemonID == value.daemon.daemonID }

        case .daemonRemoved(let value):
            deviceRouter.removeDaemon(value.daemonID)
            localSessions.removeAll { $0.daemonID == value.daemonID }
            let removedTasks = tasks.filter { $0.daemonID == value.daemonID }
            clearDerivedState(for: removedTasks)
            daemons.removeAll { $0.daemonID == value.daemonID }
            projects.removeAll { $0.daemonID == value.daemonID }
            workspaces.removeAll { $0.daemonID == value.daemonID }
            tasks.removeAll { $0.daemonID == value.daemonID }
            sessionAgents = sessionAgents.filter { $0.value.daemonID != value.daemonID }
            deviceTransports[value.daemonID] = nil

        case .projectCreated(let value):
            guard value.hasProject else { break }
            upsert(&projects, value.project) { $0.id == value.project.id }

        case .projectRemoved(let value):
            let removedTasks = tasks.filter { $0.projectID == value.projectID }
            clearDerivedState(for: removedTasks)
            projects.removeAll { $0.id == value.projectID }
            workspaces.removeAll { $0.projectID == value.projectID }
            tasks.removeAll { $0.projectID == value.projectID }

        case .workspaceCreated(let value):
            guard value.hasWorkspace else { break }
            upsert(&workspaces, value.workspace) { $0.id == value.workspace.id }

        case .workspaceRemoved(let value):
            let removedTasks = tasks.filter { $0.workspaceID == value.workspaceID }
            clearDerivedState(for: removedTasks)
            workspaces.removeAll { $0.id == value.workspaceID }
            tasks.removeAll { $0.workspaceID == value.workspaceID }

        case .taskUpdated(let value):
            guard value.hasTask else { break }
            serverRunningSessions[value.task.id] = value.task.status == .running && value.task.hasSessionID ? value.task.sessionID : nil
            let task = applyLocalExit(value.task)
            if let previous = tasks.first(where: { $0.id == task.id }) {
                let previousSession = previous.hasSessionID ? previous.sessionID : nil
                let nextSession = task.hasSessionID ? task.sessionID : nil
                if previousSession != nextSession || task.status != .running {
                    clearDerivedState(for: [previous])
                }
            }
            upsert(&tasks, task) { $0.id == task.id }
            if task.status != .running { detachedTaskIDs.remove(task.id) }

        case .taskRemoved(let value):
            finishAttachIndicator(value.taskID)
            serverRunningSessions[value.taskID] = nil
            let removed = tasks.first { $0.id == value.taskID }
            if let removed { clearDerivedState(for: [removed]) }
            tasks.removeAll { $0.id == value.taskID }

        case .sessionCheckpoint(let checkpoint):
            // server 侧终端镜像：live 输出在场时不覆盖现场，只在无 live 时投给终端做只读回放
            sessionCheckpoints[checkpoint.sessionID] = checkpoint
            if !liveSessionIDs.contains(checkpoint.sessionID) {
                sessionConsumers[checkpoint.sessionID]?(checkpoint.ansiSnapshot, true)
            }

        case .portsUpdated(let value):
            ports[value.taskID] = value.ports

        case .sessionAgentsUpdated(let value):
            sessionAgents = sessionAgents.filter { $0.value.daemonID != value.daemonID }
            for session in value.sessions where !session.sessionID.isEmpty {
                sessionAgents[session.sessionID] = SessionAgentInfo(daemonID: value.daemonID, session: session)
            }

        case .error(let value):
            clearAttachIndicators()
            errorSequence += 1
            lastError = ClientError(id: errorSequence, message: value.message)

        default:
            break // ports 等无 UI 消费的负载
        }
    }

    /// 设备事实覆盖：session 已在设备侧退出的 task，不采信 server 的 RUNNING 残影
    /// （store.ts:376-384 合并语义）。
    private func applyLocalExit(_ task: Coflux_V1_Task) -> Coflux_V1_Task {
        guard task.hasSessionID, let exitCode = localExits[task.sessionID] else { return task }
        var adjusted = task
        adjusted.status = .exited
        adjusted.clearSessionID()
        adjusted.exitCode = exitCode
        return adjusted
    }

    func updateLocalCatalog(daemonID: String, catalog: Coflux_V1_DeviceSessionCatalog) {
        for session in catalog.sessions {
            let entry = LocalSessionInfo(daemonID: daemonID, session: session)
            if let index = localSessions.firstIndex(where: { $0.daemonID == daemonID && $0.session.sessionID == session.sessionID }) {
                localSessions[index] = entry
            } else { localSessions.append(entry) }
        }
        for exit in catalog.exits {
            recordLocalExit(daemonID: daemonID, taskID: exit.taskID, sessionID: exit.sessionID, exitCode: exit.exitCode, tombstone: exit)
            markSessionExited(taskID: exit.taskID, sessionID: exit.sessionID, exitCode: exit.exitCode)
        }
    }

    private func recordLocalExit(daemonID: String, taskID: String, sessionID: String, exitCode: Int32,
                                 tombstone: Coflux_V1_DeviceSessionExitTombstone? = nil) {
        let index = localSessions.firstIndex { $0.daemonID == daemonID && $0.session.sessionID == sessionID }
        var session = index.map { localSessions[$0].session } ?? Coflux_V1_DeviceSessionInfo()
        session.sessionID = sessionID; session.taskID = taskID
        var exit = tombstone ?? index.flatMap { localSessions[$0].exit } ?? Coflux_V1_DeviceSessionExitTombstone()
        exit.sessionID = sessionID; exit.taskID = taskID; exit.exitCode = exitCode
        if let tombstone { session.outputSeq = tombstone.finalOutputSeq }
        let entry = LocalSessionInfo(daemonID: daemonID, session: session, exit: exit)
        if let index { localSessions[index] = entry } else { localSessions.append(entry) }
    }

    public func orphanSessions(daemonID: String) -> [LocalSessionInfo] {
        localSessions.filter { item in
            item.daemonID == daemonID && item.exit == nil &&
                !tasks.contains { $0.id == item.session.taskID && $0.hasSessionID && $0.sessionID == item.session.sessionID }
        }
    }

    func markSessionExited(taskID: String, sessionID: String, exitCode: Int32) {
        localExits[sessionID] = exitCode
        liveSessionIDs.remove(sessionID)
        blockedSessionIDs.remove(sessionID)
        detachedTaskIDs.remove(taskID)
        // session 已退出：presence 必须和 task 的 sessionID 同步消失，否则后续 taskRemoved
        // 已无法再从 task 反查旧 session，UI 会永久留下僵尸 agent（store.ts:263-265）。
        sessionAgents[sessionID] = nil
        tasks = tasks.map { task in
            guard task.id == taskID, task.hasSessionID, task.sessionID == sessionID else { return task }
            var adjusted = task
            adjusted.status = .exited
            adjusted.clearSessionID()
            adjusted.exitCode = exitCode
            return adjusted
        }
    }

    private func clearDerivedState(for removedTasks: [Coflux_V1_Task]) {
        for task in removedTasks { finishAttachIndicator(task.id) }
        for task in removedTasks {
            detachedTaskIDs.remove(task.id)
            ports[task.id] = nil
            guard task.hasSessionID else { continue }
            let sessionID = task.sessionID
            sessionCheckpoints[sessionID] = nil
            blockedSessionIDs.remove(sessionID)
            uploadingSessionIDs.remove(sessionID)
            liveSessionIDs.remove(sessionID)
            localExits[sessionID] = nil
            sessionAgents[sessionID] = nil
            sessionConsumers[sessionID] = nil
            sessionConsumerTokens[sessionID] = nil
            deviceRouter.forgetSession(daemonID: task.daemonID, sessionID: sessionID)
        }
    }

    // MARK: - 任务/终端操作（store.ts:566-609 + 279-318 对应面）

    /// 新建终端任务。taskCreate 无请求-响应关联（workspace-detail.tsx:188 同语义）：
    /// 自建任务的识别与激活由 view 侧靠快照增量的未知 task id 完成。
    public func createTask(workspaceID: String, title: String) {
        guard controlAuthenticated else {
            reportLocalError("中心未连接，无法新建终端")
            return
        }
        var create = Coflux_V1_TaskCreate()
        create.workspaceID = workspaceID
        create.title = title
        send(.taskCreate(create))
    }

    /// 设备先报告退出、中心尚未落库时，等待中心确认后再重启；调用方取消后不再发送。
    public func startTaskWhenReady(taskID: String, cols: UInt32, rows: UInt32) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while true {
            try Task.checkCancellation()
            guard controlAuthenticated, status == .connected else { throw DeviceRouteError("连接已断开，请重试启动终端") }
            guard tasks.contains(where: { $0.id == taskID }) else { throw DeviceRouteError("终端已被删除") }
            guard let session = serverRunningSessions[taskID], localExits[session] != nil else { break }
            guard ContinuousClock.now < deadline else { throw DeviceRouteError("等待服务器确认终端退出超时，请重试") }
            try await Task.sleep(for: .milliseconds(20))
        }
        startTask(taskID: taskID, cols: cols, rows: rows)
    }

    /// RUNNING 的 attach 直接交给 session authority；IDLE/EXITED 由中心 prepare durable create。
    public func startTask(taskID: String, cols: UInt32, rows: UInt32, force: Bool = false) {
        if let task = tasks.first(where: { $0.id == taskID }), !detachedTaskIDs.contains(taskID) || force {
            let running = task.status == .running && task.hasSessionID
            // 已持有当前通道控制权时，重新选择标签不会发起 attach，不应制造连接忙态。
            if force || !running || !deviceRouter.hasSessionControl(daemonID: task.daemonID, sessionID: task.sessionID) {
                beginAttachIndicator(taskID, running: running)
            }
        }
        if let task = tasks.first(where: { $0.id == taskID }), task.status == .running, task.hasSessionID {
            if force { detachedTaskIDs.remove(taskID) }
            deviceRouter.attachSession(
                daemonID: task.daemonID, taskID: task.id, sessionID: task.sessionID,
                cols: cols, rows: rows, force: force
            )
            return
        }
        detachedTaskIDs.remove(taskID)
        var start = Coflux_V1_TaskStart()
        start.taskID = taskID
        start.cols = cols
        start.rows = rows
        send(.taskStart(start))
    }

    /// 先停止设备会话；中心短断时暂存目录删除，恢复认证后补发。
    public func closeTask(_ task: Coflux_V1_Task) async {
        guard let closingAccount = accountID else { return }
        let epoch = removalEpoch
        if task.status == .running, task.hasSessionID {
            do {
                deviceRouter.attachSession(
                    daemonID: task.daemonID, taskID: task.id, sessionID: task.sessionID,
                    cols: 80, rows: 24, force: true
                )
                try await deviceRouter.stopSession(daemonID: task.daemonID, sessionID: task.sessionID)
            } catch let error as DeviceRouteError {
                guard epoch == removalEpoch, accountID == closingAccount else { return }
                // session_not_found 是「设备侧已经没有它」的确定答复，继续删 catalog task
                // 才能收敛（store.ts:583-589）；其余错误中止，不猜测设备状态。
                guard error.code == "session_not_found" else {
                    reportLocalError(error.message)
                    return
                }
            } catch {
                guard epoch == removalEpoch, accountID == closingAccount else { return }
                reportLocalError(String(describing: error))
                return
            }
        }
        guard epoch == removalEpoch, accountID == closingAccount else { return }
        removeTask(taskID: task.id)
    }

    private func removeTask(taskID: String) {
        guard controlAuthenticated else {
            if !pendingTaskRemovals.contains(taskID) { pendingTaskRemovals.append(taskID) }
            return
        }
        var remove = Coflux_V1_TaskRemove()
        remove.taskID = taskID
        send(.taskRemove(remove))
    }

    public func sendInput(sessionID: String, _ text: String) {
        guard let data = text.data(using: .utf8), !data.isEmpty else { return }
        sendInput(sessionID: sessionID, data: data)
    }

    /// 原生终端的鼠标/键盘序列按字节透传，不能因 UTF-8 转换失败静默丢弃。
    public func sendInput(sessionID: String, data: Data) {
        guard !data.isEmpty else { return }
        guard let task = tasks.first(where: { $0.hasSessionID && $0.sessionID == sessionID }) else {
            reportLocalError("会话不存在，无法发送终端输入")
            return
        }
        deviceRouter.sendInput(daemonID: task.daemonID, sessionID: sessionID, data: data)
    }

    public func hasSessionControl(sessionID: String) -> Bool {
        guard let task = tasks.first(where: { $0.status == .running && $0.hasSessionID && $0.sessionID == sessionID }) else { return false }
        return deviceRouter.hasSessionControl(daemonID: task.daemonID, sessionID: sessionID)
    }

    /// 桌面上传只返回设备确认的路径；是否使用 bracketed paste 由终端当前模式决定。
    public func uploadSessionFile(sessionID: String, data: Data, suggestedName: String) async throws -> String {
        guard let task = tasks.first(where: { $0.status == .running && $0.hasSessionID && $0.sessionID == sessionID }),
              hasSessionControl(sessionID: sessionID) else {
            throw DeviceRouteError("未持有控制权，无法上传文件")
        }
        let result = try await deviceRouter.fsWrite(daemonID: task.daemonID, workspaceID: task.workspaceID,
                                                   path: suggestedName, data: data, temp: true)
        guard result.ok, result.hasPath, !result.path.isEmpty else {
            throw DeviceRouteError(result.hasError ? result.error : "文件上传失败")
        }
        return result.path
    }

    public func resizeSession(sessionID: String, cols: UInt32, rows: UInt32) {
        guard let task = tasks.first(where: { $0.hasSessionID && $0.sessionID == sessionID }) else { return }
        deviceRouter.resize(daemonID: task.daemonID, sessionID: sessionID, cols: cols, rows: rows)
    }

    /// 从相册/文件 App/剪贴板上传字节到当前活跃终端（plan 071）：经 device 数据面 fsWrite
    /// （temp=true）落 daemon 侧系统临时目录，回带绝对路径后以 bracketed paste 包裹注入 PTY
    /// （pasteKey 同语义，TerminalInputArea.swift）。同一 session 同刻只允许一次上传；
    /// 与 sendInput 同门控——按 sessionID 反查 task，查不到即视为不可用（无 RUNNING session
    /// 时输入板整体已禁用，天然满足"无 RUNNING session 不可上传"）。
    public func uploadFile(sessionID: String, data: Data, suggestedName: String) async {
        guard !uploadingSessionIDs.contains(sessionID) else { return }
        guard let task = tasks.first(where: { $0.hasSessionID && $0.sessionID == sessionID }) else {
            reportLocalError("会话不存在，无法上传文件")
            return
        }
        uploadingSessionIDs.insert(sessionID)
        defer { uploadingSessionIDs.remove(sessionID) }
        do {
            let result = try await deviceRouter.fsWrite(
                daemonID: task.daemonID, workspaceID: task.workspaceID, path: suggestedName, data: data, temp: true
            )
            if result.ok, result.hasPath, !result.path.isEmpty {
                sendInput(sessionID: sessionID, "\u{1b}[200~ \(result.path) \u{1b}[201~")
            } else {
                reportLocalError("文件上传失败：\(result.hasError ? result.error : "未知错误")")
            }
        } catch let error as DeviceRouteError {
            reportLocalError(error.message)
        } catch {
            reportLocalError(String(describing: error))
        }
    }

    /// 注册终端字节 consumer（replace=true 整屏替换，false 追加）。返回释放闭包；
    /// 注册时若有 checkpoint 且无 live 输出，先投一次只读回放（store.ts:306-307）。
    public func registerSessionConsumer(
        sessionID: String,
        _ consumer: @escaping (Data, _ replace: Bool) -> Void
    ) -> @MainActor () -> Void {
        let routedTask = tasks.first { $0.hasSessionID && $0.sessionID == sessionID }
        let token = UUID()
        sessionConsumers[sessionID] = consumer
        sessionConsumerTokens[sessionID] = token
        if let checkpoint = sessionCheckpoints[sessionID], !liveSessionIDs.contains(sessionID) {
            consumer(checkpoint.ansiSnapshot, true)
        }
        return { [weak self] in
            guard let self, self.sessionConsumerTokens[sessionID] == token else { return }
            self.sessionConsumers[sessionID] = nil
            self.sessionConsumerTokens[sessionID] = nil
            self.liveSessionIDs.remove(sessionID)
            if let routedTask {
                self.deviceRouter.suspendSession(daemonID: routedTask.daemonID, sessionID: sessionID)
            }
        }
    }

    /// 设备面板的测量持有（plan 077）：页面在场时对在线设备逐台调用，返回的闭包释放持有。
    public func retainDeviceMeasure(daemonID: String) -> @MainActor () -> Void {
        deviceRouter.retainMeasure(daemonID: daemonID)
    }

    public func reportLocalError(_ message: String) {
        clearAttachIndicators()
        errorSequence += 1
        lastError = ClientError(id: errorSequence, message: message)
    }

    /// 工作台变更只发既有业务命令，禁止从 UI 绕过认证、订阅与路由状态机。
    @discardableResult
    public func sendWorkbenchCommand(_ payload: Coflux_V1_ClientToServer.OneOf_Payload) -> Bool {
        switch payload {
        case .projectImport, .projectRemove, .projectSetName, .workspaceCreate, .workspaceRemove,
             .workspaceSetName, .deviceSetName, .clientRemoveDevice, .terminalCreate:
            break
        default:
            reportLocalError("不支持的工作台操作")
            return false
        }
        guard controlAuthenticated else {
            reportLocalError("中心未连接，无法执行此操作")
            return false
        }
        send(payload)
        return true
    }

    public func listDeviceDirectory(daemonID: String, path: String) async throws -> Coflux_V1_FsListed {
        try await deviceRouter.listDirectory(daemonID: daemonID, workspaceID: "", path: path, browseHome: true)
    }

    public func listWorkspaceDirectory(workspaceID: String, path: String) async throws -> Coflux_V1_FsListed {
        guard let workspace = workspaces.first(where: { $0.id == workspaceID }) else {
            throw DeviceRouteError("工作区不存在")
        }
        return try await deviceRouter.listDirectory(daemonID: workspace.daemonID, workspaceID: workspaceID, path: path, browseHome: false)
    }

    public func readWorkspaceFile(workspaceID: String, path: String) async throws -> Coflux_V1_FsReadResult {
        guard let workspace = workspaces.first(where: { $0.id == workspaceID }) else {
            throw DeviceRouteError("工作区不存在")
        }
        return try await deviceRouter.readFile(daemonID: workspace.daemonID, workspaceID: workspaceID, path: path)
    }

    public func executeInWorkspace(workspaceID: String, command: String, args: [String]) async throws -> Coflux_V1_ExecResult {
        guard let workspace = workspaces.first(where: { $0.id == workspaceID }) else {
            throw DeviceRouteError("工作区不存在")
        }
        return try await deviceRouter.execute(daemonID: workspace.daemonID, workspaceID: workspaceID, command: command, args: args)
    }

    private func send(_ payload: Coflux_V1_ClientToServer.OneOf_Payload) {
        guard let connection = currentConnection, let frame = try? Wire.encode(payload) else { return }
        let previous = sendTail
        let gen = generation
        let logger = logger
        let task = Task { [weak self] in
            await previous?.value
            guard let self, !Task.isCancelled, self.generation == gen else { return }
            // 与初始认证相同，async send 前武装，入站帧才能可靠解除本次等待。
            self.armWatchdog(connection: connection, generation: gen)
            do {
                try await connection.send(frame)
            } catch {
                logger.log(ClientLogEvent(level: .error, category: "control", name: "send_failed"))
                await connection.close()
            }
        }
        sendTail = task
    }

    /// package 测试的确定性同步点：只等待当前已排队控制帧完成，不暴露为产品 public API。
    func waitForPendingControlSends() async {
        await sendTail?.value
    }

    private func armWatchdog(connection: any TransportConnection, generation gen: Int) {
        // 从第一条尚未得到任何入站证明的 outbound 起算；后续发送不能把判死窗口无限后推。
        // 任意 inbound 会在 receive loop 中解除，和 Web connection.ts 的 watchdog 一致。
        guard watchdogTask == nil else { return }
        let clock = clock
        watchdogTask = Task { [weak self] in
            do {
                try await clock.sleep(seconds: 10)
            } catch {
                return
            }
            guard let self, !Task.isCancelled, self.generation == gen else { return }
            self.logger.log(ClientLogEvent(level: .notice, category: "control", name: "silent_timeout"))
            await connection.close()
        }
    }

    private func closeCurrentConnection() {
        // authError / clientOutdated 是本代际的终止消息：先废弃 generation，确保已经排队的
        // 后续帧也不能再进入 reducer；同时主动断开且不经过 reconnect 分支。
        generation += 1
        connectionTask?.cancel()
        connectionTask = nil
        watchdogTask?.cancel()
        watchdogTask = nil
        sendTail = nil
        let connection = currentConnection
        currentConnection = nil
        status = .disconnected
        Task { await connection?.close() }
    }

    private func authPayload(_ credential: AuthCredential) -> Coflux_V1_ClientAuth {
        var auth = Coflux_V1_ClientAuth()
        auth.clientVersion = configuration.buildID
        switch credential {
        case .token(let value):
            auth.clientToken = value
        case .password(let username, let password):
            auth.username = username
            auth.password = password
        }
        return auth
    }

    nonisolated private static func describeLocalError(_ error: Error) -> String {
        String(describing: error)
    }
}

private func upsert<T>(_ list: inout [T], _ item: T, match: (T) -> Bool) {
    if let index = list.firstIndex(where: match) {
        list[index] = item
    } else {
        list.append(item)
    }
}

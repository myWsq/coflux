import Foundation
import Observation

enum AuthState: Equatable {
    case needLogin
    case authenticating
    case authed
    case authFailed
    /// 版本失配防御分支（正常不触发：本端 clientVersion 上报 "dev" 总放行）；停重连不清 token。
    case outdated
}

enum ConnectionStatus: Equatable {
    case connecting
    case connected
    case disconnected
}

enum AuthCredential: Sendable, Equatable {
    case token(String)
    case password(username: String, password: String)
}

struct ClientError: Equatable {
    let id: Int
    let message: String
}

/// /client 链路的连接 + 认证 + 控制面归约。对照 packages/client 的 connection.ts（全部）
/// 与 store.ts（实体归约子集）；PTY 域（device-router/attach/checkpoint/ports）刻意留白，
/// 第二片以 store.ts 为语义基准扩展（plan 044）。
///
/// 归约语义与 TS 版严格一致：按到达顺序应用不做乱序缓冲；每条消息一次原子提交
/// （MainActor 上同步完成，订阅者只见一致状态，store.ts:320-322）。
@MainActor
@Observable
final class CofluxClient {
    private(set) var status: ConnectionStatus = .disconnected
    private(set) var authState: AuthState = .needLogin
    private(set) var loginError = ""
    private(set) var daemons: [Coflux_V1_DaemonInfo] = []
    private(set) var projects: [Coflux_V1_Project] = []
    private(set) var workspaces: [Coflux_V1_Workspace] = []
    private(set) var tasks: [Coflux_V1_Task] = []
    private(set) var lastError: ClientError?
    /// 每次 stateSnapshot 自增（store.ts:392）；第二片终端 re-attach 依赖它判定重连边界。
    private(set) var snapshotRevision = 0
    /// 被其它客户端接管的任务（plan 026 旁观语义）：UI 出横幅，仅强制接管可恢复。
    private(set) var detachedTaskIDs: Set<String> = []
    /// server 侧终端镜像（sessionCheckpoint）：无 live session 时的只读回放来源。
    private(set) var sessionCheckpoints: [String: Coflux_V1_SessionCheckpoint] = [:]
    /// 输入台账触顶的 session（等待 PTY 累计确认）：UI 提示输入受阻。
    private(set) var blockedSessionIDs: Set<String> = []
    /// 正在上传文件/图片的 session（plan 071）：UI 据此把入口键置忙态、禁重复触发。
    private(set) var uploadingSessionIDs: Set<String> = []

    /// 设备面板（plan 077）：per-daemon 传输可观测状态。relayHost = 正在经过的 relay 节点
    /// host；rttMs = 最近一次 DevicePing 往返。仅设备页在场（retainDeviceMeasure）时点亮。
    struct DeviceTransportInfo: Equatable {
        var relayHost: String?
        var rttMs: Double?
    }
    private(set) var deviceTransports: [String: DeviceTransportInfo] = [:]

    /// 构建版本上报固定 "dev"：生产版本准入唯一无条件放行通道（apps/server/src/hub.ts:1464，
    /// plan 044 决策）；原生版本准入另立 plan。
    private let buildID = "dev"
    private let transport: any Transport
    private let tokenStore: any TokenStore
    private let serverURL: URL

    private var token: String?
    /// authOk 后才允许自动重连（store.ts shouldRetry 同语义）；authError/登出/版本失配收回。
    private var shouldRetry = false
    /// 控制面已认证（store.ts controlAuthenticated 同语义）：device rendezvous 与
    /// taskRemove 的前置门。
    private var controlAuthenticated = false
    private var reconnectAttempts = 0
    /// 连接代际：每次重建/断开自增，旧循环与旧重连计时器以代际不符自行退出。
    private var generation = 0
    private var connectionTask: Task<Void, Never>?
    private var currentConnection: (any TransportConnection)?
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

    init(
        transport: any Transport = NetworkTransport(),
        tokenStore: any TokenStore = KeychainTokenStore(),
        serverURL: URL = Config.serverURL
    ) {
        self.transport = transport
        self.tokenStore = tokenStore
        self.serverURL = serverURL
        token = tokenStore.read()
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
                self?.detachedTaskIDs.remove(taskID)
            },
            onSessionDetached: { [weak self] _, taskID, _, _ in
                self?.detachedTaskIDs.insert(taskID)
            },
            onSessionExited: { [weak self] _, taskID, sessionID, exitCode in
                self?.markSessionExited(taskID: taskID, sessionID: sessionID, exitCode: exitCode)
            },
            onCatalog: { [weak self] _, catalog in
                for exit in catalog.exits {
                    self?.markSessionExited(taskID: exit.taskID, sessionID: exit.sessionID, exitCode: exit.exitCode)
                }
            },
            onError: { [weak self] message in self?.reportLocalError(message) },
            onInputBlocked: { [weak self] sessionID, blocked in
                if blocked { self?.blockedSessionIDs.insert(sessionID) } else { self?.blockedSessionIDs.remove(sessionID) }
            },
            onDeviceTransport: { [weak self] daemonID, relayHost, rttMs in
                self?.deviceTransports[daemonID] = DeviceTransportInfo(relayHost: relayHost, rttMs: rttMs)
            }
        ))
        if let token {
            // 有本地会话 token 时首屏直接 authenticating，避免闪登录页（store.ts:122-127）
            authState = .authenticating
            startConnection(credential: .token(token))
        }
    }

    // MARK: - 对外操作

    /// 登录：账号密码直发 clientAuth 帧（plan 061——server 侧 local/password 两模式同帧，
    /// 外部 IdP 两跳换票已随 plan 059 退役）。
    func login(username: String, password: String) {
        loginError = ""
        connectAuthenticating(credential: .password(username: username, password: password))
    }

    func logout() {
        shouldRetry = false
        token = nil
        tokenStore.clear()
        generation += 1
        connectionTask?.cancel()
        connectionTask = nil
        let connection = currentConnection
        currentConnection = nil
        controlAuthenticated = false
        deviceRouter.setControlOnline(false)
        deviceRouter.reset()
        Task {
            // 先投递服务端撤销再关闭（ClientLogout 使会话 token 服务端失效，非仅清本地）
            if let connection {
                if let frame = try? Wire.encode(.clientLogout(Coflux_V1_ClientLogout())) {
                    try? await connection.send(frame)
                }
                await connection.close()
            }
        }
        status = .disconnected
        authState = .needLogin
        daemons = []
        projects = []
        workspaces = []
        tasks = []
        detachedTaskIDs = []
        sessionCheckpoints = [:]
        blockedSessionIDs = []
        liveSessionIDs = []
        localExits = [:]
    }

    /// 进后台：主动断连并取消重连计时器（iOS 不保证后台 WS 存活；会话韧性在 server/daemon 侧）。
    /// 设备通道随控制面一起关（relay 存活依赖中心）；session desired 保留，回前台重挂。
    func sceneDidEnterBackground() {
        guard connectionTask != nil || currentConnection != nil else { return }
        suspendedInBackground = true
        generation += 1
        connectionTask?.cancel()
        connectionTask = nil
        let connection = currentConnection
        currentConnection = nil
        Task { await connection?.close() }
        status = .disconnected
        controlAuthenticated = false
        deviceRouter.setControlOnline(false)
    }

    /// 回前台：无条件废弃旧连接重建，不探测旧 socket 活性（系统超时可达分钟级）。
    func sceneDidBecomeActive() {
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
        let stale = currentConnection
        currentConnection = nil
        status = .connecting
        // 控制面重建期间设备通道一律视为不可用（TS onStatus !connected 同语义）
        controlAuthenticated = false
        deviceRouter.setControlOnline(false)
        connectionTask = Task {
            // 换新连接前先关旧的，否则 server 侧残留幽灵连接（connection.ts:75-77）
            await stale?.close()
            await runConnection(credential: credential, generation: gen)
        }
    }

    private func runConnection(credential: AuthCredential, generation gen: Int) async {
        do {
            let connection = try await transport.connect(to: serverURL)
            guard generation == gen, !Task.isCancelled else {
                await connection.close()
                return
            }
            currentConnection = connection
            try await connection.send(Wire.encode(.clientAuth(authPayload(credential))))
            status = .connected
            while true {
                let data = try await connection.receive()
                guard generation == gen else { return }
                if let payload = Wire.decode(data) {
                    apply(payload)
                }
            }
        } catch {
            // 统一走断线路径：具体错误对控制面无区分价值（TS onclose 同语义）
        }
        guard generation == gen, !Task.isCancelled else { return }
        currentConnection = nil
        status = .disconnected
        controlAuthenticated = false
        deviceRouter.setControlOnline(false)
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard shouldRetry, token != nil, !suspendedInBackground else { return }
        let delay = Self.reconnectDelay(attempt: reconnectAttempts)
        reconnectAttempts += 1
        let gen = generation
        connectionTask = Task {
            try? await Task.sleep(for: .seconds(delay))
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
            authState = .authed
            loginError = ""
            shouldRetry = true
            reconnectAttempts = 0
            controlAuthenticated = true
            deviceRouter.setControlOnline(true)
            if value.hasClientToken, !value.clientToken.isEmpty {
                token = value.clientToken
                tokenStore.write(value.clientToken)
            }
            send(.clientSubscribe(Coflux_V1_ClientSubscribe()))

        case .authError:
            // token 已被服务端视为无效：清 token + 停重连（继续退避=凭证风暴，store.ts:341-351）
            token = nil
            tokenStore.clear()
            shouldRetry = false
            loginError = "登录失败：账号或密码错误，或会话已过期"
            authState = .authFailed

        case .clientOutdated:
            shouldRetry = false
            authState = .outdated

        case .stateSnapshot(let value):
            daemons = value.daemons
            projects = value.projects
            workspaces = value.workspaces
            tasks = value.tasks.map(applyLocalExit)
            let taskIDs = Set(value.tasks.map(\.id))
            detachedTaskIDs = detachedTaskIDs.intersection(taskIDs)
            snapshotRevision += 1

        case .daemonUpdated(let value):
            // 显式 presence：服务端必填的内嵌 message 缺失按畸形消息丢弃（store.ts:399）
            guard value.hasDaemon else { break }
            upsert(&daemons, value.daemon) { $0.daemonID == value.daemon.daemonID }

        case .daemonRemoved(let value):
            daemons.removeAll { $0.daemonID == value.daemonID }
            projects.removeAll { $0.daemonID == value.daemonID }
            workspaces.removeAll { $0.daemonID == value.daemonID }
            tasks.removeAll { $0.daemonID == value.daemonID }

        case .projectCreated(let value):
            guard value.hasProject else { break }
            upsert(&projects, value.project) { $0.id == value.project.id }

        case .projectRemoved(let value):
            projects.removeAll { $0.id == value.projectID }
            workspaces.removeAll { $0.projectID == value.projectID }
            tasks.removeAll { $0.projectID == value.projectID }

        case .workspaceCreated(let value):
            guard value.hasWorkspace else { break }
            upsert(&workspaces, value.workspace) { $0.id == value.workspace.id }

        case .workspaceRemoved(let value):
            workspaces.removeAll { $0.id == value.workspaceID }
            tasks.removeAll { $0.workspaceID == value.workspaceID }

        case .taskUpdated(let value):
            guard value.hasTask else { break }
            let task = applyLocalExit(value.task)
            upsert(&tasks, task) { $0.id == task.id }
            if task.status != .running { detachedTaskIDs.remove(task.id) }

        case .taskRemoved(let value):
            let removed = tasks.first { $0.id == value.taskID }
            let removedSessionID = removed?.hasSessionID == true ? removed?.sessionID : nil
            tasks.removeAll { $0.id == value.taskID }
            detachedTaskIDs.remove(value.taskID)
            if let sessionID = removedSessionID {
                sessionCheckpoints[sessionID] = nil
                blockedSessionIDs.remove(sessionID)
                liveSessionIDs.remove(sessionID)
                localExits[sessionID] = nil
                if let removed { deviceRouter.forgetSession(daemonID: removed.daemonID, sessionID: sessionID) }
            }

        case .sessionCheckpoint(let checkpoint):
            // server 侧终端镜像：live 输出在场时不覆盖现场，只在无 live 时投给终端做只读回放
            sessionCheckpoints[checkpoint.sessionID] = checkpoint
            if !liveSessionIDs.contains(checkpoint.sessionID) {
                sessionConsumers[checkpoint.sessionID]?(checkpoint.ansiSnapshot, true)
            }

        case .error(let value):
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

    private func markSessionExited(taskID: String, sessionID: String, exitCode: Int32) {
        localExits[sessionID] = exitCode
        liveSessionIDs.remove(sessionID)
        blockedSessionIDs.remove(sessionID)
        detachedTaskIDs.remove(taskID)
        tasks = tasks.map { task in
            guard task.id == taskID, task.hasSessionID, task.sessionID == sessionID else { return task }
            var adjusted = task
            adjusted.status = .exited
            adjusted.clearSessionID()
            adjusted.exitCode = exitCode
            return adjusted
        }
    }

    // MARK: - 任务/终端操作（store.ts:566-609 + 279-318 对应面）

    /// 新建终端任务。taskCreate 无请求-响应关联（workspace-detail.tsx:188 同语义）：
    /// 自建任务的识别与激活由 view 侧靠快照增量的未知 task id 完成。
    func createTask(workspaceID: String, title: String) {
        guard controlAuthenticated else {
            reportLocalError("中心未连接，无法新建终端")
            return
        }
        var create = Coflux_V1_TaskCreate()
        create.workspaceID = workspaceID
        create.title = title
        send(.taskCreate(create))
    }

    /// RUNNING 的 attach 直接交给 session authority；IDLE/EXITED 由中心 prepare durable create。
    func startTask(taskID: String, cols: UInt32, rows: UInt32, force: Bool = false) {
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

    /// 停止并删除任务。iOS relay-only：中心离线时设备通道必然也不可达，不做离线记账
    /// （plan 046 决策：pendingTaskRemovals 不移植），直接报错。
    func closeTask(_ task: Coflux_V1_Task) async {
        if task.status == .running, task.hasSessionID {
            do {
                deviceRouter.attachSession(
                    daemonID: task.daemonID, taskID: task.id, sessionID: task.sessionID,
                    cols: 80, rows: 24, force: true
                )
                try await deviceRouter.stopSession(daemonID: task.daemonID, sessionID: task.sessionID)
            } catch let error as DeviceRouteError {
                // session_not_found 是「设备侧已经没有它」的确定答复，继续删 catalog task
                // 才能收敛（store.ts:583-589）；其余错误中止，不猜测设备状态。
                guard error.code == "session_not_found" else {
                    reportLocalError(error.message)
                    return
                }
            } catch {
                reportLocalError(String(describing: error))
                return
            }
        }
        removeTask(taskID: task.id)
    }

    private func removeTask(taskID: String) {
        guard controlAuthenticated else {
            reportLocalError("中心未连接，无法删除任务")
            return
        }
        var remove = Coflux_V1_TaskRemove()
        remove.taskID = taskID
        send(.taskRemove(remove))
    }

    func sendInput(sessionID: String, _ text: String) {
        guard let data = text.data(using: .utf8), !data.isEmpty else { return }
        guard let task = tasks.first(where: { $0.hasSessionID && $0.sessionID == sessionID }) else {
            reportLocalError("会话不存在，无法发送终端输入")
            return
        }
        deviceRouter.sendInput(daemonID: task.daemonID, sessionID: sessionID, data: data)
    }

    func resizeSession(sessionID: String, cols: UInt32, rows: UInt32) {
        guard let task = tasks.first(where: { $0.hasSessionID && $0.sessionID == sessionID }) else { return }
        deviceRouter.resize(daemonID: task.daemonID, sessionID: sessionID, cols: cols, rows: rows)
    }

    /// 从相册/文件 App/剪贴板上传字节到当前活跃终端（plan 071）：经 device 数据面 fsWrite
    /// （temp=true）落 daemon 侧系统临时目录，回带绝对路径后以 bracketed paste 包裹注入 PTY
    /// （pasteKey 同语义，TerminalInputArea.swift）。同一 session 同刻只允许一次上传；
    /// 与 sendInput 同门控——按 sessionID 反查 task，查不到即视为不可用（无 RUNNING session
    /// 时输入板整体已禁用，天然满足"无 RUNNING session 不可上传"）。
    func uploadFile(sessionID: String, data: Data, suggestedName: String) async {
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
    func registerSessionConsumer(
        sessionID: String,
        _ consumer: @escaping (Data, _ replace: Bool) -> Void
    ) -> () -> Void {
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
    func retainDeviceMeasure(daemonID: String) -> () -> Void {
        deviceRouter.retainMeasure(daemonID: daemonID)
    }

    func reportLocalError(_ message: String) {
        errorSequence += 1
        lastError = ClientError(id: errorSequence, message: message)
    }

    private func send(_ payload: Coflux_V1_ClientToServer.OneOf_Payload) {
        guard let connection = currentConnection, let frame = try? Wire.encode(payload) else { return }
        Task { try? await connection.send(frame) }
    }

    private func authPayload(_ credential: AuthCredential) -> Coflux_V1_ClientAuth {
        var auth = Coflux_V1_ClientAuth()
        auth.clientVersion = buildID
        switch credential {
        case .token(let value):
            auth.clientToken = value
        case .password(let username, let password):
            auth.username = username
            auth.password = password
        }
        return auth
    }
}

private func upsert<T>(_ list: inout [T], _ item: T, match: (T) -> Bool) {
    if let index = list.firstIndex(where: match) {
        list[index] = item
    } else {
        list.append(item)
    }
}

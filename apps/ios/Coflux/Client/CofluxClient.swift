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
    case supabase(String)
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

    /// 构建版本上报固定 "dev"：生产版本准入唯一无条件放行通道（apps/server/src/hub.ts:1464，
    /// plan 044 决策）；原生版本准入另立 plan。
    private let buildID = "dev"
    private let transport: any Transport
    private let tokenStore: any TokenStore
    private let serverURL: URL
    private let usesExternalLogin: Bool

    private var token: String?
    /// authOk 后才允许自动重连（store.ts shouldRetry 同语义）；authError/登出/版本失配收回。
    private var shouldRetry = false
    private var reconnectAttempts = 0
    /// 连接代际：每次重建/断开自增，旧循环与旧重连计时器以代际不符自行退出。
    private var generation = 0
    private var connectionTask: Task<Void, Never>?
    private var currentConnection: (any TransportConnection)?
    private var errorSequence = 0
    private var suspendedInBackground = false

    init(
        transport: any Transport = NetworkTransport(),
        tokenStore: any TokenStore = KeychainTokenStore(),
        serverURL: URL = Config.serverURL,
        usesExternalLogin: Bool = Config.useSupabase
    ) {
        self.transport = transport
        self.tokenStore = tokenStore
        self.serverURL = serverURL
        self.usesExternalLogin = usesExternalLogin
        token = tokenStore.read()
        if let token {
            // 有本地会话 token 时首屏直接 authenticating，避免闪登录页（store.ts:122-127）
            authState = .authenticating
            startConnection(credential: .token(token))
        }
    }

    // MARK: - 对外操作

    func login(username: String, password: String) {
        loginError = ""
        guard usesExternalLogin else {
            connectAuthenticating(credential: .password(username: username, password: password))
            return
        }
        authState = .authenticating
        Task {
            switch await SupabaseAuth.exchange(email: username, password: password) {
            case .ok(let accessToken):
                connectAuthenticating(credential: .supabase(accessToken))
            case .failed(let message):
                loginError = message
                authState = .authFailed
            }
        }
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
    }

    /// 进后台：主动断连并取消重连计时器（iOS 不保证后台 WS 存活；会话韧性在 server/daemon 侧）。
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
        switch payload {
        case .authOk(let value):
            authState = .authed
            loginError = ""
            shouldRetry = true
            reconnectAttempts = 0
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
            loginError = usesExternalLogin
                ? "登录失败：会话已过期或凭证无效，请重新登录"
                : "登录失败：用户名或密码错误"
            authState = .authFailed

        case .clientOutdated:
            shouldRetry = false
            authState = .outdated

        case .stateSnapshot(let value):
            daemons = value.daemons
            projects = value.projects
            workspaces = value.workspaces
            tasks = value.tasks
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
            upsert(&tasks, value.task) { $0.id == value.task.id }

        case .taskRemoved(let value):
            tasks.removeAll { $0.id == value.taskID }

        case .error(let value):
            errorSequence += 1
            lastError = ClientError(id: errorSequence, message: value.message)

        default:
            break // ports/checkpoint/device-relay 等 PTY 域负载：第二片
        }
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
        case .supabase(let value):
            auth.supabaseToken = value
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

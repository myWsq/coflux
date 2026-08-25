import Foundation

public enum AuthState: Equatable, Sendable {
    case needLogin
    case authenticating
    case authed
    case authFailed
    case outdated
}

public enum ConnectionStatus: Equatable, Sendable {
    case connecting
    case connected
    case disconnected
}

/// 控制面是否已经收到本轮订阅的完整快照；与网络/认证状态正交。
public enum SyncState: Equatable, Sendable {
    case notSubscribed
    case awaitingSnapshot
    case synced
}

public struct ClientError: Equatable, Sendable {
    public let id: Int
    public let message: String

    public init(id: Int, message: String) {
        self.id = id
        self.message = message
    }
}

public struct ClientConfiguration: Equatable, Sendable {
    public let serverURL: URL
    public let buildID: String

    public init(serverURL: URL, buildID: String) {
        self.serverURL = serverURL
        self.buildID = buildID
    }
}

public protocol TransportConnection: Sendable {
    /// 同一连接上的调用由实现串行化，不能让并发 Task 重排完整 binary message。
    func send(_ data: Data) async throws
    /// 下一条 binary message；同一连接同时只允许一个 waiter。
    func receive() async throws -> Data
    /// 幂等关闭。返回后旧 receive 不得吞掉后续新连接的数据。
    func close() async
}

public protocol Transport: Sendable {
    func connect(to url: URL) async throws -> any TransportConnection
}

public struct TransportClosedError: Error, Equatable, Sendable {
    public init() {}
}

public protocol TokenStore: Sendable {
    func read() throws -> String?
    func write(_ token: String) throws
    func clear() throws
}

public enum ClientLogLevel: String, Equatable, Sendable {
    case debug
    case info
    case notice
    case error
}

public struct ClientLogEvent: Equatable, Sendable {
    public let level: ClientLogLevel
    public let category: String
    public let name: String
    public let metadata: [String: String]

    public init(
        level: ClientLogLevel,
        category: String,
        name: String,
        metadata: [String: String] = [:]
    ) {
        self.level = level
        self.category = category
        self.name = name
        self.metadata = metadata
    }
}

public protocol ClientLogger: Sendable {
    /// metadata 只允许脱敏状态字段；token、密码、私钥、payload 与终端正文禁止进入日志。
    func log(_ event: ClientLogEvent)
}

public struct NoopClientLogger: ClientLogger {
    public init() {}
    public func log(_: ClientLogEvent) {}
}

public protocol ClientClock: Sendable {
    func sleep(seconds: Double) async throws
}

public struct SystemClientClock: ClientClock {
    public init() {}

    public func sleep(seconds: Double) async throws {
        try await Task.sleep(for: .seconds(seconds))
    }
}

public protocol RetryJitterSource: Sendable {
    func delay(ceiling: Double) -> Double
}

public struct SystemRetryJitterSource: RetryJitterSource {
    public init() {}

    public func delay(ceiling: Double) -> Double {
        guard ceiling > 0 else { return 0 }
        return ceiling / 2 + Double.random(in: 0 ... ceiling / 2)
    }
}

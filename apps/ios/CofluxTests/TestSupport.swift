import Foundation
@testable import Coflux

/// 测试用连接：AsyncStream 充当下行队列，push 前后于 receive 均可（无界缓冲）。
final class FakeConnection: TransportConnection, @unchecked Sendable {
    private let continuation: AsyncStream<Data>.Continuation
    private var iterator: AsyncStream<Data>.AsyncIterator
    private let lock = NSLock()
    private var recorded: [Data] = []

    var sent: [Data] {
        lock.withLock { recorded }
    }

    init() {
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        self.continuation = continuation
        iterator = stream.makeAsyncIterator()
    }

    func send(_ data: Data) async throws {
        lock.withLock { recorded.append(data) }
    }

    func receive() async throws -> Data {
        if let data = await iterator.next() { return data }
        throw TransportClosedError()
    }

    func close() async {
        continuation.finish()
    }

    func push(_ payload: Coflux_V1_ServerToClient.OneOf_Payload) {
        var envelope = Coflux_V1_ServerToClient()
        envelope.payload = payload
        let data: Data = try! envelope.serializedBytes()
        continuation.yield(data)
    }

    func finish() {
        continuation.finish()
    }
}

actor FakeTransport: Transport {
    private(set) var connectCount = 0
    private var pending: [FakeConnection] = []
    private var waiters: [CheckedContinuation<FakeConnection, Never>] = []

    func connect(to url: URL) async throws -> any TransportConnection {
        connectCount += 1
        let connection = FakeConnection()
        if !waiters.isEmpty {
            waiters.removeFirst().resume(returning: connection)
        } else {
            pending.append(connection)
        }
        return connection
    }

    /// 等待客户端建立下一条连接（含已建立未取走的）。
    func nextConnection() async -> FakeConnection {
        if !pending.isEmpty { return pending.removeFirst() }
        return await withCheckedContinuation { waiters.append($0) }
    }
}

final class InMemoryTokenStore: TokenStore {
    var value: String?

    init(value: String? = nil) {
        self.value = value
    }

    func read() -> String? { value }
    func write(_ token: String) { value = token }
    func clear() { value = nil }
}

/// 轮询等待异步状态收敛（认证/重连流转经多个 await 点，无同步完成保证）。
@MainActor
func waitUntil(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while clock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(2))
    }
    return condition()
}

func decodeClientFrame(_ data: Data) -> Coflux_V1_ClientToServer.OneOf_Payload? {
    (try? Coflux_V1_ClientToServer(serializedBytes: data))?.payload
}

import CofluxProtocol
import Foundation
@testable import CofluxClientCore

/// 测试用连接：AsyncStream 充当下行队列，push 前后于 receive 均可（无界缓冲）。
final class FakeConnection: TransportConnection, @unchecked Sendable {
    private let continuation: AsyncStream<Data>.Continuation
    private var iterator: AsyncStream<Data>.AsyncIterator
    private let lock = NSLock()
    private var recorded: [Data] = []
    private var didClose = false

    var sent: [Data] {
        lock.withLock { recorded }
    }

    var closed: Bool {
        lock.withLock { didClose }
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
        lock.withLock { didClose = true }
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

    /// device 测试用：直接投递已编码帧（DeviceEnvelope 等非控制面信封）。
    func pushRaw(_ data: Data) {
        continuation.yield(data)
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

/// 仅由 @MainActor CofluxClient 与对应测试线程访问。
final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    var value: String?

    init(value: String? = nil) {
        self.value = value
    }

    func read() throws -> String? { value }
    func write(_ token: String) throws { value = token }
    func clear() throws { value = nil }
}

struct ImmediateClock: ClientClock {
    func sleep(seconds _: Double) async throws {}
}

struct FixedJitter: RetryJitterSource {
    let value: Double
    func delay(ceiling _: Double) -> Double { value }
}

final class ManualClock: ClientClock, @unchecked Sendable {
    private struct Waiter {
        let continuation: CheckedContinuation<Void, any Error>
    }

    private let lock = NSLock()
    private var waiters: [UUID: Waiter] = [:]
    private var starts = 0

    var waiterCount: Int { lock.withLock { waiters.count } }
    var sleepStartCount: Int { lock.withLock { starts } }

    func sleep(seconds _: Double) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let cancelled = lock.withLock { () -> Bool in
                    starts += 1
                    guard !Task.isCancelled else { return true }
                    waiters[id] = Waiter(continuation: continuation)
                    return false
                }
                if cancelled { continuation.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let waiter = lock.withLock { waiters.removeValue(forKey: id) }
            waiter?.continuation.resume(throwing: CancellationError())
        }
    }

    func wakeAll() {
        let pending = lock.withLock {
            let copy = Array(waiters.values)
            waiters.removeAll()
            return copy
        }
        for waiter in pending { waiter.continuation.resume() }
    }
}

/// 可选择挂起某几次 send；close 会失败所有挂起 send，确保测试任务不泄漏。
final class ControlledSendConnection: TransportConnection, @unchecked Sendable {
    private let continuation: AsyncStream<Data>.Continuation
    private var iterator: AsyncStream<Data>.AsyncIterator
    private let lock = NSLock()
    private let blockedIndices: Set<Int>
    private var frames: [Data] = []
    private var blocked: [Int: CheckedContinuation<Void, any Error>] = [:]
    private var didClose = false

    init(blockedIndices: Set<Int>) {
        self.blockedIndices = blockedIndices
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        self.continuation = continuation
        iterator = stream.makeAsyncIterator()
    }

    var sent: [Data] { lock.withLock { frames } }
    var blockedSendCount: Int { lock.withLock { blocked.count } }
    var closed: Bool { lock.withLock { didClose } }

    func send(_ data: Data) async throws {
        let index = lock.withLock { () -> Int in
            let index = frames.count
            frames.append(data)
            return index
        }
        guard blockedIndices.contains(index) else { return }
        try await withCheckedThrowingContinuation { continuation in
            let closed = lock.withLock { () -> Bool in
                guard !didClose else { return true }
                blocked[index] = continuation
                return false
            }
            if closed { continuation.resume(throwing: TransportClosedError()) }
        }
    }

    func receive() async throws -> Data {
        if let data = await iterator.next() { return data }
        throw TransportClosedError()
    }

    func close() async {
        let pending = lock.withLock { () -> [CheckedContinuation<Void, any Error>] in
            guard !didClose else { return [] }
            didClose = true
            let pending = Array(blocked.values)
            blocked.removeAll()
            return pending
        }
        continuation.finish()
        for continuation in pending { continuation.resume(throwing: TransportClosedError()) }
    }

    func releaseSend(_ index: Int) {
        let continuation = lock.withLock { blocked.removeValue(forKey: index) }
        continuation?.resume()
    }

    func push(_ payload: Coflux_V1_ServerToClient.OneOf_Payload) {
        var envelope = Coflux_V1_ServerToClient()
        envelope.payload = payload
        continuation.yield(try! envelope.serializedBytes())
    }
}

enum TestTokenStoreError: Error, Equatable {
    case read
    case write
    case clear
}

final class FailingTokenStore: TokenStore, @unchecked Sendable {
    let failure: TestTokenStoreError

    init(_ failure: TestTokenStoreError) {
        self.failure = failure
    }

    func read() throws -> String? {
        if failure == .read { throw failure }
        return nil
    }

    func write(_: String) throws {
        if failure == .write { throw failure }
    }

    func clear() throws {
        if failure == .clear { throw failure }
    }
}

final class SendConcurrencyProbeConnection: TransportConnection, @unchecked Sendable {
    private let continuation: AsyncStream<Data>.Continuation
    private var iterator: AsyncStream<Data>.AsyncIterator
    private let lock = NSLock()
    private var frames: [Data] = []
    private var activeSends = 0
    private var maximum = 0

    var maximumConcurrentSends: Int { lock.withLock { maximum } }

    init() {
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        self.continuation = continuation
        iterator = stream.makeAsyncIterator()
    }

    func send(_ data: Data) async throws {
        lock.withLock {
            activeSends += 1
            maximum = max(maximum, activeSends)
        }
        try await Task.sleep(for: .milliseconds(20))
        lock.withLock {
            frames.append(data)
            activeSends -= 1
        }
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

    var sentFrames: [Data] { lock.withLock { frames } }
}

actor SingleConnectionTransport: Transport {
    let connection: SendConcurrencyProbeConnection

    init(connection: SendConcurrencyProbeConnection) {
        self.connection = connection
    }

    func connect(to _: URL) async throws -> any TransportConnection { connection }
}

/// 依次返回预置连接，供 control connection generation 测试精确制造新旧链路交叠。
actor SequenceTransport: Transport {
    private var connections: [any TransportConnection]

    init(_ connections: [any TransportConnection]) {
        self.connections = connections
    }

    func connect(to _: URL) async throws -> any TransportConnection {
        guard !connections.isEmpty else { throw TransportClosedError() }
        return connections.removeFirst()
    }
}

/// close/cancellation 不会自动唤醒 receive；测试显式 push 后旧 generation 才继续执行。
/// 这模拟底层网络回调已经排队、在新连接建立后才交付的最坏竞态。
final class StickyReceiveConnection: TransportConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [Data] = []
    private var pending: [Data] = []
    private var waiter: CheckedContinuation<Data, any Error>?

    var sent: [Data] { lock.withLock { recorded } }

    func send(_ data: Data) async throws {
        lock.withLock { recorded.append(data) }
    }

    func receive() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let immediate = lock.withLock { () -> Data? in
                if !pending.isEmpty { return pending.removeFirst() }
                waiter = continuation
                return nil
            }
            if let immediate { continuation.resume(returning: immediate) }
        }
    }

    func close() async {}

    func push(_ payload: Coflux_V1_ServerToClient.OneOf_Payload) {
        var envelope = Coflux_V1_ServerToClient()
        envelope.payload = payload
        let data: Data = try! envelope.serializedBytes()
        let receiver = lock.withLock { () -> CheckedContinuation<Data, any Error>? in
            if let waiter {
                self.waiter = nil
                return waiter
            }
            pending.append(data)
            return nil
        }
        receiver?.resume(returning: data)
    }
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

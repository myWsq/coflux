import CofluxClientCore
import Foundation
@testable import CofluxApplePlatform
import XCTest

private final class FakeURLSessionWebSocketDriver: URLSessionWebSocketDriving, @unchecked Sendable {
    private let lock = NSLock()
    private let blockedSendIndices: Set<Int>
    private let resumeOperationsOnCancel: Bool
    private var receiveResults: [Result<PlatformWebSocketMessage, any Error>] = []
    private var receiveContinuation: CheckedContinuation<PlatformWebSocketMessage, any Error>?
    private var sendContinuations: [Int: CheckedContinuation<Void, any Error>] = [:]
    private var sendStarts: [PlatformWebSocketMessage] = []
    private var activeSends = 0
    private var maxActiveSends = 0
    private var resumed = 0
    private var cancelled = false
    private var cancels = 0

    init(blockedSendIndices: Set<Int> = [], resumeOperationsOnCancel: Bool = true) {
        self.blockedSendIndices = blockedSendIndices
        self.resumeOperationsOnCancel = resumeOperationsOnCancel
    }

    var sentMessages: [PlatformWebSocketMessage] { lock.withLock { sendStarts } }
    var maximumConcurrentSends: Int { lock.withLock { maxActiveSends } }
    var resumeCount: Int { lock.withLock { resumed } }
    var cancelCount: Int { lock.withLock { cancels } }
    var hasReceiveWaiter: Bool { lock.withLock { receiveContinuation != nil } }

    func resume() {
        lock.withLock { resumed += 1 }
    }

    func send(_ message: PlatformWebSocketMessage) async throws {
        let index: Int = try lock.withLock {
            guard !cancelled else { throw TransportClosedError() }
            let index = sendStarts.count
            sendStarts.append(message)
            activeSends += 1
            maxActiveSends = max(maxActiveSends, activeSends)
            return index
        }
        defer { lock.withLock { activeSends -= 1 } }
        guard blockedSendIndices.contains(index) else { return }
        try await withCheckedThrowingContinuation { continuation in
            let alreadyCancelled = lock.withLock { () -> Bool in
                guard !cancelled else { return true }
                sendContinuations[index] = continuation
                return false
            }
            if alreadyCancelled { continuation.resume(throwing: TransportClosedError()) }
        }
    }

    func receive() async throws -> PlatformWebSocketMessage {
        try await withCheckedThrowingContinuation { continuation in
            let immediate = lock.withLock { () -> Result<PlatformWebSocketMessage, any Error>? in
                if cancelled { return .failure(TransportClosedError()) }
                if !receiveResults.isEmpty { return receiveResults.removeFirst() }
                receiveContinuation = continuation
                return nil
            }
            if let immediate { continuation.resume(with: immediate) }
        }
    }

    func cancel() {
        let pending = lock.withLock { () -> (
            CheckedContinuation<PlatformWebSocketMessage, any Error>?,
            [CheckedContinuation<Void, any Error>]
        ) in
            guard !cancelled else { return (nil, []) }
            cancelled = true
            cancels += 1
            guard resumeOperationsOnCancel else { return (nil, []) }
            let receive = receiveContinuation
            receiveContinuation = nil
            let sends = Array(sendContinuations.values)
            sendContinuations.removeAll()
            return (receive, sends)
        }
        pending.0?.resume(throwing: TransportClosedError())
        for continuation in pending.1 { continuation.resume(throwing: TransportClosedError()) }
    }

    func enqueue(_ result: Result<PlatformWebSocketMessage, any Error>) {
        let waiter = lock.withLock { () -> CheckedContinuation<PlatformWebSocketMessage, any Error>? in
            guard let receiveContinuation else {
                receiveResults.append(result)
                return nil
            }
            self.receiveContinuation = nil
            return receiveContinuation
        }
        waiter?.resume(with: result)
    }

    func releaseSend(_ index: Int) {
        let continuation = lock.withLock { sendContinuations.removeValue(forKey: index) }
        continuation?.resume()
    }

    func failSend(_ index: Int, error: any Error) {
        let continuation = lock.withLock { sendContinuations.removeValue(forKey: index) }
        continuation?.resume(throwing: error)
    }

    func finishCancelledOperations() {
        let pending = lock.withLock { () -> (
            CheckedContinuation<PlatformWebSocketMessage, any Error>?,
            [CheckedContinuation<Void, any Error>]
        ) in
            let receive = receiveContinuation
            receiveContinuation = nil
            let sends = Array(sendContinuations.values)
            sendContinuations.removeAll()
            return (receive, sends)
        }
        pending.0?.resume(throwing: TransportClosedError())
        for continuation in pending.1 { continuation.resume(throwing: TransportClosedError()) }
    }
}

private final class RecordingWebSocketTaskFactory: URLSessionWebSocketTaskFactory, @unchecked Sendable {
    private let lock = NSLock()
    let driver: FakeURLSessionWebSocketDriver
    private var requests: [URLRequest] = []

    init(driver: FakeURLSessionWebSocketDriver) {
        self.driver = driver
    }

    var capturedRequests: [URLRequest] { lock.withLock { requests } }

    func makeTask(for request: URLRequest) -> any URLSessionWebSocketDriving {
        lock.withLock { requests.append(request) }
        return driver
    }
}

final class URLSessionWebSocketTransportTests: XCTestCase {
    func testConnectBuildsExplicitOriginRequestAndResumesOnce() async throws {
        let driver = FakeURLSessionWebSocketDriver()
        let factory = RecordingWebSocketTaskFactory(driver: driver)
        let transport = URLSessionWebSocketTransport(
            origin: "https://app.coflux.dev",
            factory: factory
        )

        let connection = try await transport.connect(to: URL(string: "wss://api.coflux.dev/client")!)
        let request = try XCTUnwrap(factory.capturedRequests.first)
        XCTAssertEqual(request.url?.absoluteString, "wss://api.coflux.dev/client")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://app.coflux.dev")
        XCTAssertEqual(request.timeoutInterval, 30)
        XCTAssertEqual(driver.resumeCount, 1)
        await connection.close()
    }

    func testInvalidWebSocketURLAndNonCanonicalOriginAreRejectedBeforeTaskCreation() async {
        let driver = FakeURLSessionWebSocketDriver()
        let factory = RecordingWebSocketTaskFactory(driver: driver)
        let invalidURLTransport = URLSessionWebSocketTransport(
            origin: "https://app.coflux.dev",
            factory: factory
        )
        do {
            _ = try await invalidURLTransport.connect(to: URL(string: "https://api.coflux.dev/client")!)
            XCTFail("非 WebSocket URL 必须被拒绝")
        } catch {
            XCTAssertEqual(error as? URLSessionWebSocketTransportError, .invalidWebSocketURL)
        }

        let invalidOriginTransport = URLSessionWebSocketTransport(
            origin: "https://app.coflux.dev/",
            factory: factory
        )
        do {
            _ = try await invalidOriginTransport.connect(to: URL(string: "wss://api.coflux.dev/client")!)
            XCTFail("非 canonical Origin 必须被拒绝")
        } catch {
            XCTAssertEqual(error as? URLSessionWebSocketTransportError, .invalidOrigin)
        }
        XCTAssertTrue(factory.capturedRequests.isEmpty)
    }

    func testReceiveAcceptsBinaryAndRejectsConcurrentWaiter() async throws {
        let driver = FakeURLSessionWebSocketDriver()
        let connection = try await makeConnection(driver: driver)
        let first = Task { try await connection.receive() }
        guard await waitUntil({ driver.hasReceiveWaiter }) else {
            await connection.close()
            return XCTFail("首个 receive waiter 未及时进入驱动层")
        }

        do {
            _ = try await connection.receive()
            XCTFail("同一连接不能同时存在两个 receive waiter")
        } catch {
            XCTAssertEqual(error as? URLSessionWebSocketTransportError, .concurrentReceive)
        }

        let expected = Data([0x01, 0x02, 0x03])
        driver.enqueue(.success(.data(expected)))
        let received = try await first.value
        XCTAssertEqual(received, expected)
        await connection.close()
    }

    func testTextFrameTerminatesConnection() async throws {
        let driver = FakeURLSessionWebSocketDriver()
        let connection = try await makeConnection(driver: driver)
        driver.enqueue(.success(.string("not protobuf")))

        do {
            _ = try await connection.receive()
            XCTFail("控制面只能接收 binary frame")
        } catch {
            XCTAssertEqual(error as? URLSessionWebSocketTransportError, .textFrame)
        }
        XCTAssertEqual(driver.cancelCount, 1)
        do {
            _ = try await connection.receive()
            XCTFail("被终止连接不能继续 receive")
        } catch {
            XCTAssertTrue(error is TransportClosedError)
        }
    }

    func testConcurrentSendsAreSerializedInCallOrder() async throws {
        let driver = FakeURLSessionWebSocketDriver(blockedSendIndices: [0])
        let connection = try await makeConnection(driver: driver)
        let firstData = Data([0xA1])
        let secondData = Data([0xB2])

        let first = Task { try await connection.send(firstData) }
        guard await waitUntil({ driver.sentMessages.count == 1 }) else {
            await connection.close()
            return XCTFail("首个 send 未及时进入驱动层")
        }
        let second = Task { try await connection.send(secondData) }
        for _ in 0 ..< 20 { await Task.yield() }
        XCTAssertEqual(driver.sentMessages, [.data(firstData)])

        driver.releaseSend(0)
        try await first.value
        try await second.value
        XCTAssertEqual(driver.sentMessages, [.data(firstData), .data(secondData)])
        XCTAssertEqual(driver.maximumConcurrentSends, 1)
        await connection.close()
    }

    func testCloseIsIdempotentAndRejectsLaterOperations() async throws {
        let driver = FakeURLSessionWebSocketDriver()
        let connection = try await makeConnection(driver: driver)
        await connection.close()
        await connection.close()
        XCTAssertEqual(driver.cancelCount, 1)

        do {
            try await connection.send(Data([1]))
            XCTFail("close 后不能 send")
        } catch {
            XCTAssertTrue(error is TransportClosedError)
        }
        do {
            _ = try await connection.receive()
            XCTFail("close 后不能 receive")
        } catch {
            XCTAssertTrue(error is TransportClosedError)
        }
    }

    func testCloseReleasesActiveReceiveAndAllSends() async throws {
        let driver = FakeURLSessionWebSocketDriver(
            blockedSendIndices: [0],
            resumeOperationsOnCancel: false
        )
        let connection = try await makeConnection(driver: driver)
        let firstSend = Task { try await connection.send(Data([0x01])) }
        guard await waitUntil({ driver.sentMessages.count == 1 }) else {
            await connection.close()
            return XCTFail("阻塞 send 未及时进入驱动层")
        }
        let secondSend = Task { try await connection.send(Data([0x02])) }
        let receive = Task { try await connection.receive() }
        guard await waitUntil({ driver.hasReceiveWaiter }) else {
            await connection.close()
            return XCTFail("阻塞 receive 未及时进入驱动层")
        }

        await connection.close()
        for task in [firstSend, secondSend] {
            do {
                try await task.value
                XCTFail("close 必须失败所有 active/queued send")
            } catch {
                XCTAssertTrue(error is TransportClosedError)
            }
        }
        do {
            _ = try await receive.value
            XCTFail("close 必须失败 active receive")
        } catch {
            XCTAssertTrue(error is TransportClosedError)
        }
        XCTAssertEqual(driver.sentMessages, [.data(Data([0x01]))])
        XCTAssertEqual(driver.cancelCount, 1)
        // API waiter 已先由 adapter 收敛；现在才释放故意不配合 cancel 的底层 fake operation。
        driver.finishCancelledOperations()
        for _ in 0 ..< 20 { await Task.yield() }
    }

    func testSendFailureTerminatesQueueWithoutLettingLaterFramesOvertake() async throws {
        enum ExpectedFailure: Error { case failed }
        let driver = FakeURLSessionWebSocketDriver(blockedSendIndices: [0])
        let connection = try await makeConnection(driver: driver)
        let first = Task { try await connection.send(Data([0x01])) }
        guard await waitUntil({ driver.sentMessages.count == 1 }) else {
            await connection.close()
            return XCTFail("首个 send 未及时进入驱动层")
        }
        let second = Task { try await connection.send(Data([0x02])) }
        let third = Task { try await connection.send(Data([0x03])) }
        for _ in 0 ..< 20 { await Task.yield() }

        driver.failSend(0, error: ExpectedFailure.failed)
        do {
            try await first.value
            XCTFail("首帧底层失败必须传回调用方")
        } catch {
            XCTAssertTrue(error is ExpectedFailure)
        }
        for task in [second, third] {
            do {
                try await task.value
                XCTFail("首帧失败后队列必须整体失败")
            } catch {
                XCTAssertTrue(error is TransportClosedError)
            }
        }
        XCTAssertEqual(driver.sentMessages, [.data(Data([0x01]))])
        XCTAssertEqual(driver.cancelCount, 1)
    }

    private func makeConnection(driver: FakeURLSessionWebSocketDriver) async throws -> any TransportConnection {
        let factory = RecordingWebSocketTaskFactory(driver: driver)
        return try await URLSessionWebSocketTransport(
            origin: "https://app.coflux.dev",
            factory: factory
        ).connect(to: URL(string: "wss://api.coflux.dev/client")!)
    }

    private func waitUntil(_ predicate: @escaping () -> Bool) async -> Bool {
        for _ in 0 ..< 1_000 {
            if predicate() { return true }
            await Task.yield()
        }
        return false
    }
}

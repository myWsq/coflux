import CofluxClientCore
import XCTest
@preconcurrency import WebRTC
@testable import Coflux

@MainActor
final class NativeRTCConnectionTests: XCTestCase {
    private func connected() async throws -> (NativeRTCPeer, NativeRTCPeer, NativeRTCConnection, NativeRTCConnection, RTCDataChannel) {
        let a = try NativeRTCPeer(iceServers: [])
        let b = try NativeRTCPeer(iceServers: [])
        do {
            let channel = try a.createDataChannel(label: "p2p-transport-test")
            let outgoing = NativeRTCConnection(channel: channel)
            var incoming: NativeRTCConnection?
            b.onDataChannel = { incoming = NativeRTCConnection(channel: $0) }
            let offer = try await a.makeOffer()
            let answer = try await b.answer(offer: offer)
            try await a.accept(answer: answer)
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while incoming == nil || channel.readyState != .open {
                guard ContinuousClock.now < deadline else { throw NativeRTCError.gatheringTimedOut }
                try await Task.sleep(for: .milliseconds(20))
            }
            return (a, b, outgoing, try XCTUnwrap(incoming), channel)
        } catch { a.close(); b.close(); throw error }
    }

    private func receiveWithTimeout(_ connection: NativeRTCConnection) async throws -> Data {
        try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask { try await connection.receive() }
            group.addTask {
                try await Task.sleep(for: .seconds(15))
                await connection.close()
                throw NativeRTCError.gatheringTimedOut
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    func testMaximumFrameUsesBackpressureAndPreservesFollowingFrame() async throws {
        let (a, b, outgoing, incoming, _) = try await connected()
        defer { a.close(); b.close() }
        let frame = Data(repeating: 0xab, count: 30 * 1024 * 1024)
        let receive = Task { try await self.receiveWithTimeout(incoming) }
        try await outgoing.send(frame)
        let actual = try await receive.value
        XCTAssertEqual(actual, frame)
        let tail = Data("后续帧😀".utf8)
        try await outgoing.send(tail)
        let actualTail = try await receiveWithTimeout(incoming)
        XCTAssertEqual(actualTail, tail)
        try await incoming.send(Data("reply".utf8))
        let reply = try await receiveWithTimeout(outgoing)
        XCTAssertEqual(reply, Data("reply".utf8))
        await outgoing.close()
        await incoming.close()
    }

    func testMalformedWireClosesWaitingReceiver() async throws {
        let (a, b, outgoing, incoming, channel) = try await connected()
        defer { a.close(); b.close() }
        XCTAssertTrue(channel.sendData(RTCDataBuffer(data: Data([0, 0, 0, 0]), isBinary: true)))
        do {
            _ = try await receiveWithTimeout(incoming)
            XCTFail("非法长度必须关闭数据流")
        } catch is P2PFramingError {} catch is TransportClosedError {} catch { XCTFail("意外错误：\(error)") }
        await outgoing.close()
        await incoming.close()
    }

    func testCancelPendingSendClosesChannelAndReceive() async throws {
        let peer = try NativeRTCPeer(iceServers: [])
        defer { peer.close() }
        let channel = try peer.createDataChannel(label: "pending")
        let connection = NativeRTCConnection(channel: channel)
        // 未开始协商，send 必须等待；取消不能留下轮询或 continuation。
        let sending = Task { try await connection.send(Data([1, 2, 3])) }
        let receiving = Task { try await connection.receive() }
        try await Task.sleep(for: .milliseconds(30))
        sending.cancel()
        do { try await sending.value; XCTFail("取消 send 不应成功") } catch {}
        do { _ = try await receiving.value; XCTFail("同通道 receive 应退出") } catch {}
        XCTAssertTrue(channel.readyState == .closing || channel.readyState == .closed)
        await connection.close()
        await connection.close()
    }

    func testConcurrentSendsRemainWholeFrames() async throws {
        let (a, b, outgoing, incoming, _) = try await connected()
        defer { a.close(); b.close() }
        let payloads = (0..<8).map { Data(repeating: UInt8($0), count: 200 * 1024 + $0) }
        let received = Task {
            var frames: [Data] = []
            for _ in payloads { frames.append(try await self.receiveWithTimeout(incoming)) }
            return frames
        }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for payload in payloads { group.addTask { try await outgoing.send(payload) } }
            try await group.waitForAll()
        }
        let frames = try await received.value
        // 并发调用的先后由队列决定，但不同帧的分片绝不能交叉。
        XCTAssertEqual(frames.sorted { $0.count < $1.count }, payloads)
        await outgoing.close()
        await incoming.close()
    }

    func testUnreadFrameFloodClosesInsteadOfGrowingQueue() async throws {
        let (a, b, outgoing, incoming, channel) = try await connected()
        defer { a.close(); b.close() }
        var wire = Data()
        for _ in 0..<4097 { wire.append(contentsOf: [0, 0, 0, 1, 42]) }
        for start in stride(from: 0, to: wire.count, by: 16_384) {
            let chunk = wire[start..<min(start + 16_384, wire.count)]
            XCTAssertTrue(channel.sendData(RTCDataBuffer(data: chunk, isBinary: true)))
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while channel.readyState != .closed {
            guard ContinuousClock.now < deadline else { throw NativeRTCError.gatheringTimedOut }
            try await Task.sleep(for: .milliseconds(20))
        }
        do { _ = try await incoming.receive(); XCTFail("超限接收队列必须关闭") } catch {}
        await outgoing.close()
        await incoming.close()
    }
}

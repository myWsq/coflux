import Foundation
import XCTest

final class NativeWebRTCFramingTests: XCTestCase {
    private final class BlockingChunkChannel: NativeP2PChunkChannel, @unchecked Sendable {
        private let lock = NSLock()
        private let mayFinishFirstSend = DispatchSemaphore(value: 0)
        let firstSendStarted = DispatchSemaphore(value: 0)
        private var closed = false

        var isOpen: Bool { lock.withLock { !closed } }
        var bufferedAmount: UInt64 { 0 }

        func sendChunk(_ chunk: Data) -> Bool {
            firstSendStarted.signal()
            mayFinishFirstSend.wait()
            return isOpen
        }

        func allowFirstSendToFinish() {
            mayFinishFirstSend.signal()
        }

        func close() {
            lock.withLock { closed = true }
            mayFinishFirstSend.signal()
        }
    }

    private final class RecordingChunkChannel: NativeP2PChunkChannel, @unchecked Sendable {
        private let lock = NSLock()
        private var chunks: [Data] = []
        private var closed = false
        private var sendAttempts = 0
        private let rejectedAttempt: Int?
        private let sendDelay: TimeInterval

        init(rejectedAttempt: Int? = nil, sendDelay: TimeInterval = 0) {
            self.rejectedAttempt = rejectedAttempt
            self.sendDelay = sendDelay
        }

        var isOpen: Bool {
            lock.withLock { !closed }
        }

        var bufferedAmount: UInt64 { 0 }

        func sendChunk(_ chunk: Data) -> Bool {
            if sendDelay > 0 { Thread.sleep(forTimeInterval: sendDelay) }
            return lock.withLock {
                sendAttempts += 1
                if sendAttempts == rejectedAttempt { return false }
                chunks.append(chunk)
                return true
            }
        }

        func close() {
            lock.withLock { closed = true }
        }

        func snapshot() -> (chunks: [Data], closed: Bool, attempts: Int) {
            lock.withLock { (chunks, closed, sendAttempts) }
        }
    }

    func testChunksAndAssemblerCoverWireBoundaries() throws {
        let sizes = [
            1,
            NativeP2PFraming.chunkBytes - 4,
            NativeP2PFraming.chunkBytes,
            NativeP2PFraming.chunkBytes * 3 + 97,
        ]

        for size in sizes {
            let frame = patternedData(count: size)
            let chunks = try NativeP2PFraming.chunks(for: frame)
            XCTAssertTrue(chunks.allSatisfy { $0.count <= NativeP2PFraming.chunkBytes })
            if size == NativeP2PFraming.chunkBytes - 4 {
                XCTAssertEqual(chunks.count, 1, "4-byte header + payload 应恰好填满一个 chunk")
            }
            if size == NativeP2PFraming.chunkBytes {
                XCTAssertEqual(chunks.count, 2, "payload 达 16 KiB 时长度头必须进入第二个 chunk")
            }

            var assembler = NativeP2PFrameAssembler()
            let restored = try chunks.flatMap { try assembler.push($0) }
            XCTAssertEqual(restored, [frame], "size=\(size)")
        }
    }

    func testHeaderSplitAndMultipleFramesInOneMessage() throws {
        let first = Data([7, 8, 9])
        let second = Data([10, 11])
        let firstWire = try XCTUnwrap(try NativeP2PFraming.chunks(for: first).first)
        let secondWire = try XCTUnwrap(try NativeP2PFraming.chunks(for: second).first)
        var assembler = NativeP2PFrameAssembler()

        XCTAssertTrue(try assembler.push(firstWire.prefix(2)).isEmpty)
        var joined = Data(firstWire.dropFirst(2))
        joined.append(secondWire)
        XCTAssertEqual(try assembler.push(joined), [first, second])
    }

    func testNearMaximumFrameAndInvalidLengths() throws {
        let nearMaximum = patternedData(count: NativeP2PFraming.maxFrameBytes - 1024)
        let chunks = try NativeP2PFraming.chunks(for: nearMaximum)
        XCTAssertGreaterThan(chunks.count, 1_000)
        var assembler = NativeP2PFrameAssembler()
        let restored = try chunks.flatMap { try assembler.push($0) }
        XCTAssertEqual(restored, [nearMaximum])

        XCTAssertThrowsError(try NativeP2PFraming.chunks(for: Data()))
        XCTAssertThrowsError(
            try NativeP2PFraming.chunks(for: Data(count: NativeP2PFraming.maxFrameBytes + 1))
        )

        var zeroAssembler = NativeP2PFrameAssembler()
        XCTAssertThrowsError(try zeroAssembler.push(Data([0, 0, 0, 0])))
        var oversizedAssembler = NativeP2PFrameAssembler()
        let tooLarge = UInt32(NativeP2PFraming.maxFrameBytes + 1)
        XCTAssertThrowsError(try oversizedAssembler.push(bigEndianBytes(tooLarge)))
        var oversizedChunkAssembler = NativeP2PFrameAssembler()
        XCTAssertThrowsError(
            try oversizedChunkAssembler.push(Data(count: NativeP2PFraming.chunkBytes + 1))
        )
    }

    func testSilentTimeoutAndExplicitCloseAreDistinctSignals() {
        var liveness = NativeP2PLiveness(now: 10, timeout: 5)
        XCTAssertEqual(liveness.state(at: 14.999), .alive)
        XCTAssertEqual(liveness.state(at: 15), .silentTimeout)
        liveness.recordActivity(at: 16)
        XCTAssertEqual(liveness.state(at: 20), .alive)
        liveness.recordClose()
        XCTAssertEqual(liveness.state(at: 20), .closed)
    }

    func testRelaySurvivesP2PFailureAndLateP2POpensPromote() {
        var state = NativeP2PPromotionState()
        state.relayOpened(generation: 1)
        XCTAssertEqual(state.active, .relay)

        state.beginP2PAttempt(generation: 2)
        state.p2pFailed(generation: 2)
        XCTAssertEqual(state.active, .relay)
        XCTAssertTrue(state.relayAvailable)

        state.beginP2PAttempt(generation: 3)
        XCTAssertEqual(state.active, .relay, "ICE connected 之前不得提前 promotion")
        state.p2pDataChannelOpened(generation: 3)
        XCTAssertEqual(state.active, .p2p)

        state.p2pFailed(generation: 3)
        XCTAssertEqual(state.active, .relay, "P2P 发送失败/静默判死后应回到仍可用的 relay")
    }

    func testEqualOrOlderP2PGenerationCannotReplaceRelay() {
        var state = NativeP2PPromotionState()
        state.relayOpened(generation: 7)

        state.beginP2PAttempt(generation: 7)
        state.p2pDataChannelOpened(generation: 7)
        XCTAssertEqual(state.active, .relay, "equal generation 是 stale contender")
        XCTAssertNil(state.activeP2PGeneration)

        state.beginP2PAttempt(generation: 6)
        state.p2pDataChannelOpened(generation: 6)
        XCTAssertEqual(state.active, .relay, "lower generation 不得回退 active lane")
        XCTAssertNil(state.activeP2PGeneration)
    }

    func testStaleRelayOpenOrCloseCannotReplaceCurrentFallback() {
        var state = NativeP2PPromotionState()
        state.relayOpened(generation: 7)
        state.relayOpened(generation: 8)
        state.relayOpened(generation: 7)
        XCTAssertEqual(state.relayGeneration, 8, "迟到 relay open 不得回退 fallback generation")

        state.relayClosed(generation: 7)
        XCTAssertTrue(state.relayAvailable, "旧 relay 的迟到 close 不得清掉新 fallback")
        XCTAssertEqual(state.active, .relay)

        state.beginP2PAttempt(generation: 9)
        state.p2pDataChannelOpened(generation: 9)
        state.p2pFailed(generation: 9)
        XCTAssertEqual(state.active, .relay)
        XCTAssertEqual(state.relayGeneration, 8)

        state.relayClosed(generation: 8)
        XCTAssertFalse(state.relayAvailable)
        XCTAssertEqual(state.active, .none)
    }

    func testStaleP2PCallbacksCannotReplaceOrDemoteNewGeneration() {
        var state = NativeP2PPromotionState()
        state.relayOpened(generation: 9)
        state.beginP2PAttempt(generation: 10)
        state.beginP2PAttempt(generation: 11)

        state.p2pDataChannelOpened(generation: 10)
        XCTAssertEqual(state.active, .relay, "旧 attempt 的迟到 open 不得 promotion")
        state.p2pDataChannelOpened(generation: 11)
        XCTAssertEqual(state.active, .p2p)
        XCTAssertEqual(state.activeP2PGeneration, 11)

        state.p2pFailed(generation: 10)
        XCTAssertEqual(state.active, .p2p, "旧 attempt 的迟到 failure 不得降级新连接")
        XCTAssertEqual(state.activeP2PGeneration, 11)
    }

    func testSendBackpressureAndFailureCloseWholeStream() {
        var state = NativeP2PSendState()
        XCTAssertEqual(state.decision(frameBytes: 1, bufferedAmount: 0), .accept)
        XCTAssertEqual(
            state.decision(
                frameBytes: NativeP2PFraming.maxFrameBytes,
                bufferedAmount: UInt64(NativeP2PSendState.highWaterBytes + 1)
            ),
            .backpressured
        )
        XCTAssertEqual(state.decision(frameBytes: 0, bufferedAmount: 0), .invalidFrame)
        state.recordSendFailure()
        XCTAssertEqual(state.decision(frameBytes: 1, bufferedAmount: 0), .closed)
    }

    func testFrameWriterClosesAfterPartialSendFailure() throws {
        let channel = RecordingChunkChannel(rejectedAttempt: 2)
        let writer = NativeP2PFrameWriter()
        let frame = patternedData(count: NativeP2PFraming.chunkBytes * 2)

        XCTAssertThrowsError(try writer.send(frame: frame, timeout: 1, channel: channel)) { error in
            XCTAssertEqual(error as? NativeP2PFramingError, .sendRejected)
        }
        let snapshot = channel.snapshot()
        XCTAssertTrue(snapshot.closed)
        XCTAssertEqual(snapshot.attempts, 2)
        XCTAssertEqual(snapshot.chunks.count, 1, "失败后的剩余分片不得继续发送")
    }

    func testFrameWriterSerializesConcurrentWholeFrames() throws {
        let channel = RecordingChunkChannel(sendDelay: 0.0005)
        let writer = NativeP2PFrameWriter()
        let frames = [
            Data(repeating: 0x41, count: NativeP2PFraming.chunkBytes * 2),
            Data(repeating: 0x42, count: NativeP2PFraming.chunkBytes * 2),
        ]

        DispatchQueue.concurrentPerform(iterations: frames.count) { index in
            try! writer.send(frame: frames[index], timeout: 2, channel: channel)
        }

        var assembler = NativeP2PFrameAssembler()
        let restored = try channel.snapshot().chunks.flatMap { try assembler.push($0) }
        XCTAssertEqual(restored.count, frames.count)
        XCTAssertTrue(restored == frames || restored == Array(frames.reversed()), "并发调用只能按整帧排序")
    }

    func testFrameWriterAdmissionTimeoutIncludesQueueWait() throws {
        let channel = BlockingChunkChannel()
        let writer = NativeP2PFrameWriter()
        let firstFinished = expectation(description: "first frame finished")

        DispatchQueue.global().async {
            defer { firstFinished.fulfill() }
            try! writer.send(frame: Data([0x41]), timeout: 2, channel: channel)
        }
        XCTAssertEqual(channel.firstSendStarted.wait(timeout: .now() + 1), .success)

        XCTAssertThrowsError(
            try writer.send(frame: Data(count: NativeP2PFraming.maxFrameBytes), timeout: 0.02, channel: channel)
        ) { error in
            XCTAssertEqual(error as? NativeP2PFramingError, .admissionTimeout)
        }
        XCTAssertTrue(channel.isOpen, "未写入任何分片的排队超时不应关闭健康 channel")

        channel.allowFirstSendToFinish()
        wait(for: [firstFinished], timeout: 1)
    }

    private func patternedData(count: Int) -> Data {
        Data((0..<count).lazy.map { UInt8($0 % 251) })
    }

    private func bigEndianBytes(_ value: UInt32) -> Data {
        var encoded = value.bigEndian
        return withUnsafeBytes(of: &encoded) { Data($0) }
    }
}

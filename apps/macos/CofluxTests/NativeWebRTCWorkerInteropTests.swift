import Darwin
import CryptoKit
import Foundation
import XCTest

final class NativeWebRTCWorkerInteropTests: XCTestCase {
    private static let protocolVersion: UInt32 = 1

    func testNativeLibWebRTCInteroperatesWithRustWorker() throws {
        let config = try interopConfiguration()
        let processBaselineRSS = residentMemoryBytes()
        let control = NativeP2PControlClient(url: config.controlURL, origin: config.origin)
        defer { control.close() }
        let auth = try control.authenticate(username: config.username, password: config.password)

        // 负向信令先跑：中心必须明确拒绝不存在的 daemon；同一 logical client 已建立的
        // relay 由外层 harness 随后做 ping，证明这次 P2P 失败没有破坏 fallback。
        try assertUnknownDaemonRejected(control: control, iceServers: auth.iceServers, config: config)
        try assertWorkerRejectedMalformedOffer(control: control, config: config)
        signal("p2p-rejected", in: config.coordinationDirectory)
        try waitForSignal("relay-after-rejection", in: config.coordinationDirectory, timeout: 20)

        let connectionID = "p2p-\(UUID().uuidString)"
        let channelID = "p2p-\(UUID().uuidString)"
        let offerer = try NativeWebRTCOfferer(channelID: channelID, iceServers: auth.iceServers)
        defer { offerer.close() }
        let idleRSS = residentMemoryBytes()
        let connectionStarted = Date()
        let offerSdp = try offerer.createGatheredOffer()

        var offer = Coflux_V1_DeviceP2pOffer()
        offer.daemonID = config.daemonID
        offer.connectionID = connectionID
        offer.clientInstanceID = config.clientInstanceID
        offer.sdp = offerSdp
        offer.protocolVersion = Self.protocolVersion
        try control.send(.deviceP2POffer(offer))
        let answerPayload = try control.waitPayload(timeout: 25) {
            if case .deviceP2PAnswer(let answer) = $0 { return answer.connectionID == connectionID }
            return false
        }
        guard case .deviceP2PAnswer(let answer) = answerPayload else {
            XCTFail("未收到 DeviceP2pAnswer")
            return
        }
        XCTAssertTrue(answer.ok, answer.error)
        XCTAssertTrue(answer.hasSdp)
        try offerer.setRemoteAnswer(answer.sdp)

        var open = Coflux_V1_DeviceP2pChannelOpen()
        open.daemonID = config.daemonID
        open.connectionID = connectionID
        open.channelID = channelID
        open.clientInstanceID = config.clientInstanceID
        open.transportGeneration = config.transportGeneration
        open.protocolVersion = Self.protocolVersion
        try control.send(.deviceP2PChannelOpen(open))
        let channelPayload = try control.waitPayload(timeout: 20) {
            if case .deviceP2PChannelResult(let result) = $0 { return result.channelID == channelID }
            return false
        }
        guard case .deviceP2PChannelResult(let channelResult) = channelPayload else {
            XCTFail("未收到 DeviceP2pChannelResult")
            return
        }
        XCTAssertTrue(channelResult.ok, channelResult.error)
        try offerer.waitForDataChannelOpen()
        XCTAssertTrue(offerer.dataChannel.isOrdered)

        let connectionMilliseconds = Date().timeIntervalSince(connectionStarted) * 1_000
        let connectedRSS = residentMemoryBytes()
        print(
            "COFLUX_WEBRTC_METRIC connection_ms=\(Int(connectionMilliseconds)) " +
            "process_baseline_rss_bytes=\(processBaselineRSS) " +
            "idle_rss_bytes=\(idleRSS) " +
            "idle_delta_bytes=\(positiveDelta(idleRSS, processBaselineRSS)) " +
            "connected_rss_bytes=\(connectedRSS) " +
            "connection_delta_bytes=\(positiveDelta(connectedRSS, idleRSS))"
        )

        // relay-first 的真实跨栈证据：外层 Node harness 在 native P2P open 后仍通过原 relay
        // 做一次生产 DevicePing；纯状态门另断言成功后才把 active transport promotion 为 P2P。
        signal("p2p-open", in: config.coordinationDirectory)
        try waitForSignal("relay-during-p2p", in: config.coordinationDirectory, timeout: 20)

        try assertCatalogRoundTrip(offerer: offerer, channelID: channelID)
        for size in [1, NativeP2PFraming.chunkBytes, NativeP2PFraming.chunkBytes * 3 + 17] {
            try assertWriteRoundTrip(
                offerer: offerer,
                channelID: channelID,
                workspaceID: config.workspaceID,
                bytes: asciiPattern(count: size),
                suffix: "boundary-\(size)"
            )
        }

        let nearMaximum = asciiPattern(count: config.nearMaximumPayloadBytes)
        let nearMaximumPath = try assertWriteRoundTrip(
            offerer: offerer,
            channelID: channelID,
            workspaceID: config.workspaceID,
            bytes: nearMaximum,
            suffix: "near-maximum"
        )
        try assertFileDigest(
            offerer: offerer,
            channelID: channelID,
            workspaceID: config.workspaceID,
            path: nearMaximumPath,
            expected: nearMaximum
        )
        try assertNearMaximumExecDownlink(
            offerer: offerer,
            channelID: channelID,
            workspaceID: config.workspaceID,
            expected: nearMaximum
        )

        // 真实中心消失：worker 会摘除 P2P，但 libwebrtc 另一端不保证及时收到 close。
        // harness 杀 server 后，这里记录实际状态并断言旧 channel 不再产生业务回应；
        // native Router 必须依赖 control/liveness 主动清理，不能依赖 onClose。
        signal("stop-server", in: config.coordinationDirectory)
        try waitForSignal("server-stopped", in: config.coordinationDirectory, timeout: 20)
        let silentRequestID = "native-silent-\(UUID().uuidString)"
        let silentFrame = try deviceEnvelope(
            channelID: channelID,
            payload: .sessionCatalogRequest(catalogRequest(silentRequestID))
        )
        let sendAfterControlLoss = (try? offerer.sendFrame(silentFrame, timeout: 2)) != nil
        var controlLossSignal = "silent-timeout"
        do {
            if let unexpected = try offerer.nextFrame(timeout: 3) {
                controlLossSignal = "unexpected-frame-\(unexpected.count)-bytes"
                XCTFail("中心断开后旧 P2P channel 不得继续收到 worker 业务回应")
            }
        } catch NativeP2PFramingError.dataChannelClosed {
            // 及时 closed 与保持 open 但业务静默都是允许的跨栈观测；Router 两者都要收敛。
            controlLossSignal = "explicit-close"
        }
        print(
            "COFLUX_WEBRTC_LIFECYCLE send_after_control_loss=\(sendAfterControlLoss) " +
            "signal=\(controlLossSignal) " + offerer.stateDescription
        )

        offerer.close()
        XCTAssertThrowsError(try offerer.sendFrame(silentFrame, timeout: 1))
        XCTAssertThrowsError(try offerer.nextFrame(timeout: 1), "主动关闭必须与静默 timeout 可区分") { error in
            XCTAssertEqual(error as? NativeP2PFramingError, .dataChannelClosed)
        }
    }

    private struct InteropConfiguration: Decodable {
        let controlURL: URL
        let origin: String
        let username: String
        let password: String
        let daemonID: String
        let workspaceID: String
        let clientInstanceID: String
        let transportGeneration: UInt64
        let coordinationDirectory: URL
        let nearMaximumPayloadBytes: Int
    }

    private func interopConfiguration() throws -> InteropConfiguration {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["COFLUX_WEBRTC_CONFIG_PATH"],
              !path.isEmpty,
              path != "$(COFLUX_WEBRTC_CONFIG_PATH)" else {
            throw XCTSkip("真实 Rust worker interop 仅由 test-webrtc-worker-interop.sh 启动")
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let config = try JSONDecoder().decode(InteropConfiguration.self, from: data)
        guard config.transportGeneration > 0 else {
            throw NativeWebRTCProbeError.invalidMessage("transport generation 无效")
        }
        guard config.nearMaximumPayloadBytes > 0,
              config.nearMaximumPayloadBytes < NativeP2PFraming.maxFrameBytes - 1024 else {
            throw NativeWebRTCProbeError.invalidMessage("near-maximum payload 无效")
        }
        return config
    }

    private func assertUnknownDaemonRejected(
        control: NativeP2PControlClient,
        iceServers: [String],
        config: InteropConfiguration
    ) throws {
        let connectionID = "p2p-\(UUID().uuidString)"
        let rejected = try NativeWebRTCOfferer(channelID: "p2p-\(UUID().uuidString)", iceServers: iceServers)
        defer { rejected.close() }
        var offer = Coflux_V1_DeviceP2pOffer()
        offer.daemonID = "daemon-does-not-exist"
        offer.connectionID = connectionID
        offer.clientInstanceID = config.clientInstanceID
        offer.sdp = try rejected.createGatheredOffer()
        offer.protocolVersion = Self.protocolVersion
        try control.send(.deviceP2POffer(offer))
        let payload = try control.waitPayload(timeout: 20) {
            if case .deviceP2PAnswer(let answer) = $0 { return answer.connectionID == connectionID }
            return false
        }
        guard case .deviceP2PAnswer(let answer) = payload else {
            XCTFail("负向 offer 未收到 answer")
            return
        }
        XCTAssertFalse(answer.ok)
        XCTAssertTrue(answer.hasError)
        XCTAssertTrue(answer.error.contains("不在线") || answer.error.contains("不属于"), answer.error)
    }

    private func assertWorkerRejectedMalformedOffer(
        control: NativeP2PControlClient,
        config: InteropConfiguration
    ) throws {
        let connectionID = "p2p-invalid-sdp-\(UUID().uuidString)"
        var offer = Coflux_V1_DeviceP2pOffer()
        offer.daemonID = config.daemonID
        offer.connectionID = connectionID
        offer.clientInstanceID = config.clientInstanceID
        offer.sdp = "not-a-valid-webrtc-offer"
        offer.protocolVersion = Self.protocolVersion
        try control.send(.deviceP2POffer(offer))
        let payload = try control.waitPayload(timeout: 20) {
            if case .deviceP2PAnswer(let answer) = $0 { return answer.connectionID == connectionID }
            return false
        }
        guard case .deviceP2PAnswer(let answer) = payload else {
            XCTFail("worker 负向 offer 未收到 answer")
            return
        }
        XCTAssertFalse(answer.ok)
        XCTAssertTrue(answer.hasError)
        XCTAssertTrue(answer.error.contains("sdp") || answer.error.contains("remote"), answer.error)
    }

    private func assertCatalogRoundTrip(offerer: NativeWebRTCOfferer, channelID: String) throws {
        let requestID = "native-catalog-\(UUID().uuidString)"
        try offerer.sendFrame(try deviceEnvelope(
            channelID: channelID,
            payload: .sessionCatalogRequest(catalogRequest(requestID))
        ))
        let envelope = try nextEnvelope(offerer: offerer, channelID: channelID, timeout: 20)
        guard case .sessionCatalog(let catalog)? = envelope.payload else {
            XCTFail("catalog 请求未返回 DeviceSessionCatalog")
            return
        }
        XCTAssertEqual(catalog.requestID, requestID)
    }

    @discardableResult
    private func assertWriteRoundTrip(
        offerer: NativeWebRTCOfferer,
        channelID: String,
        workspaceID: String,
        bytes: Data,
        suffix: String
    ) throws -> String {
        let requestID = "native-write-\(UUID().uuidString)"
        let path = ".coflux/pastes/native-p2p-\(suffix).txt"
        var write = Coflux_V1_DeviceFsWrite()
        write.requestID = requestID
        write.operationID = UUID().uuidString
        write.workspaceID = workspaceID
        write.path = path
        write.data = bytes
        write.temp = false
        try offerer.sendFrame(try deviceEnvelope(channelID: channelID, payload: .fsWrite(write)))
        let envelope = try nextEnvelope(
            offerer: offerer,
            channelID: channelID,
            timeout: bytes.count > 1024 * 1024 ? 120 : 20
        )
        guard case .fsWriteResult(let result)? = envelope.payload else {
            XCTFail("fsWrite 未返回 FsWriteResult（payload=\(String(describing: envelope.payload))）")
            return path
        }
        XCTAssertEqual(result.requestID, requestID)
        XCTAssertTrue(result.ok, result.error)
        return result.hasPath ? result.path : path
    }

    private func assertFileDigest(
        offerer: NativeWebRTCOfferer,
        channelID: String,
        workspaceID: String,
        path: String,
        expected: Data
    ) throws {
        let requestID = "native-digest-\(UUID().uuidString)"
        var request = Coflux_V1_DeviceExecRun()
        request.requestID = requestID
        request.workspaceID = workspaceID
        request.command = "node"
        request.args = [
            "-e",
            "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))",
            path,
        ]
        request.timeoutMs = 120_000
        try offerer.sendFrame(try deviceEnvelope(channelID: channelID, payload: .execRun(request)))
        let envelope = try nextEnvelope(offerer: offerer, channelID: channelID, timeout: 120)
        guard case .execResult(let result)? = envelope.payload else {
            XCTFail("digest 未返回 ExecResult")
            return
        }
        XCTAssertEqual(result.requestID, requestID)
        XCTAssertTrue(result.ok, result.error)
        let expectedDigest = SHA256.hash(data: expected).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(result.stdout, expectedDigest)
    }

    /// `fsRead` 的生产业务上限是 2 MiB，不能为了 transport probe 放宽。大下行改由
    /// 生产 DeviceExecRun/ExecResult 生成 29 MiB stdout，仍经过真实 worker router、
    /// protobuf、DataChannel 分片和 native assembler。
    private func assertNearMaximumExecDownlink(
        offerer: NativeWebRTCOfferer,
        channelID: String,
        workspaceID: String,
        expected: Data
    ) throws {
        let requestID = "native-downlink-\(UUID().uuidString)"
        var request = Coflux_V1_DeviceExecRun()
        request.requestID = requestID
        request.workspaceID = workspaceID
        request.command = "node"
        request.args = [
            "-e",
            "const n=Number(process.argv[1]),c='abcdefghijklmnopqrstuvw';process.stdout.write(c.repeat(Math.floor(n/c.length))+c.slice(0,n%c.length))",
            String(expected.count),
        ]
        request.timeoutMs = 120_000
        try offerer.sendFrame(try deviceEnvelope(channelID: channelID, payload: .execRun(request)))
        let envelope = try nextEnvelope(offerer: offerer, channelID: channelID, timeout: 120)
        guard case .execResult(let result)? = envelope.payload else {
            XCTFail("近 30 MiB 下行未返回 ExecResult")
            return
        }
        XCTAssertEqual(result.requestID, requestID)
        XCTAssertTrue(result.ok, result.error)
        let actual = Data(result.stdout.utf8)
        XCTAssertEqual(actual.count, expected.count)
        XCTAssertNil(firstMismatch(actual, expected), "近 30 MiB 下行首个差异 offset 不应存在")
    }

    private func nextEnvelope(
        offerer: NativeWebRTCOfferer,
        channelID: String,
        timeout: TimeInterval
    ) throws -> Coflux_V1_DeviceEnvelope {
        guard let frame = try offerer.nextFrame(timeout: timeout) else {
            throw NativeWebRTCProbeError.timeout("DeviceEnvelope response")
        }
        let envelope = try Coflux_V1_DeviceEnvelope(serializedBytes: frame)
        XCTAssertEqual(envelope.protocolVersion, Self.protocolVersion)
        XCTAssertEqual(envelope.channelID, channelID)
        return envelope
    }

    private func deviceEnvelope(
        channelID: String,
        payload: Coflux_V1_DeviceEnvelope.OneOf_Payload
    ) throws -> Data {
        var envelope = Coflux_V1_DeviceEnvelope()
        envelope.protocolVersion = Self.protocolVersion
        envelope.channelID = channelID
        envelope.payload = payload
        return try envelope.serializedData()
    }

    private func catalogRequest(_ requestID: String) -> Coflux_V1_DeviceSessionCatalogRequest {
        var request = Coflux_V1_DeviceSessionCatalogRequest()
        request.requestID = requestID
        return request
    }

    private func asciiPattern(count: Int) -> Data {
        var data = Data(count: count)
        data.withUnsafeMutableBytes { rawBuffer in
            guard let bytes = rawBuffer.bindMemory(to: UInt8.self).baseAddress else { return }
            for index in 0..<count {
                bytes[index] = UInt8(ascii: "a") + UInt8(index % 23)
            }
        }
        return data
    }

    private func firstMismatch(_ left: Data, _ right: Data) -> Int? {
        guard left.count == right.count else { return min(left.count, right.count) }
        return left.withUnsafeBytes { leftBuffer in
            right.withUnsafeBytes { rightBuffer in
                let leftBytes = leftBuffer.bindMemory(to: UInt8.self)
                let rightBytes = rightBuffer.bindMemory(to: UInt8.self)
                for index in 0..<left.count where leftBytes[index] != rightBytes[index] { return index }
                return nil
            }
        }
    }

    private func signal(_ name: String, in directory: URL) {
        let path = directory.appendingPathComponent(name).path
        FileManager.default.createFile(atPath: path, contents: Data())
    }

    private func waitForSignal(_ name: String, in directory: URL, timeout: TimeInterval) throws {
        let path = directory.appendingPathComponent(name).path
        let deadline = Date().addingTimeInterval(timeout)
        while deadline.timeIntervalSinceNow > 0 {
            if FileManager.default.fileExists(atPath: path) { return }
            Thread.sleep(forTimeInterval: 0.02)
        }
        throw NativeWebRTCProbeError.timeout("harness signal \(name)")
    }

    private func residentMemoryBytes() -> UInt64 {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { integerPointer in
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), integerPointer, &count)
            }
        }
        return result == KERN_SUCCESS ? UInt64(info.resident_size) : 0
    }

    private func positiveDelta(_ end: UInt64, _ start: UInt64) -> UInt64 {
        end >= start ? end - start : 0
    }
}

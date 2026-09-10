import CofluxClientCore
import Darwin
import XCTest
@preconcurrency import WebRTC
@testable import Coflux

@MainActor
final class NativeRTCPeerTests: XCTestCase {
    func testUnresponsiveSTUNStillConnectsUsingHostCandidates() async throws {
        // 占用本机随机 UDP 端口但不回复，确保测试不依赖公网 STUN 和外网路由。
        let blackhole = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard blackhole >= 0 else { throw URLError(.cannotCreateFile) }
        defer { Darwin.close(blackhole) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(blackhole, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { throw URLError(.cannotConnectToHost) }
        var size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(blackhole, $0, &size) }
        }
        guard named == 0 else { throw URLError(.cannotConnectToHost) }
        let port = UInt16(bigEndian: address.sin_port)
        let offerer = try NativeRTCPeer(iceServers: ["stun:127.0.0.1:\(port)"])
        let answerer = try NativeRTCPeer(iceServers: [])
        defer { offerer.close(); answerer.close() }
        let channel = try offerer.createDataChannel(label: "blackhole-stun")
        let probe = RTCFrameProbe()
        var receivedChannel: RTCDataChannel?
        answerer.onDataChannel = { receivedChannel = $0; $0.delegate = probe }
        let started = ContinuousClock.now
        let offer = try await offerer.makeOffer()
        let elapsed = started.duration(to: .now)
        XCTAssertGreaterThanOrEqual(elapsed, .milliseconds(2800))
        XCTAssertLessThan(elapsed, .seconds(6))
        XCTAssertTrue(offer.contains(" typ host"))
        // 确认本机 UDP socket 实际收到了请求，不把错误 URL 的早退误当作 STUN 超时。
        var byte: UInt8 = 0
        XCTAssertGreaterThan(recv(blackhole, &byte, 1, MSG_PEEK | MSG_DONTWAIT), 0)
        let answer = try await answerer.answer(offer: offer)
        try await offerer.accept(answer: answer)
        try await waitUntil { channel.readyState == .open }
        let expected = Data("STUN 无响应仍可直连😀".utf8)
        for chunk in try P2PFraming.chunks(for: expected) {
            XCTAssertTrue(channel.sendData(RTCDataBuffer(data: chunk, isBinary: true)))
        }
        try await waitUntil { probe.frames.count == 1 }
        XCTAssertEqual(probe.frames, [expected])
        XCTAssertEqual(receivedChannel?.readyState, .open)
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !condition() {
            guard ContinuousClock.now < deadline else { throw NativeRTCError.gatheringTimedOut }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    func testRealDataOnlyPeersExchangeFramedBytes() async throws {
        // 仅本机 host candidates，无 STUN/TURN、中心服务、凭据或媒体采集。
        let offerer = try NativeRTCPeer(iceServers: [])
        let answerer = try NativeRTCPeer(iceServers: [])
        defer { offerer.close(); answerer.close() }
        let outbound = try offerer.createDataChannel(label: "p2p-native-test")
        let incomingProbe = RTCFrameProbe()
        let outgoingProbe = RTCFrameProbe()
        outbound.delegate = outgoingProbe
        var inbound: RTCDataChannel?
        answerer.onDataChannel = { channel in
            inbound = channel
            channel.delegate = incomingProbe
        }
        let offer = try await offerer.makeOffer()
        XCTAssertTrue(offer.contains("m=application"))
        XCTAssertFalse(offer.contains("m=audio"))
        XCTAssertFalse(offer.contains("m=video"))
        XCTAssertTrue(offer.contains("a=candidate:"))
        let answer = try await answerer.answer(offer: offer)
        try await offerer.accept(answer: answer)
        try await waitUntil { outbound.readyState == .open && inbound?.readyState == .open }
        let receivedChannel = try XCTUnwrap(inbound)
        XCTAssertEqual(receivedChannel.label, "p2p-native-test")
        let payload = Data(repeating: 0xab, count: 300 * 1024)
        for chunk in try P2PFraming.chunks(for: payload) {
            XCTAssertTrue(outbound.sendData(RTCDataBuffer(data: chunk, isBinary: true)))
        }
        let reply = Data("原生双向数据😀".utf8)
        for chunk in try P2PFraming.chunks(for: reply) {
            XCTAssertTrue(receivedChannel.sendData(RTCDataBuffer(data: chunk, isBinary: true)))
        }
        try await waitUntil { incomingProbe.frames.count == 1 && outgoingProbe.frames.count == 1 }
        XCTAssertEqual(incomingProbe.frames, [payload])
        XCTAssertEqual(outgoingProbe.frames, [reply])
        XCTAssertNil(incomingProbe.error)
        XCTAssertNil(outgoingProbe.error)
        offerer.close()
        try await waitUntil { receivedChannel.readyState == .closed }
    }

    func testClosedPeerCannotCreateOrNegotiate() async throws {
        let peer = try NativeRTCPeer(iceServers: [])
        peer.close()
        peer.close()
        XCTAssertThrowsError(try peer.createDataChannel(label: "closed"))
        do {
            _ = try await peer.makeOffer()
            XCTFail("已关闭的 peer 不应生成 offer")
        } catch NativeRTCError.closed {} catch { XCTFail("意外错误：\(error)") }
    }

    func testInvalidSDPClosesPeer() async throws {
        let peer = try NativeRTCPeer(iceServers: [])
        defer { peer.close() }
        do {
            _ = try await peer.answer(offer: "invalid SDP")
            XCTFail("非法 SDP 不应协商成功")
        } catch {}
        XCTAssertThrowsError(try peer.createDataChannel(label: "after-failure"))
    }

    func testCancelledNegotiationClosesPeer() async throws {
        let peer = try NativeRTCPeer(iceServers: [])
        defer { peer.close() }
        _ = try peer.createDataChannel(label: "cancelled")
        let negotiation = Task { try await peer.makeOffer() }
        negotiation.cancel()
        do {
            _ = try await negotiation.value
            XCTFail("取消后不应发布 SDP")
        } catch is CancellationError {} catch { XCTFail("意外错误：\(error)") }
        XCTAssertThrowsError(try peer.createDataChannel(label: "after-cancellation"))
    }
}

@MainActor
private final class RTCFrameProbe: NSObject, RTCDataChannelDelegate {
    var frames: [Data] = []
    var error: (any Error)?
    private var assembler = P2PFrameAssembler()

    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            do { self.frames += try self.assembler.push(data) }
            catch { self.error = error }
        }
    }
}

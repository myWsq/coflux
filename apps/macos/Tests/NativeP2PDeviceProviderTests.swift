import CofluxClientCore
import CofluxProtocol
import XCTest
@testable import Coflux

@MainActor
final class NativeP2PDeviceProviderTests: XCTestCase {
    private func waitUntil(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !predicate() {
            guard ContinuousClock.now < deadline else { throw NativeRTCError.gatheringTimedOut }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    func testTwoChannelsReusePeerWithSeparateAuthorization() async throws {
        let provider = NativeP2PDeviceProvider()
        let signaling = P2PSignalingFixture()
        defer { provider.closeAll(); signaling.close() }
        async let first = provider.open(daemonID: "device", accountID: "account", clientInstanceID: "client", generation: 41,
            iceServers: [], authorize: signaling.authorize)
        async let second = provider.open(daemonID: "device", accountID: "account", clientInstanceID: "client", generation: 42,
            iceServers: [], authorize: signaling.authorize)
        let (one, two) = try await (first, second)
        XCTAssertEqual(signaling.offerCount, 1)
        XCTAssertEqual(signaling.requests.count, 2)
        XCTAssertEqual(Set(signaling.requests.map(\.transportGeneration)), [41, 42])
        XCTAssertNotEqual(one.channelID, two.channelID)
        try await waitUntil { signaling.channels[two.channelID] != nil }
        await one.connection.close()
        // 关闭 session lane 不得误关同 peer 上的 elevated lane。
        let expected = Data("第二条通道😀".utf8)
        try await two.connection.send(expected)
        let remote = try XCTUnwrap(signaling.channels[two.channelID])
        let received = try await remote.receive()
        XCTAssertEqual(received, expected)
        provider.remove(daemonID: "device")
        do { _ = try await two.connection.receive(); XCTFail("设备移除应关闭通道") } catch {}
    }

    func testMismatchedAuthorizationCannotExposeChannel() async throws {
        let provider = NativeP2PDeviceProvider()
        let signaling = P2PSignalingFixture()
        signaling.wrongChannelID = true
        defer { provider.closeAll(); signaling.close() }
        do {
            _ = try await provider.open(daemonID: "device", accountID: "account", clientInstanceID: "client", generation: 1,
                iceServers: [], authorize: signaling.authorize)
            XCTFail("不匹配的授权不应返回通道")
        } catch is NativeP2PError {} catch { XCTFail("意外错误：\(error)") }
        XCTAssertEqual(signaling.requests.count, 1)
    }

    func testLateGrantAfterRemovalCannotRestorePeer() async throws {
        let provider = NativeP2PDeviceProvider()
        let signaling = P2PSignalingFixture()
        signaling.holdGrant = true
        defer { provider.closeAll(); signaling.close() }
        let opening = Task {
            try await provider.open(daemonID: "device", accountID: "account", clientInstanceID: "client", generation: 1,
                iceServers: [], authorize: signaling.authorize)
        }
        try await waitUntil { signaling.grantWaiter != nil }
        provider.remove(daemonID: "device")
        signaling.releaseGrant()
        do { _ = try await opening.value; XCTFail("迟到授权不能复活已移除的 peer") } catch {}
        signaling.holdGrant = false
        let next = try await provider.open(daemonID: "device", accountID: "account", clientInstanceID: "client", generation: 2,
            iceServers: [], authorize: signaling.authorize)
        XCTAssertEqual(signaling.offerCount, 2)
        await next.connection.close()
    }

    func testCancelledChannelDoesNotCloseSharedPeer() async throws {
        let provider = NativeP2PDeviceProvider()
        let signaling = P2PSignalingFixture()
        signaling.holdGrant = true
        defer { provider.closeAll(); signaling.close() }
        let pending = Task {
            try await provider.open(daemonID: "device", accountID: "account", clientInstanceID: "client", generation: 1,
                iceServers: [], authorize: signaling.authorize)
        }
        try await waitUntil { signaling.grantWaiter != nil }
        signaling.holdGrant = false
        let active = try await provider.open(daemonID: "device", accountID: "account", clientInstanceID: "client", generation: 2,
            iceServers: [], authorize: signaling.authorize)
        pending.cancel()
        signaling.releaseGrant()
        do { _ = try await pending.value; XCTFail("取消的通道不应交给调用方") } catch is CancellationError {} catch { XCTFail("意外错误：\(error)") }
        XCTAssertEqual(signaling.offerCount, 1)
        try await waitUntil { signaling.channels[active.channelID] != nil }
        try await active.connection.send(Data([1, 2, 3]))
        let bytes = try await signaling.channels[active.channelID]!.receive()
        XCTAssertEqual(bytes, Data([1, 2, 3]))
        await active.connection.close()
    }
}

@MainActor
private final class P2PSignalingFixture {
    var peers: [NativeRTCPeer] = []
    var channels: [String: NativeRTCConnection] = [:]
    var requests: [Coflux_V1_DeviceP2pChannelOpen] = []
    var offerCount = 0
    var wrongChannelID = false
    var holdGrant = false
    var grantWaiter: CheckedContinuation<Void, Never>?

    func authorize(_ payload: Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload {
        switch payload {
        case .deviceP2POffer(let offer):
            offerCount += 1
            let peer = try NativeRTCPeer(iceServers: [])
            peers.append(peer)
            peer.onDataChannel = { [weak self] channel in self?.channels[channel.label] = NativeRTCConnection(channel: channel) }
            var answer = Coflux_V1_DeviceP2pAnswer()
            answer.connectionID = offer.connectionID; answer.ok = true
            answer.sdp = try await peer.answer(offer: offer.sdp)
            return .deviceP2PAnswer(answer)
        case .deviceP2PChannelOpen(let request):
            requests.append(request)
            if holdGrant { await withCheckedContinuation { grantWaiter = $0 } }
            var result = Coflux_V1_DeviceP2pChannelResult()
            result.channelID = wrongChannelID ? "wrong" : request.channelID
            result.ok = true
            return .deviceP2PChannelResult(result)
        default: throw NativeP2PError(message: "意外的控制消息")
        }
    }
    func releaseGrant() { grantWaiter?.resume(); grantWaiter = nil }
    func close() {
        releaseGrant()
        for peer in peers { peer.close() }
        for channel in channels.values { Task { await channel.close() } }
        channels.removeAll()
    }
}

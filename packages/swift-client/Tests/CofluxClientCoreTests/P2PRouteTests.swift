import CofluxProtocol
import Foundation
import Testing
@testable import CofluxClientCore

@MainActor private final class RoutedP2PProvider: P2PDeviceTransportProvider {
    var opened: [(connection: FakeConnection, id: String, generation: UInt64)] = []
    var failure = false
    var closeCount = 0
    var removed: [String] = []
    var servers: [String] = []
    func open(daemonID: String, accountID: String, clientInstanceID: String, generation: UInt64,
              iceServers: [String],
              authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload) async throws -> P2PDeviceChannel {
        if failure { throw DeviceRouteError("测试 P2P 不可达") }
        servers = iceServers
        var offer = Coflux_V1_DeviceP2pOffer()
        offer.connectionID = "p2p-offer-\(UUID())"; offer.daemonID = daemonID
        guard case .deviceP2PAnswer(let answer) = try await authorize(.deviceP2POffer(offer)), answer.ok else {
            throw DeviceRouteError("测试 offer 被拒")
        }
        var request = Coflux_V1_DeviceP2pChannelOpen()
        request.channelID = "p2p-channel-\(UUID())"; request.connectionID = offer.connectionID
        request.daemonID = daemonID; request.transportGeneration = generation
        guard case .deviceP2PChannelResult(let grant) = try await authorize(.deviceP2PChannelOpen(request)), grant.ok else {
            throw DeviceRouteError("测试 channel 被拒")
        }
        let connection = FakeConnection()
        opened.append((connection, request.channelID, generation))
        return P2PDeviceChannel(connection: connection, channelID: request.channelID)
    }
    func closeAll() { closeCount += 1; for item in opened { Task { await item.connection.close() } } }
    func remove(daemonID: String) { removed.append(daemonID); closeAll() }
}

@MainActor struct P2PRouteTests {
    @Test func p2pDisconnectDiagnosticNamesActualTransport() async throws {
        let provider = RoutedP2PProvider()
        let h = DeviceHarness(p2pProvider: provider)
        h.router.setAccountID("account"); h.router.setControlOnline(true)
        defer { h.router.reset() }
        let release = h.router.retainMeasure(daemonID: "d1")
        defer { release() }
        try await grant(h)
        #expect(await waitUntil { h.transportModes.last == "p2p" })
        let active = try #require(provider.opened.first)
        active.connection.finish()
        #expect(await waitUntil { h.transportModes.last == "offline" })
        #expect(h.transportDetails.last == "P2P 连接已关闭")
    }

    private func pings(_ h: DeviceHarness, _ connection: FakeConnection) -> [Coflux_V1_DevicePing] {
        h.deviceFrames(connection).compactMap { if case .ping(let ping) = $0.payload { return ping }; return nil }
    }

    @Test func silentP2PWithoutSidebarMeasurementRecoversViaRelay() async throws {
        let provider = RoutedP2PProvider()
        let h = DeviceHarness(p2pProvider: provider, heartbeatInterval: .seconds(1), heartbeatTimeout: .milliseconds(150))
        h.router.setAccountID("account"); h.router.setControlOnline(true)
        defer { h.router.reset() }
        h.router.attachSession(daemonID: "d1", taskID: "t1", sessionID: "s1", cols: 80, rows: 24)
        try await grant(h)
        #expect(await waitUntil { provider.opened.count == 1 })
        let active = try #require(provider.opened.first)
        let relay = try await h.grantNextRelay()
        #expect(active.connection.closed)
        #expect(pings(h, active.connection).count == 2)
        #expect(await waitUntil { h.transportModes.last == "relay" })
        #expect(!relay.closed)
        #expect(provider.opened.count == 1)
    }

    @Test func OnlyMatchingPongClearsMisses() async throws {
        let h = DeviceHarness(heartbeatInterval: .seconds(2), heartbeatTimeout: .milliseconds(150))
        defer { h.router.reset() }
        let (connection, id) = try await h.attachAndSnapshot()
        #expect(await waitUntil { self.pings(h, connection).count == 1 })
        var wrong = Coflux_V1_DevicePong(); wrong.requestID = "unrelated"
        h.push(connection, channelID: id, .pong(wrong))
        #expect(await waitUntil { self.pings(h, connection).count == 2 })
        var pong = Coflux_V1_DevicePong(); pong.requestID = try #require(pings(h, connection).last).requestID
        h.nowMS += 12
        h.push(connection, channelID: id, .pong(pong))
        #expect(await waitUntil { h.transportEvents.last?.rttMs == 12 })
        try await Task.sleep(for: .milliseconds(400))
        #expect(!connection.closed)
        #expect(pings(h, connection).count == 2)
    }

    @Test func unsupportedHeartbeatDoesNotDisconnectOldWorker() async throws {
        let h = DeviceHarness(heartbeatInterval: .milliseconds(100), heartbeatTimeout: .milliseconds(150))
        defer { h.router.reset() }
        let (connection, id) = try await h.attachAndSnapshot()
        #expect(await waitUntil { self.pings(h, connection).count == 1 })
        var error = Coflux_V1_DeviceError(); error.code = "empty_payload"
        h.push(connection, channelID: id, .error(error))
        try await Task.sleep(for: .milliseconds(400))
        #expect(!connection.closed)
        #expect(pings(h, connection).count == 1)
        #expect(h.errors.isEmpty)
    }

    @Test func pendingHeartbeatDoesNotPreventIdleRelease() async throws {
        let h = DeviceHarness(heartbeatInterval: .milliseconds(100), heartbeatTimeout: .milliseconds(150))
        h.router.setControlOnline(true)
        defer { h.router.reset() }
        let release = h.router.retainMeasure(daemonID: "d1")
        let connection = try await h.grantNextRelay()
        #expect(await waitUntil { !self.pings(h, connection).isEmpty })
        release()
        #expect(await waitUntil { connection.closed })
        try await Task.sleep(for: .milliseconds(400))
        #expect(h.relayConnectCount == 1)
    }
    private func grant(_ harness: DeviceHarness) async throws {
        #expect(await waitUntil { harness.controlSent.contains { if case .deviceP2POffer = $0 { return true }; return false } })
        let offer = try #require(harness.controlSent.compactMap { payload -> Coflux_V1_DeviceP2pOffer? in
            if case .deviceP2POffer(let value) = payload { return value }; return nil
        }.last)
        var answer = Coflux_V1_DeviceP2pAnswer(); answer.connectionID = offer.connectionID; answer.ok = true
        _ = harness.router.handleControlPayload(.deviceP2PAnswer(answer))
        #expect(await waitUntil { harness.controlSent.contains { if case .deviceP2PChannelOpen = $0 { return true }; return false } })
        let request = try #require(harness.controlSent.compactMap { payload -> Coflux_V1_DeviceP2pChannelOpen? in
            if case .deviceP2PChannelOpen(let value) = payload { return value }; return nil
        }.last)
        var result = Coflux_V1_DeviceP2pChannelResult(); result.channelID = request.channelID; result.ok = true
        _ = harness.router.handleControlPayload(.deviceP2PChannelResult(result))
    }

    @Test func authorizedP2PWinsAndControlDisconnectClosesIt() async throws {
        let provider = RoutedP2PProvider()
        let h = DeviceHarness(p2pProvider: provider)
        h.router.setAccountID("account"); h.router.setIceServers(["stun:example.test:3478"])
        h.router.setControlOnline(true)
        defer { h.router.reset() }
        h.router.attachSession(daemonID: "d1", taskID: "t1", sessionID: "s1", cols: 80, rows: 24)
        try await grant(h)
        #expect(await waitUntil { provider.opened.count == 1 && h.transportModes.last == "p2p" })
        let active = try #require(provider.opened.first)
        // 通道提升先发布 transport mode，attach 帧经异步发送队列随后投递。
        #expect(await waitUntil { !h.attachFrames(active.connection).isEmpty })
        #expect(provider.servers == ["stun:example.test:3478"])
        #expect(h.relayConnectCount == 0)
        h.router.setControlOnline(false)
        #expect(await waitUntil { active.connection.closed })
        #expect(provider.closeCount > 0)
    }

    @Test func failedP2PFallsBackThenPromotesRelay() async throws {
        let provider = RoutedP2PProvider(); provider.failure = true
        let h = DeviceHarness(p2pProvider: provider)
        h.router.setAccountID("account"); h.router.setControlOnline(true)
        defer { h.router.reset() }
        h.router.attachSession(daemonID: "d1", taskID: "t1", sessionID: "s1", cols: 80, rows: 24)
        let relay = try await h.grantNextRelay()
        #expect(await waitUntil { h.transportModes.last == "relay" })
        provider.failure = false
        h.nowMS += 31_000
        try await grant(h)
        #expect(await waitUntil { h.transportModes.last == "p2p" })
        #expect(await waitUntil { relay.closed })
        let active = try #require(provider.opened.first)
        #expect(active.generation > 1)
        active.connection.finish()
        let fallback = try await h.grantNextRelay()
        #expect(await waitUntil { h.transportModes.last == "relay" })
        #expect(!fallback.closed)
        #expect(provider.opened.count == 1)
    }

    @Test func removalRejectsLateNegotiation() async throws {
        let provider = RoutedP2PProvider()
        let h = DeviceHarness(p2pProvider: provider)
        h.router.setAccountID("account"); h.router.setControlOnline(true)
        defer { h.router.reset() }
        h.router.attachSession(daemonID: "d1", taskID: "t1", sessionID: "s1", cols: 80, rows: 24)
        #expect(await waitUntil { !h.controlSent.isEmpty })
        h.router.removeDaemon("d1")
        #expect(provider.removed == ["d1"])
        try await Task.sleep(for: .milliseconds(300))
        #expect(provider.opened.isEmpty)
        #expect(h.transportModes.allSatisfy { $0 != "p2p" })
    }
}

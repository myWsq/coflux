import CofluxProtocol
import Foundation
import Testing
@testable import CofluxClientCore

@MainActor struct ControlGraceTests {
    @Test func transientDisconnectKeepsInputButRejectsRPC() async throws {
        let h = DeviceHarness(controlGraceDuration: .milliseconds(500))
        defer { h.router.reset() }
        let (connection, _) = try await h.attachAndSnapshot()
        h.router.setControlDisconnected()
        #expect(h.router.hasSessionControl(daemonID: "d1", sessionID: "s1"))
        h.router.sendInput(daemonID: "d1", sessionID: "s1", data: Data("during grace".utf8))
        #expect(await waitUntil { !h.inputFrames(connection).isEmpty })
        do {
            _ = try await h.router.execute(daemonID: "d1", workspaceID: "w1", command: "git", args: ["status"])
            Issue.record("断线宽限不能执行 RPC")
        } catch let error as DeviceRouteError { #expect(error.code == "lease_offline") }
        #expect(h.relayConnectCount == 1)
        #expect(!connection.closed)
    }

    @Test func reconnectCancelsGraceWithoutReplacingChannel() async throws {
        let h = DeviceHarness(controlGraceDuration: .milliseconds(200))
        defer { h.router.reset() }
        let (connection, _) = try await h.attachAndSnapshot()
        h.router.setControlDisconnected()
        try await Task.sleep(for: .milliseconds(50))
        h.router.setControlOnline(true)
        try await Task.sleep(for: .milliseconds(250))
        #expect(!connection.closed)
        #expect(h.router.hasSessionControl(daemonID: "d1", sessionID: "s1"))
        #expect(h.relayConnectCount == 1)
    }

    @Test func repeatedDisconnectDoesNotExtendDeadline() async throws {
        let h = DeviceHarness(controlGraceDuration: .milliseconds(300))
        defer { h.router.reset() }
        let (connection, _) = try await h.attachAndSnapshot()
        h.router.setControlDisconnected()
        try await Task.sleep(for: .milliseconds(150))
        h.router.setControlDisconnected()
        #expect(await waitUntil(timeout: .milliseconds(220)) { connection.closed })
        #expect(!h.router.hasSessionControl(daemonID: "d1", sessionID: "s1"))
        #expect(h.relayConnectCount == 1)
    }

    @Test func hardRevocationDuringGraceClosesImmediately() async throws {
        let h = DeviceHarness(controlGraceDuration: .seconds(10))
        defer { h.router.reset() }
        let (connection, _) = try await h.attachAndSnapshot()
        h.router.setControlDisconnected()
        h.router.setControlOnline(false)
        #expect(await waitUntil { connection.closed })
        #expect(!h.router.hasSessionControl(daemonID: "d1", sessionID: "s1"))
    }

    @Test func transientDisconnectImmediatelyClosesElevatedLane() async throws {
        let h = DeviceHarness(controlGraceDuration: .seconds(10))
        defer { h.router.reset() }
        let (session, _) = try await h.attachAndSnapshot()
        let request = Task { try await h.router.execute(daemonID: "d1", workspaceID: "w1", command: "git", args: ["status"]) }
        let elevated = try await h.grantNextRelay()
        h.router.setControlDisconnected()
        #expect(await waitUntil { elevated.closed })
        #expect(!session.closed)
        h.router.reset()
        do { _ = try await request.value; Issue.record("重置后请求应退出") } catch {}
    }
}

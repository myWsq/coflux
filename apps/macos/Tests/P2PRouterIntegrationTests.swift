import CofluxClientCore
import CofluxProtocol
import Foundation
import XCTest
@testable import Coflux

private actor DroppableControlTransport: Transport {
    private var control: (any TransportConnection)?
    private var blocked = false
    func connect(to url: URL) async throws -> any TransportConnection {
        if url.path == "/client", blocked { throw URLError(.notConnectedToInternet) }
        let connection = try await SocketTransport().connect(to: url)
        if url.path == "/client" { control = connection }
        return connection
    }
    func disconnectControl() async {
        blocked = true
        await control?.close()
        control = nil
    }
    func restoreControl() { blocked = false }
}

@MainActor final class P2PRouterIntegrationTests: XCTestCase {
    func testOfflineP2PCloseReplaysCatalogRemovalAfterReconnect() async throws {
        try await verifyOfflineClose(mode: "p2p")
    }
    func testOfflineDirectCloseReplaysCatalogRemovalAfterReconnect() async throws {
        try await verifyOfflineClose(mode: "direct")
    }
    private func verifyOfflineClose(mode: String) async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.host == "127.0.0.1" else { throw XCTSkip("需隔离 dev-fixture") }
        let provider = NativeP2PDeviceProvider()
        let credentials = MemoryLocalCredentialStore()
        let local = SwitchableLocalProvider(NativeLocalDeviceProvider(serverURL: url, credentialStoreFactory: { _ in credentials }))
        local.available = true
        let transport = DroppableControlTransport()
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
            transport: transport, tokenStore: EmptyTokenStore(), localDeviceProvider: mode == "direct" ? local : nil, p2pDeviceProvider: mode == "p2p" ? provider : nil)
        defer { client.logout(); provider.closeAll() }
        client.login(username: "admin", password: "admin")
        try await wait { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        let releaseMeasure = client.retainDeviceMeasure(daemonID: workspace.daemonID)
        defer { releaseMeasure() }
        try await wait { client.deviceTransports[workspace.daemonID]?.mode == mode }
        let title = "native-offline-close-" + UUID().uuidString
        client.createTask(workspaceID: workspace.id, title: title)
        try await wait { client.tasks.contains { $0.title == title } }
        let task = try XCTUnwrap(client.tasks.first { $0.title == title })
        func cleanupGrant() async throws {
            if let grant = credentials.grant(daemonID: workspace.daemonID) {
                try await local.unpair(serverURL: url, daemonID: workspace.daemonID, grantID: grant.grantID)
                credentials.removeGrant(daemonID: workspace.daemonID)
            }
        }
        do {
            client.startTask(taskID: task.id, cols: 80, rows: 24)
            try await wait { client.tasks.contains { $0.id == task.id && $0.status == .running && $0.hasSessionID } }
            let running = try XCTUnwrap(client.tasks.first { $0.id == task.id })
            var output = Data()
            let release = client.registerSessionConsumer(sessionID: running.sessionID) { bytes, replace in
                if replace { output = bytes } else { output.append(bytes) }
            }
            defer { release() }
            client.startTask(taskID: task.id, cols: 80, rows: 24)
            try await wait { client.hasSessionControl(sessionID: running.sessionID) }
            client.sendInput(sessionID: running.sessionID, "printf '%s:%s\\n' p2p native\r")
            try await wait { String(decoding: output, as: UTF8.self).contains("p2p:native") }
            let git = try await client.executeInWorkspace(workspaceID: workspace.id, command: "git", args: ["rev-parse", "--is-inside-work-tree"])
            XCTAssertEqual(git.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "true")
            XCTAssertEqual(client.deviceTransports[workspace.daemonID]?.mode, mode)
            await transport.disconnectControl()
            try await wait { client.status != .connected }
            XCTAssertTrue(client.hasSessionControl(sessionID: running.sessionID))
            let errorsBefore = client.lastError?.id
            await client.closeTask(running)
            XCTAssertEqual(client.lastError?.id, errorsBefore, "中心离线关闭不能报告删除失败")
            try await wait { client.tasks.first(where: { $0.id == task.id })?.status == .exited }
            XCTAssertTrue(client.tasks.contains { $0.id == task.id }, "中心确认前保留目录实体")
            XCTAssertNotEqual(client.status, .connected)
            await transport.restoreControl()
            try await wait { client.status == .connected && client.syncState == .synced }
            try await wait { !client.tasks.contains { $0.id == task.id } }
        } catch {
            await transport.restoreControl()
            if client.status != .connected { client.resume(); try? await wait { client.status == .connected && client.syncState == .synced } }
            if let current = client.tasks.first(where: { $0.id == task.id }) { await client.closeTask(current) }
            try? await cleanupGrant()
            throw error
        }
        if let current = client.tasks.first(where: { $0.id == task.id }) { await client.closeTask(current) }
        try await wait { !client.tasks.contains { $0.id == task.id } }
        try await cleanupGrant()
    }

    func testNativeP2PTerminalRPCAndRelayFallback() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.host == "127.0.0.1" else { throw XCTSkip("需隔离 dev-fixture") }
        let provider = NativeP2PDeviceProvider()
        let transport = DroppableControlTransport()
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
            transport: transport, tokenStore: EmptyTokenStore(), p2pDeviceProvider: provider)
        defer { client.logout(); provider.closeAll() }
        client.login(username: "admin", password: "admin")
        try await wait { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        let releaseMeasure = client.retainDeviceMeasure(daemonID: workspace.daemonID)
        defer { releaseMeasure() }
        try await wait { client.deviceTransports[workspace.daemonID]?.mode == "p2p" }
        let title = "native-p2p-" + UUID().uuidString
        client.createTask(workspaceID: workspace.id, title: title)
        try await wait { client.tasks.contains { $0.title == title } }
        let task = try XCTUnwrap(client.tasks.first { $0.title == title })
        do {
            client.startTask(taskID: task.id, cols: 80, rows: 24)
            try await wait { client.tasks.contains { $0.id == task.id && $0.status == .running && $0.hasSessionID } }
            let running = try XCTUnwrap(client.tasks.first { $0.id == task.id })
            var output = Data()
            let release = client.registerSessionConsumer(sessionID: running.sessionID) { bytes, replace in
                if replace { output = bytes } else { output.append(bytes) }
            }
            defer { release() }
            client.startTask(taskID: task.id, cols: 80, rows: 24)
            try await wait { client.hasSessionControl(sessionID: running.sessionID) }
            client.sendInput(sessionID: running.sessionID, "printf '%s:%s\\n' p2p native\r")
            try await wait { String(decoding: output, as: UTF8.self).contains("p2p:native") }
            let git = try await client.executeInWorkspace(workspaceID: workspace.id, command: "git", args: ["rev-parse", "--is-inside-work-tree"])
            XCTAssertEqual(git.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "true")
            XCTAssertEqual(client.deviceTransports[workspace.daemonID]?.mode, "p2p")
            // 只断客户端中心 WS，worker 的独立控制连接保持在线。
            await transport.disconnectControl()
            try await wait { client.status != .connected }
            XCTAssertTrue(client.hasSessionControl(sessionID: running.sessionID))
            client.sendInput(sessionID: running.sessionID, "printf '%s:%s\\n' grace survived\r")
            try await wait { String(decoding: output, as: UTF8.self).contains("grace:survived") }
            await transport.restoreControl()
            try await wait { client.status == .connected && client.syncState == .synced }
            XCTAssertTrue(client.hasSessionControl(sessionID: running.sessionID))
            // 主动切断实际 WebRTC peer，路由应重连 relay 并恢复相同 PTY。
            provider.closeAll()
            try await wait { client.deviceTransports[workspace.daemonID]?.mode == "relay" && client.hasSessionControl(sessionID: running.sessionID) }
            client.sendInput(sessionID: running.sessionID, "printf '%s:%s\\n' relay recovered\r")
            try await wait { String(decoding: output, as: UTF8.self).contains("relay:recovered") }
            XCTAssertTrue(String(decoding: output, as: UTF8.self).contains("p2p:native"))
            client.suspend()
            XCTAssertFalse(client.hasSessionControl(sessionID: running.sessionID))
            client.resume()
            try await wait { client.syncState == .synced }
        } catch {
            await transport.restoreControl()
            if client.status != .connected { client.resume(); try? await wait { client.status == .connected && client.syncState == .synced } }
            if let current = client.tasks.first(where: { $0.id == task.id }) { await client.closeTask(current) }
            throw error
        }
        if let current = client.tasks.first(where: { $0.id == task.id }) { await client.closeTask(current) }
        try await wait { !client.tasks.contains { $0.id == task.id } }
    }
    private func wait(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(40))
        while !predicate() {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

import CofluxClientCore
import CofluxProtocol
import Foundation
import XCTest
@testable import Coflux

@MainActor final class SwitchableLocalProvider: LocalDeviceTransportProvider {
    let native: NativeLocalDeviceProvider
    var available = false
    var rejectLeaseRequests = false
    var rejectedLeaseRequests = 0
    var connections: [any TransportConnection] = []
    var leases: [(expiresAt: Double, openedAt: Double)] = []
    func unpair(serverURL: URL, daemonID: String, grantID: String) async throws {
        let control = try await SocketTransport().connect(to: serverURL)
        do {
            var auth = Coflux_V1_ClientAuth()
            auth.username = "admin"; auth.password = "admin"; auth.clientVersion = "dev"
            var envelope = Coflux_V1_ClientToServer(); envelope.payload = .clientAuth(auth)
            try await control.send(envelope.serializedData())
            let authenticated = try Coflux_V1_ServerToClient(serializedBytes: await readControl(control))
            guard case .authOk = authenticated.payload else { throw URLError(.userAuthenticationRequired) }
            var request = Coflux_V1_LocalUnpairRequest()
            request.requestID = UUID().uuidString; request.daemonID = daemonID; request.grantID = grantID
            envelope.payload = .localUnpairRequest(request)
            try await control.send(envelope.serializedData())
            while true {
                let response = try Coflux_V1_ServerToClient(serializedBytes: await readControl(control))
                if case .localUnpairResult(let result) = response.payload, result.requestID == request.requestID {
                    guard result.ok else { throw URLError(.badServerResponse) }
                    break
                }
            }
            await control.close()
        } catch { await control.close(); throw error }
    }
    private func readControl(_ connection: any TransportConnection) async throws -> Data {
        try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask { try await connection.receive() }
            group.addTask {
                try await Task.sleep(for: .seconds(10))
                await connection.close()
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }
    func disconnect() async {
        available = false
        let previous = connections
        connections.removeAll()
        for connection in previous { await connection.close() }
    }
    init(_ native: NativeLocalDeviceProvider) { self.native = native }
    func clearGrants(accountID: String) throws { try native.clearGrants(accountID: accountID) }
    func removeGrant(daemonID: String, accountID: String) throws { try native.removeGrant(daemonID: daemonID, accountID: accountID) }
    func open(daemonID: String, accountID: String, clientInstanceID: String, generation: UInt64, elevated: Bool,
              authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload) async throws -> LocalDeviceChannel {
        guard available else { throw LocalGatewayError(message: "测试：本机通道暂不可用") }
        let channel = try await native.open(daemonID: daemonID, accountID: accountID, clientInstanceID: clientInstanceID,
                                     generation: generation, elevated: elevated, authorize: { [self] payload in
                                         if rejectLeaseRequests, case .localLeaseRequest(let request) = payload {
                                             rejectedLeaseRequests += 1
                                             var result = Coflux_V1_LocalLeaseResult()
                                             result.requestID = request.requestID; result.ok = false
                                             result.error = "测试：lease 授权服务暂不可用"
                                             return .localLeaseResult(result)
                                         }
                                         return try await authorize(payload)
                                     })
        if let expiry = channel.leaseExpiresAt { leases.append((expiry, Date().timeIntervalSince1970 * 1000)) }
        connections.append(channel.connection)
        return channel
    }
}

@MainActor final class LocalRouterIntegrationTests: XCTestCase {
    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment["COFLUX_KEYCHAIN_TESTS"] == "1" else {
            throw XCTSkip("钥匙串集成测试仅在显式设置 COFLUX_KEYCHAIN_TESTS=1 时执行")
        }
    }

    func testRelayPromotesToDirectAndSessionSurvivesControlDisconnect() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"], let url = URL(string: raw), url.host == "127.0.0.1" else { throw XCTSkip("需隔离 dev-fixture") }
        let native = NativeLocalDeviceProvider(serverURL: url, credentialNamespace: "router-test-" + UUID().uuidString)
        let provider = SwitchableLocalProvider(native)
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"), transport: SocketTransport(), tokenStore: EmptyTokenStore(), localDeviceProvider: provider)
        var account: String?
        defer { client.logout(); if let account { try? native.clearIdentityAndGrants(accountID: account) } }
        client.login(username: "admin", password: "admin")
        try await wait { client.snapshotRevision > 0 }
        account = client.accountID
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        let releaseMeasure = client.retainDeviceMeasure(daemonID: workspace.daemonID)
        defer { releaseMeasure() }
        try await wait { client.deviceTransports[workspace.daemonID]?.mode == "relay" }
        let title = "native-direct-" + UUID().uuidString
        client.createTask(workspaceID: workspace.id, title: title)
        try await wait { client.tasks.contains { $0.title == title } }
        let task = try XCTUnwrap(client.tasks.first { $0.title == title })
        client.startTask(taskID: task.id, cols: 80, rows: 24)
        try await wait { client.tasks.contains { $0.id == task.id && $0.status == .running && $0.hasSessionID } }
        let running = try XCTUnwrap(client.tasks.first { $0.id == task.id })
        var output = Data()
        let releaseConsumer = client.registerSessionConsumer(sessionID: running.sessionID) { data, replace in
            if replace { output = data } else { output.append(data) }
        }
        defer { releaseConsumer() }
        client.startTask(taskID: task.id, cols: 80, rows: 24)
        try await wait { client.hasSessionControl(sessionID: running.sessionID) }
        client.sendInput(sessionID: running.sessionID, "printf '%s:%s\\n' relay before\r")
        try await wait { String(decoding: output, as: UTF8.self).contains("relay:before") }
        provider.available = true
        try await wait { client.deviceTransports[workspace.daemonID]?.mode == "direct" && client.hasSessionControl(sessionID: running.sessionID) }
        client.sendInput(sessionID: running.sessionID, "printf '%s:%s\\n' direct after\r")
        try await wait { String(decoding: output, as: UTF8.self).contains("direct:after") }
        XCTAssertTrue(String(decoding: output, as: UTF8.self).contains("relay:before"))
        client.suspend()
        XCTAssertEqual(client.status, .disconnected)
        XCTAssertTrue(client.hasSessionControl(sessionID: running.sessionID))
        client.sendInput(sessionID: running.sessionID, "printf '%s:%s\\n' native offline\r")
        try await wait { String(decoding: output, as: UTF8.self).contains("native:offline") }
        client.resume()
        try await wait { client.status == .connected && client.syncState == .synced }
        // 在线恢复后需要新 lease 的 RPC 走原生 elevated lane。
        let result = try await client.executeInWorkspace(workspaceID: workspace.id, command: "git", args: ["rev-parse", "--is-inside-work-tree"])
        XCTAssertEqual(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "true")
        // 本机链路消失后回退 relay，保留输出并恢复控制；恢复本机能力后再次提升。
        await provider.disconnect()
        try await wait { client.deviceTransports[workspace.daemonID]?.mode == "relay" && client.hasSessionControl(sessionID: running.sessionID) }
        client.sendInput(sessionID: running.sessionID, "printf '%s:%s\\n' relay recovered\r")
        try await wait { String(decoding: output, as: UTF8.self).contains("relay:recovered") }
        XCTAssertTrue(String(decoding: output, as: UTF8.self).contains("native:offline"))
        provider.available = true
        try await wait { client.deviceTransports[workspace.daemonID]?.mode == "direct" && client.hasSessionControl(sessionID: running.sessionID) }
        await client.closeTask(running)
        try await wait { !client.tasks.contains { $0.id == task.id } }
        client.logout()
        XCTAssertFalse(client.hasSessionControl(sessionID: running.sessionID))
    }
    private func wait(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(40)
        while !predicate() {
            guard ContinuousClock.now < deadline else { XCTFail("原生路由状态未收敛"); throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}


private actor RelayRPCProbe {
    private(set) var directoryRequests = 0
    func record() { directoryRequests += 1 }
}

private struct ObservedRelayConnection: TransportConnection {
    let base: any TransportConnection
    let probe: RelayRPCProbe
    func send(_ bytes: Data) async throws {
        if let envelope = try? Coflux_V1_DeviceEnvelope(serializedBytes: bytes), case .fsList = envelope.payload {
            await probe.record()
        }
        try await base.send(bytes)
    }
    func receive() async throws -> Data { try await base.receive() }
    func close() async { await base.close() }
}

private struct ObservedRelayTransport: Transport {
    let probe: RelayRPCProbe
    func connect(to url: URL) async throws -> any TransportConnection {
        let base = try await SocketTransport().connect(to: url)
        if url.path == "/client" { return base }
        return ObservedRelayConnection(base: base, probe: probe)
    }
}

@MainActor final class EphemeralLocalRouterIntegrationTests: XCTestCase {
    func testTemporaryLeaseFailureUsesRelayAndNextRPCRecoversDirect() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.host == "127.0.0.1" else { throw XCTSkip("需隔离 dev-fixture") }
        let credentials = MemoryLocalCredentialStore()
        let native = NativeLocalDeviceProvider(serverURL: url, credentialStoreFactory: { _ in credentials })
        let provider = SwitchableLocalProvider(native)
        provider.available = true; provider.rejectLeaseRequests = true
        let probe = RelayRPCProbe()
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"), transport: ObservedRelayTransport(probe: probe), tokenStore: EmptyTokenStore(), localDeviceProvider: provider)
        defer { client.logout() }
        client.login(username: "admin", password: "admin")
        try await wait { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        let releaseMeasure = client.retainDeviceMeasure(daemonID: workspace.daemonID)
        defer { releaseMeasure() }
        func cleanup() async throws {
            if let grant = credentials.grant(daemonID: workspace.daemonID) {
                try await provider.unpair(serverURL: url, daemonID: workspace.daemonID, grantID: grant.grantID)
                credentials.removeGrant(daemonID: workspace.daemonID)
            }
        }
        do {
            try await wait { client.deviceTransports[workspace.daemonID]?.mode == "direct" }
            let fallback = try await client.listDeviceDirectory(daemonID: workspace.daemonID, path: "~")
            XCTAssertTrue(fallback.ok, fallback.error)
            XCTAssertGreaterThan(provider.rejectedLeaseRequests, 0)
            XCTAssertTrue(provider.leases.isEmpty)
            let relayed = await probe.directoryRequests
            XCTAssertGreaterThan(relayed, 0, "需要观察到目录请求实际通过 relay 发出")
            provider.rejectLeaseRequests = false
            let recovered = try await client.listDeviceDirectory(daemonID: workspace.daemonID, path: "~")
            XCTAssertTrue(recovered.ok, recovered.error)
            XCTAssertFalse(provider.leases.isEmpty)
            let afterRecovery = await probe.directoryRequests
            XCTAssertEqual(afterRecovery, relayed, "恢复后的目录 RPC 应走真实 native gateway")
            try await cleanup()
        } catch {
            do { try await cleanup() } catch { XCTFail("临时配对清理失败：\(error)") }
            throw error
        }
    }

    func testClientAutomaticallyObtainsFreshLeaseAfterExpiry() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.host == "127.0.0.1" else { throw XCTSkip("需隔离 dev-fixture") }
        let credentials = MemoryLocalCredentialStore()
        let native = NativeLocalDeviceProvider(serverURL: url, credentialStoreFactory: { _ in credentials })
        let provider = SwitchableLocalProvider(native)
        provider.available = true
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"), transport: SocketTransport(), tokenStore: EmptyTokenStore(), localDeviceProvider: provider)
        defer { client.logout() }
        client.login(username: "admin", password: "admin")
        try await wait { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        let releaseMeasure = client.retainDeviceMeasure(daemonID: workspace.daemonID)
        defer { releaseMeasure() }
        func cleanup() async throws {
            if let grant = credentials.grant(daemonID: workspace.daemonID) {
                try await provider.unpair(serverURL: url, daemonID: workspace.daemonID, grantID: grant.grantID)
                credentials.removeGrant(daemonID: workspace.daemonID)
            }
        }
        do {
            try await wait { client.deviceTransports[workspace.daemonID]?.mode == "direct" }
            let first = try await client.listDeviceDirectory(daemonID: workspace.daemonID, path: "~")
            XCTAssertTrue(first.ok, first.error)
            let initial = try XCTUnwrap(provider.leases.first)
            let remaining = initial.expiresAt - Date().timeIntervalSince1970 * 1000
            guard remaining.isFinite, remaining > 0, remaining <= 120_000 else { throw URLError(.badServerResponse) }
            print("客户端自动授权验证：首个 lease 剩余 \(Int(remaining)) ms")
            // 路由按需释放空闲 elevated lane；等待旧 lease 到期后再发新 RPC。
            while Date().timeIntervalSince1970 * 1000 <= initial.expiresAt + 250 {
                try await Task.sleep(for: .milliseconds(250))
            }
            let response = try await client.listDeviceDirectory(daemonID: workspace.daemonID, path: "~")
            XCTAssertTrue(response.ok, response.error)
            XCTAssertEqual(client.deviceTransports[workspace.daemonID]?.mode, "direct")
            XCTAssertEqual(provider.leases.count, 2)
            let replacement = try XCTUnwrap(provider.leases.last)
            XCTAssertGreaterThan(replacement.expiresAt, initial.expiresAt)
            XCTAssertGreaterThan(replacement.openedAt, initial.expiresAt)
            print("客户端自动授权验证：旧 lease 到期后取得新授权，两次目录 RPC 均成功")
            try await cleanup()
        } catch {
            do { try await cleanup() } catch { XCTFail("临时配对清理失败：\(error)") }
            throw error
        }
    }

    private func wait(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(40)
        while !condition() {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

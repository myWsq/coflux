import CofluxProtocol
import Foundation
import Testing
@testable import CofluxClientCore

@MainActor private final class StopProbeProvider: LocalDeviceTransportProvider {
    var opened: [(FakeConnection, String)] = []
    func clearGrants(accountID: String) throws {}
    func removeGrant(daemonID: String, accountID: String) throws {}
    func open(daemonID: String, accountID: String, clientInstanceID: String, generation: UInt64, elevated: Bool,
              authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload) async throws -> LocalDeviceChannel {
        let connection = FakeConnection(), channelID = UUID().uuidString
        opened.append((connection, channelID))
        return LocalDeviceChannel(connection: connection, channelID: channelID, scopes: [.sessionRead, .sessionControl])
    }
}

@MainActor struct TaskRemovalTests {
    @Test(arguments: ["rejected", "same-account", "other-account"])
    func stopResponseRespectsLoginBoundary(scenario: String) async throws {
        let transport = FakeTransport(), provider = StopProbeProvider()
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://fake.test/client")!, buildID: "dev"),
                                  transport: transport, tokenStore: InMemoryTokenStore(value: "token"), localDeviceProvider: provider)
        defer { client.logout() }
        let control = await transport.nextConnection()
        var auth = Coflux_V1_AuthOk(); auth.controlProtocolVersion = 2; auth.accountID = "account"
        control.push(.authOk(auth))
        #expect(await waitUntil { client.authState == .authed })
        var task = Coflux_V1_Task(); task.id = "task"; task.daemonID = "device"; task.status = .running; task.sessionID = "session"
        var snapshot = Coflux_V1_StateSnapshot(); snapshot.tasks = [task]
        control.push(.stateSnapshot(snapshot))
        #expect(await waitUntil { client.tasks.count == 1 })
        let close = Task { await client.closeTask(task) }
        #expect(await waitUntil { !provider.opened.isEmpty })
        let (device, channelID) = try #require(provider.opened.first)
        func frames() -> [Coflux_V1_DeviceEnvelope] {
            device.sent.compactMap { try? Coflux_V1_DeviceEnvelope(serializedBytes: $0) }
        }
        func push(_ payload: Coflux_V1_DeviceEnvelope.OneOf_Payload) throws {
            var frame = Coflux_V1_DeviceEnvelope(); frame.protocolVersion = DeviceProtocol.version
            frame.channelID = channelID; frame.payload = payload
            device.pushRaw(try frame.serializedBytes())
        }
        #expect(await waitUntil { frames().contains { if case .sessionAttach = $0.payload { return true }; return false } })
        let attach = try #require(frames().compactMap { frame -> Coflux_V1_DeviceSessionAttach? in
            if case .sessionAttach(let value) = frame.payload { return value }; return nil
        }.last)
        var attached = Coflux_V1_DeviceSessionAttached(); attached.requestID = attach.requestID
        attached.sessionID = task.sessionID; attached.holderEpoch = 1; attached.snapshotSeq = 1
        attached.ansiSnapshot = Data("snapshot".utf8); attached.cols = 80; attached.rows = 24
        try push(.sessionAttached(attached))
        #expect(await waitUntil { frames().contains { if case .sessionStop = $0.payload { return true }; return false } })
        let stop = try #require(frames().compactMap { frame -> Coflux_V1_DeviceSessionStop? in
            if case .sessionStop(let value) = frame.payload { return value }; return nil
        }.last)
        var ack = Coflux_V1_DeviceOperationAck(); ack.requestID = stop.requestID; ack.operationID = stop.operationID
        if scenario != "rejected" {
            // sessionStop 已发到设备；设备可以已经停止，但成功响应晚于本地登出。
            client.logout()
            client.login(username: "next", password: "test")
            let next = await transport.nextConnection()
            var nextAuth = auth
            nextAuth.clientToken = "new-login-token"
            if scenario == "other-account" { nextAuth.accountID = "other" }
            next.push(.authOk(nextAuth))
            #expect(await waitUntil { client.authState == .authed && client.accountID == nextAuth.accountID })
            next.push(.stateSnapshot(snapshot))
            #expect(await waitUntil { client.tasks.first?.id == task.id })
            client.reportLocalError("新登录的错误")
            ack.ok = true
            try push(.operationAck(ack))
            await close.value
            // 等待串行发送队列，不能只检查当前瞬间尚未发送。
            try await Task.sleep(for: .milliseconds(30))
            #expect(client.lastError?.message == "新登录的错误")
            #expect(client.tasks.first?.id == task.id)
            #expect(!next.sent.contains { if case .taskRemove? = decodeClientFrame($0) { return true }; return false })
            client.suspend(); client.resume()
            let reconnected = await transport.nextConnection()
            reconnected.push(.authOk(nextAuth))
            #expect(await waitUntil { reconnected.sent.count >= 2 })
            try await Task.sleep(for: .milliseconds(30))
            #expect(!reconnected.sent.contains { if case .taskRemove? = decodeClientFrame($0) { return true }; return false })
            return
        }
        ack.ok = false; ack.error = "测试：设备拒绝停止"
        try push(.operationAck(ack))
        await close.value
        #expect(client.lastError?.message == "测试：设备拒绝停止")
        #expect(client.tasks.first?.status == .running)
        #expect(!control.sent.contains { if case .taskRemove? = decodeClientFrame($0) { return true }; return false })
        client.suspend(); client.resume()
        let reconnected = await transport.nextConnection()
        reconnected.push(.authOk(auth))
        #expect(await waitUntil { reconnected.sent.count >= 2 })
        // 给串行发送队列处理完订阅后的工作，验证没有补发失败停止的目录删除。
        try await Task.sleep(for: .milliseconds(30))
        #expect(!reconnected.sent.contains { if case .taskRemove? = decodeClientFrame($0) { return true }; return false })
        #expect(client.tasks.first?.id == task.id)
    }
}

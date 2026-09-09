import CofluxClientCore
import CofluxProtocol
import CryptoKit
import XCTest
@testable import Coflux

final class LocalGatewayTests: XCTestCase {
    func testGatewayIdentityRejectsWrongOriginDeviceKeyAndTampering() throws {
        let gatewayKey = P256.Signing.PrivateKey()
        var gateway = Coflux_V1_LocalGatewayDescriptor(); gateway.protocolVersion = 1; gateway.port = 12345
        gateway.publicKeySec1 = gatewayKey.publicKey.x963Representation
        let connector = LocalGatewayConnector(daemonID: "设备", origin: "https://coflux.dev", grantID: "grant", gateway: gateway, identity: P256.Signing.PrivateKey())
        var hello = Coflux_V1_LocalGatewayHello(); hello.protocolVersion = 1; hello.daemonID = "设备"; hello.origin = "https://coflux.dev"
        hello.nonce = Data(repeating: 42, count: 32); hello.gatewayPublicKeySec1 = gateway.publicKeySec1
        hello.signatureP1363 = try gatewayKey.signature(for: LocalGatewayConnector.gatewayTranscript(hello)).rawRepresentation
        XCTAssertTrue(connector.verify(hello))
        for field in 0..<5 {
            var bad = hello
            switch field {
            case 0: bad.origin = "https://other.test"
            case 1: bad.daemonID = "other"
            case 2: bad.gatewayPublicKeySec1 = P256.Signing.PrivateKey().publicKey.x963Representation
            case 3: bad.nonce[0] ^= 1
            default: bad.signatureP1363[0] ^= 1
            }
            XCTAssertFalse(connector.verify(bad))
            XCTAssertThrowsError(try connector.clientHello(bad, clientInstanceID: "client", generation: 1, leaseID: nil))
        }
        let client = try connector.clientHello(hello, clientInstanceID: "client", generation: UInt64.max, leaseID: "lease")
        XCTAssertEqual(client.signatureP1363.count, 64)
        XCTAssertEqual(client.browserPublicKeySec1.count, 65)
        XCTAssertEqual(LocalGatewayConnector.number(UInt64.max), Data(repeating: 255, count: 8))
    }

    func testRealRustGatewayAcceptsNativeSignatureAndReturnsCatalog() async throws {
        guard ProcessInfo.processInfo.environment["COFLUX_KEYCHAIN_TESTS"] == "1" else {
            throw XCTSkip("钥匙串集成测试仅在显式设置 COFLUX_KEYCHAIN_TESTS=1 时执行")
        }
        try await runRealGateway(persistIdentity: true)
    }

    func testRealRustGatewayWithMemoryOnlyIdentity() async throws {
        try await runRealGateway(persistIdentity: false)
    }

    func testRealLeaseExpiresAndFreshLeaseRestoresRPCWithoutKeychain() async throws {
        try await runRealGateway(persistIdentity: false, awaitExpiry: true)
    }

    private func runRealGateway(persistIdentity: Bool, awaitExpiry: Bool = false) async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"], let url = URL(string: raw), url.host == "127.0.0.1" else {
            throw XCTSkip("需隔离 dev-fixture")
        }
        let control = try await SocketTransport().connect(to: url)
        addTeardownBlock { await control.close() }
        func send(_ payload: Coflux_V1_ClientToServer.OneOf_Payload) async throws {
            var envelope = Coflux_V1_ClientToServer(); envelope.payload = payload
            try await control.send(envelope.serializedData())
        }
        func next() async throws -> Coflux_V1_ServerToClient.OneOf_Payload? {
            try Coflux_V1_ServerToClient(serializedBytes: await Self.read(control)).payload
        }
        var auth = Coflux_V1_ClientAuth(); auth.username = "admin"; auth.password = "admin"; auth.clientVersion = "dev"
        try await send(.clientAuth(auth))
        guard case .authOk = try await next() else { XCTFail("测试登录失败"); return }
        try await send(.clientSubscribe(Coflux_V1_ClientSubscribe()))
        var daemonID = ""
        while daemonID.isEmpty {
            if case .stateSnapshot(let snapshot) = try await next() { daemonID = snapshot.daemons.first(where: \.online)?.daemonID ?? "" }
        }
        let identityScope = "native-integration-" + UUID().uuidString
        let identityStore: LocalIdentityStore? = persistIdentity
            ? try LocalIdentityStore(serverURL: url, accountID: identityScope, origin: "https://coflux.dev") : nil
        addTeardownBlock { try identityStore?.clearIdentityAndGrants() }
        let identity: any LocalSigningIdentity = try identityStore?.identity() ?? P256.Signing.PrivateKey()
        var pair = Coflux_V1_LocalPairRequest(); pair.requestID = UUID().uuidString; pair.daemonID = daemonID
        pair.origin = "https://coflux.dev"; pair.browserPublicKeySec1 = identity.publicKeySec1
        try await send(.localPairRequest(pair))
        var result: Coflux_V1_LocalPairResult?
        while result == nil {
            if case .localPairResult(let value) = try await next(), value.requestID == pair.requestID { result = value }
        }
        let paired = try XCTUnwrap(result)
        XCTAssertTrue(paired.ok, paired.error)
        guard paired.ok else { return }
        let pairedDaemonID = daemonID
        addTeardownBlock {
            var unpair = Coflux_V1_LocalUnpairRequest(); unpair.requestID = UUID().uuidString; unpair.daemonID = pairedDaemonID; unpair.grantID = paired.grantID
            var envelope = Coflux_V1_ClientToServer(); envelope.payload = .localUnpairRequest(unpair)
            try await control.send(envelope.serializedData())
            while true {
                let response = try Coflux_V1_ServerToClient(serializedBytes: await Self.read(control))
                if case .localUnpairResult(let value) = response.payload, value.requestID == unpair.requestID {
                    XCTAssertTrue(value.ok); break
                }
            }
        }
        let connector: LocalGatewayConnector
        if let identityStore {
            try identityStore.saveGrant(daemonID: daemonID, grantID: paired.grantID, gateway: paired.gateway)
            let restoredStore = try LocalIdentityStore(serverURL: url, accountID: identityScope, origin: pair.origin)
            let restoredGrant = try XCTUnwrap(restoredStore.grant(daemonID: daemonID))
            connector = LocalGatewayConnector(daemonID: daemonID, origin: pair.origin, grantID: restoredGrant.grantID, gateway: restoredGrant.gateway, identity: try restoredStore.identity())
        } else {
            // 仅验收真实网关协议；临时密钥不创建任何钥匙串项目。
            connector = LocalGatewayConnector(daemonID: daemonID, origin: pair.origin, grantID: paired.grantID, gateway: paired.gateway, identity: identity)
        }
        let direct = try await connector.connect(transport: SocketTransport(), clientInstanceID: UUID().uuidString, generation: 1)
        addTeardownBlock { await direct.connection.close() }
        XCTAssertTrue(direct.scopes.contains(.sessionRead))
        XCTAssertFalse(direct.scopes.contains(.rpc), "未带 lease 的连接不能有 RPC 权限")
        var catalog = Coflux_V1_DeviceSessionCatalogRequest(); catalog.requestID = UUID().uuidString
        var envelope = Coflux_V1_DeviceEnvelope(); envelope.protocolVersion = 1; envelope.channelID = direct.channelID; envelope.payload = .sessionCatalogRequest(catalog)
        try await direct.connection.send(envelope.serializedData())
        let response = try Coflux_V1_DeviceEnvelope(serializedBytes: await Self.read(direct.connection))
        XCTAssertEqual(response.channelID, direct.channelID)
        guard case .sessionCatalog(let value) = response.payload else { XCTFail("直连未返回 session catalog"); return }
        XCTAssertEqual(value.requestID, catalog.requestID)
        do {
            _ = try await connector.connect(transport: SocketTransport(), clientInstanceID: UUID().uuidString, generation: 1, leaseID: "missing-lease")
            XCTFail("无效 lease 不应得到连接")
        } catch let error as LocalGatewayError { XCTAssertEqual(error.code, .leaseInvalid) }
        var leaseRequest = Coflux_V1_LocalLeaseRequest(); leaseRequest.requestID = UUID().uuidString
        leaseRequest.daemonID = daemonID; leaseRequest.grantID = paired.grantID
        try await send(.localLeaseRequest(leaseRequest))
        var lease: Coflux_V1_OnlineDeviceLease?
        while lease == nil {
            if case .localLeaseResult(let result) = try await next(), result.requestID == leaseRequest.requestID {
                XCTAssertTrue(result.ok, result.error)
                guard result.ok else { return }
                lease = result.lease
            }
        }
        let elevated = try await connector.connect(transport: SocketTransport(), clientInstanceID: UUID().uuidString, generation: 1, leaseID: try XCTUnwrap(lease).leaseID)
        addTeardownBlock { await elevated.connection.close() }
        XCTAssertTrue(elevated.scopes.contains(.rpc))
        XCTAssertTrue(elevated.scopes.contains(.lifecycle))
        if awaitExpiry {
            let issued = try XCTUnwrap(lease)
            let remaining = issued.expiresAt - Date().timeIntervalSince1970 * 1000
            guard remaining.isFinite, remaining > 0, remaining <= 120_000 else {
                throw URLError(.badServerResponse)
            }
            print("等待真实 lease 自然到期，剩余 \(Int(remaining)) ms")
            while Date().timeIntervalSince1970 * 1000 < issued.expiresAt + 250 {
                try await Task.sleep(for: .milliseconds(250))
            }
            var rpc = Coflux_V1_DeviceFsList()
            rpc.requestID = UUID().uuidString; rpc.path = "~"; rpc.browseHome = true
            var rpcEnvelope = Coflux_V1_DeviceEnvelope()
            rpcEnvelope.protocolVersion = 1; rpcEnvelope.channelID = elevated.channelID; rpcEnvelope.payload = .fsList(rpc)
            try await elevated.connection.send(rpcEnvelope.serializedData())
            let denied = try Coflux_V1_DeviceEnvelope(serializedBytes: await Self.read(elevated.connection))
            guard case .error(let error) = denied.payload else { XCTFail("到期 lease 的 RPC 应返回权限错误"); return }
            XCTAssertEqual(error.requestID, rpc.requestID)
            XCTAssertEqual(error.code, "scope_denied")
            // 原普通 session 通道仍可读取 catalog；不把高权限到期误认为全部身份失效。
            catalog.requestID = UUID().uuidString
            envelope.payload = .sessionCatalogRequest(catalog)
            try await direct.connection.send(envelope.serializedData())
            let stillAvailable = try Coflux_V1_DeviceEnvelope(serializedBytes: await Self.read(direct.connection))
            guard case .sessionCatalog(let value) = stillAvailable.payload else { XCTFail("lease 到期不应破坏普通会话查询"); return }
            XCTAssertEqual(value.requestID, catalog.requestID)
            do {
                let unexpected = try await connector.connect(transport: SocketTransport(), clientInstanceID: UUID().uuidString, generation: 2, leaseID: issued.leaseID)
                await unexpected.connection.close()
                XCTFail("过期 lease 不得重新握手成功")
            } catch let error as LocalGatewayError { XCTAssertEqual(error.code, .leaseInvalid) }
            leaseRequest.requestID = UUID().uuidString
            try await send(.localLeaseRequest(leaseRequest))
            var fresh: Coflux_V1_OnlineDeviceLease?
            while fresh == nil {
                if case .localLeaseResult(let result) = try await next(), result.requestID == leaseRequest.requestID {
                    guard result.ok else { XCTFail(result.error); return }
                    fresh = result.lease
                }
            }
            let renewed = try await connector.connect(transport: SocketTransport(), clientInstanceID: UUID().uuidString, generation: 3, leaseID: try XCTUnwrap(fresh).leaseID)
            addTeardownBlock { await renewed.connection.close() }
            rpc.requestID = UUID().uuidString
            rpcEnvelope.channelID = renewed.channelID; rpcEnvelope.payload = .fsList(rpc)
            try await renewed.connection.send(rpcEnvelope.serializedData())
            let restored = try Coflux_V1_DeviceEnvelope(serializedBytes: await Self.read(renewed.connection))
            guard case .fsListed(let result) = restored.payload else { XCTFail("新 lease 应恢复目录 RPC"); return }
            XCTAssertEqual(result.requestID, rpc.requestID)
            XCTAssertTrue(result.ok, result.error)
        }
        // 真实中心撤销本次临时配对：已有 session/elevated 连接都必须关闭，旧 grant 不可重连。
        var unpair = Coflux_V1_LocalUnpairRequest()
        unpair.requestID = UUID().uuidString; unpair.daemonID = daemonID; unpair.grantID = paired.grantID
        try await send(.localUnpairRequest(unpair))
        while true {
            if case .localUnpairResult(let result) = try await next(), result.requestID == unpair.requestID {
                XCTAssertTrue(result.ok); break
            }
        }
        for connection in [direct.connection, elevated.connection] {
            do {
                while true { _ = try await Self.read(connection) }
            } catch let error as URLError where error.code == .timedOut {
                XCTFail("撤销配对后通道未由网关主动关闭")
            } catch { /* 网关主动关闭传输，符合预期。 */ }
        }
        do {
            let unexpected = try await connector.connect(transport: SocketTransport(), clientInstanceID: UUID().uuidString, generation: 2)
            await unexpected.connection.close()
            XCTFail("已撤销 grant 不应重新认证成功")
        } catch let error as LocalGatewayError { XCTAssertEqual(error.code, .grantUnknown) }
        catch let error as URLError where error.code == .badServerResponse {
            // 最后一个允许该 Origin 的 grant 被撤销时，Rust 在 HTTP upgrade 前直接拒绝。
        }
    }
    func testCancelledHandshakeClosesPendingReceive() async throws {
        let connection = WaitingGatewayConnection()
        var gateway = Coflux_V1_LocalGatewayDescriptor(); gateway.protocolVersion = 1; gateway.port = 12345
        gateway.publicKeySec1 = P256.Signing.PrivateKey().publicKey.x963Representation
        let connector = LocalGatewayConnector(daemonID: "d", origin: "https://coflux.dev", grantID: "g", gateway: gateway, identity: P256.Signing.PrivateKey())
        let operation = Task { try await connector.connect(transport: WaitingGatewayTransport(connection: connection), clientInstanceID: "c", generation: 1) }
        let deadline = ContinuousClock.now + .seconds(1)
        while !(await connection.receiving), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        operation.cancel()
        do { _ = try await operation.value; XCTFail("取消握手不应返回连接") } catch {}
        let closed = await connection.closed
        XCTAssertTrue(closed)
    }

    private static func read(_ connection: any TransportConnection) async throws -> Data {
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

}


private struct WaitingGatewayTransport: Transport {
    let connection: WaitingGatewayConnection
    func connect(to url: URL) async throws -> any TransportConnection { connection }
}
private actor WaitingGatewayConnection: TransportConnection {
    private(set) var receiving = false
    private(set) var closed = false
    private var waiter: CheckedContinuation<Data, any Error>?
    func send(_ data: Data) async throws {}
    func receive() async throws -> Data {
        guard !closed else { throw TransportClosedError() }
        receiving = true
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func close() async {
        closed = true
        waiter?.resume(throwing: TransportClosedError()); waiter = nil
    }
}

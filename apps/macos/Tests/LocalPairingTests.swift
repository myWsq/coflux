import CofluxProtocol
import CryptoKit
import Foundation
import XCTest
@testable import Coflux

@MainActor private final class PairProbe {
    var requests: [Coflux_V1_LocalPairRequest] = []
    var replies: [CheckedContinuation<Coflux_V1_ServerToClient.OneOf_Payload, any Error>] = []
    func authorize(_ payload: Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload {
        guard case .localPairRequest(let request) = payload else { throw URLError(.badServerResponse) }
        requests.append(request)
        // 刻意允许取消后迟到的服务端响应，验证不会把已撤销配对写回 Keychain。
        return try await withCheckedThrowingContinuation { replies.append($0) }
    }
    func complete(_ index: Int, grantID: String = "grant") {
        var result = Coflux_V1_LocalPairResult()
        result.requestID = requests[index].requestID; result.ok = true; result.grantID = grantID
        var gateway = Coflux_V1_LocalGatewayDescriptor()
        gateway.protocolVersion = 1; gateway.port = 19874
        gateway.publicKeySec1 = P256.Signing.PrivateKey().publicKey.x963Representation
        result.gateway = gateway
        replies[index].resume(returning: .localPairResult(result))
    }
}

@MainActor final class LocalPairingTests: XCTestCase {
    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment["COFLUX_KEYCHAIN_TESTS"] == "1" else {
            throw XCTSkip("钥匙串集成测试仅在显式设置 COFLUX_KEYCHAIN_TESTS=1 时执行")
        }
    }

    private let url = URL(string: "ws://127.0.0.1:19873/client")!
    private func wait(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition() {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
    func testConcurrentPairingSharesOneRequestAndSingleCancellationDoesNotCancelOthers() async throws {
        let provider = NativeLocalDeviceProvider(serverURL: url, credentialNamespace: "pair-test-" + UUID().uuidString)
        defer { try? provider.clearIdentityAndGrants(accountID: "account") }
        let probe = PairProbe()
        var started = 0
        let requests = (0..<8).map { _ in Task { @MainActor in
            started += 1
            return try await provider.pairedGrant(daemonID: "daemon", accountID: "account", authorize: probe.authorize)
        } }
        try await wait { started == 8 && probe.requests.count == 1 }
        requests[0].cancel()
        do { _ = try await requests[0].value; XCTFail("取消应结束当前等待者") } catch is CancellationError {} catch { throw error }
        XCTAssertEqual(probe.requests.count, 1)
        probe.complete(0)
        for request in requests.dropFirst() { let grant = try await request.value; XCTAssertEqual(grant.grantID, "grant") }
        let cached = try await provider.pairedGrant(daemonID: "daemon", accountID: "account", authorize: probe.authorize)
        XCTAssertEqual(cached.grantID, "grant")
        XCTAssertEqual(probe.requests.count, 1)
    }
    func testAllCancelledPairingCannotSaveLateGrantAndNextAttemptIsIndependent() async throws {
        let provider = NativeLocalDeviceProvider(serverURL: url, credentialNamespace: "pair-test-" + UUID().uuidString)
        defer { try? provider.clearIdentityAndGrants(accountID: "account") }
        let probe = PairProbe()
        let first = Task { try await provider.pairedGrant(daemonID: "daemon", accountID: "account", authorize: probe.authorize) }
        try await wait { probe.requests.count == 1 }
        first.cancel()
        do { _ = try await first.value; XCTFail("取消应结束配对") } catch is CancellationError {} catch { throw error }
        let next = Task { try await provider.pairedGrant(daemonID: "daemon", accountID: "account", authorize: probe.authorize) }
        try await wait { probe.requests.count == 2 }
        probe.complete(0, grantID: "obsolete")
        probe.complete(1, grantID: "current")
        let grant = try await next.value
        XCTAssertEqual(grant.grantID, "current")
        let cached = try await provider.pairedGrant(daemonID: "daemon", accountID: "account", authorize: probe.authorize)
        XCTAssertEqual(cached.grantID, "current")
    }
    func testRevocationCancelsPendingPairingAndRejectsLatePersistence() async throws {
        let namespace = "pair-test-" + UUID().uuidString
        let provider = NativeLocalDeviceProvider(serverURL: url, credentialNamespace: namespace)
        defer { try? provider.clearIdentityAndGrants(accountID: "account") }
        let probe = PairProbe()
        let attempt = Task { try await provider.pairedGrant(daemonID: "daemon", accountID: "account", authorize: probe.authorize) }
        try await wait { probe.requests.count == 1 }
        try provider.removeGrant(daemonID: "daemon", accountID: "account")
        do { _ = try await attempt.value; XCTFail("移除设备应取消配对") } catch is CancellationError {} catch { throw error }
        probe.complete(0)
        // 下一次读取排在响应 continuation 恢复之后。
        await Task.yield()
        let store = try LocalIdentityStore(serverURL: url, accountID: namespace + ":account", origin: "https://coflux.dev")
        XCTAssertNil(try store.grant(daemonID: "daemon"))
    }
}

@MainActor final class EphemeralLocalPairingTests: XCTestCase {
    func testMemoryCredentialsSeparateAccountsAndClientScopes() throws {
        let scope = MemoryLocalCredentialScope()
        let first = try scope.store(accountID: "first")
        XCTAssertTrue(first === (try scope.store(accountID: "first")))
        let second = try scope.store(accountID: "second")
        XCTAssertNotEqual(first.identity().publicKeySec1, second.identity().publicKeySec1)
        XCTAssertNotEqual(first.identity().publicKeySec1, try MemoryLocalCredentialScope().store(accountID: "first").identity().publicKeySec1)
        XCTAssertThrowsError(try scope.store(accountID: ""))
        var invalid = Coflux_V1_LocalGatewayDescriptor()
        invalid.protocolVersion = 1; invalid.port = 12345; invalid.publicKeySec1 = Data([4, 1, 2])
        XCTAssertThrowsError(try first.saveGrant(daemonID: "daemon", grantID: "grant", gateway: invalid))
        XCTAssertNil(first.grant(daemonID: "daemon"))
    }

    func testProviderUsesInjectedCredentialsAndReusesGrant() async throws {
        let store = MemoryLocalCredentialStore()
        let identity = store.identity().publicKeySec1
        let provider = NativeLocalDeviceProvider(serverURL: URL(string: "ws://127.0.0.1:19873/client")!, credentialStoreFactory: { _ in store })
        let probe = PairProbe()
        let request = Task { try await provider.pairedGrant(daemonID: "daemon", accountID: "account", authorize: probe.authorize) }
        let deadline = ContinuousClock.now + .seconds(3)
        while probe.requests.isEmpty {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(probe.requests[0].browserPublicKeySec1, identity)
        probe.complete(0)
        let first = try await request.value
        let cached = try await provider.pairedGrant(daemonID: "daemon", accountID: "account", authorize: probe.authorize)
        XCTAssertEqual(first.grantID, cached.grantID)
        XCTAssertEqual(probe.requests.count, 1)
        try provider.removeGrant(daemonID: "daemon", accountID: "account")
        XCTAssertNil(store.grant(daemonID: "daemon"))
        XCTAssertEqual(store.identity().publicKeySec1, identity)
    }

    func testInjectedStoreFailureIsPropagatedWithoutFallback() async throws {
        struct Failure: Error {}
        let provider = NativeLocalDeviceProvider(serverURL: URL(string: "ws://127.0.0.1:19873/client")!, credentialStoreFactory: { _ in throw Failure() })
        do {
            _ = try await provider.pairedGrant(daemonID: "daemon", accountID: "account") { _ in
                XCTFail("凭据读取失败时不应继续配对")
                throw URLError(.badServerResponse)
            }
            XCTFail("应传播存储错误")
        } catch is Failure {
        } catch { XCTFail("非预期错误：\(error)") }
    }
}

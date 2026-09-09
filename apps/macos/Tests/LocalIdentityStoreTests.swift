import CofluxProtocol
import CryptoKit
import XCTest
@testable import Coflux

final class LocalIdentityStoreTests: XCTestCase {
    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment["COFLUX_KEYCHAIN_TESTS"] == "1" else {
            throw XCTSkip("钥匙串集成测试仅在显式设置 COFLUX_KEYCHAIN_TESTS=1 时执行")
        }
    }

    func testConcurrentCreationRestoresOneIdentityAndSigns() async throws {
        let url = URL(string: "ws://native-test-\(UUID().uuidString).invalid/client")!
        let store = try LocalIdentityStore(serverURL: url, accountID: "account", origin: "https://coflux.dev")
        defer { try? store.clearIdentityAndGrants() }
        let keys = try await withThrowingTaskGroup(of: Data.self) { group in
            for _ in 0..<8 { group.addTask { try store.identity().publicKeySec1 } }
            var keys: [Data] = []
            for try await key in group { keys.append(key) }
            return keys
        }
        XCTAssertEqual(Set(keys).count, 1)
        let reopened = try LocalIdentityStore(serverURL: url, accountID: "account", origin: "https://coflux.dev")
        let identity = try reopened.identity()
        XCTAssertEqual(identity.publicKeySec1, keys[0])
        let message = Data("原生持久身份".utf8)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: identity.signTranscript(message))
        XCTAssertTrue(try P256.Signing.PublicKey(x963Representation: keys[0]).isValidSignature(signature, for: message))
    }

    func testScopeIsolationGrantValidationAndClearPreservesIdentity() throws {
        let url = URL(string: "ws://native-test-\(UUID().uuidString).invalid/client")!
        let store = try LocalIdentityStore(serverURL: url, accountID: "a", origin: "https://coflux.dev")
        let otherAccount = try LocalIdentityStore(serverURL: url, accountID: "b", origin: "https://coflux.dev")
        let otherOrigin = try LocalIdentityStore(serverURL: url, accountID: "a", origin: "https://other.test")
        let otherServer = try LocalIdentityStore(serverURL: url.appendingPathComponent("other"), accountID: "a", origin: "https://coflux.dev")
        let stores = [store, otherAccount, otherOrigin, otherServer]
        defer { for item in stores { try? item.clearIdentityAndGrants() } }
        let keys = try stores.map { try $0.identity().publicKeySec1 }
        XCTAssertEqual(Set(keys).count, 4)
        var gateway = Coflux_V1_LocalGatewayDescriptor(); gateway.protocolVersion = 1; gateway.port = 12345
        gateway.publicKeySec1 = P256.Signing.PrivateKey().publicKey.x963Representation
        try store.saveGrant(daemonID: "d", grantID: "g", gateway: gateway)
        XCTAssertEqual(try store.grant(daemonID: "d")?.gateway, gateway)
        for item in stores.dropFirst() { XCTAssertNil(try item.grant(daemonID: "d")) }
        var invalid = gateway; invalid.port = 0
        XCTAssertThrowsError(try store.saveGrant(daemonID: "d", grantID: "bad", gateway: invalid))
        XCTAssertEqual(try store.grant(daemonID: "d")?.grantID, "g")
        try store.saveGrant(daemonID: "d2", grantID: "g2", gateway: gateway)
        try store.removeGrant(daemonID: "d")
        XCTAssertNil(try store.grant(daemonID: "d"))
        XCTAssertNotNil(try store.grant(daemonID: "d2"))
        try store.clearGrants()
        XCTAssertNil(try store.grant(daemonID: "d2"))
        XCTAssertEqual(try store.identity().publicKeySec1, keys[0])
    }
}

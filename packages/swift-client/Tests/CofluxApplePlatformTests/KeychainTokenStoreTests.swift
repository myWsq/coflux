import Foundation
import Security
@testable import CofluxApplePlatform
import XCTest

private final class FakeKeychainTokenBackend: KeychainTokenBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var storedData: Data?
    private var namespaces: [(service: String, account: String)] = []
    var readStatus: OSStatus?
    var addStatus: OSStatus?
    var updateStatus: OSStatus?
    var deleteStatus: OSStatus?
    private(set) var addCount = 0
    private(set) var updateCount = 0
    private(set) var deleteCount = 0

    init(data: Data? = nil) {
        storedData = data
    }

    var observedNamespaces: [(service: String, account: String)] { lock.withLock { namespaces } }

    func read(service: String, account: String) -> KeychainReadResult {
        lock.withLock {
            namespaces.append((service, account))
            if let readStatus { return KeychainReadResult(status: readStatus, data: storedData) }
            guard let storedData else { return KeychainReadResult(status: errSecItemNotFound, data: nil) }
            return KeychainReadResult(status: errSecSuccess, data: storedData)
        }
    }

    func add(service: String, account: String, data: Data) -> OSStatus {
        lock.withLock {
            namespaces.append((service, account))
            addCount += 1
            if let addStatus { return addStatus }
            guard storedData == nil else { return errSecDuplicateItem }
            storedData = data
            return errSecSuccess
        }
    }

    func update(service: String, account: String, data: Data) -> OSStatus {
        lock.withLock {
            namespaces.append((service, account))
            updateCount += 1
            if let updateStatus { return updateStatus }
            storedData = data
            return errSecSuccess
        }
    }

    func delete(service: String, account: String) -> OSStatus {
        lock.withLock {
            namespaces.append((service, account))
            deleteCount += 1
            if let deleteStatus { return deleteStatus }
            guard storedData != nil else { return errSecItemNotFound }
            storedData = nil
            return errSecSuccess
        }
    }
}

final class KeychainTokenStoreTests: XCTestCase {
    func testAddReadUpdateAndIdempotentDelete() throws {
        let backend = FakeKeychainTokenBackend()
        let store = KeychainTokenStore(service: "test.service", account: "test.account", backend: backend)

        XCTAssertNil(try store.read())
        try store.write("first-token")
        XCTAssertEqual(try store.read(), "first-token")
        try store.write("second-token")
        XCTAssertEqual(try store.read(), "second-token")
        XCTAssertEqual(backend.addCount, 2)
        XCTAssertEqual(backend.updateCount, 1)

        try store.clear()
        try store.clear()
        XCTAssertNil(try store.read())
        XCTAssertEqual(backend.deleteCount, 2)
        XCTAssertTrue(backend.observedNamespaces.allSatisfy {
            $0.service == "test.service" && $0.account == "test.account"
        })
    }

    func testReadAndDecodeFailuresAreStructured() {
        let readBackend = FakeKeychainTokenBackend()
        readBackend.readStatus = errSecAuthFailed
        let readStore = KeychainTokenStore(service: "test", account: "read", backend: readBackend)
        XCTAssertThrowsError(try readStore.read()) { error in
            XCTAssertEqual(
                error as? KeychainTokenStoreError,
                KeychainTokenStoreError(operation: "read", status: errSecAuthFailed)
            )
        }

        let decodeBackend = FakeKeychainTokenBackend(data: Data([0xFF]))
        let decodeStore = KeychainTokenStore(service: "test", account: "decode", backend: decodeBackend)
        XCTAssertThrowsError(try decodeStore.read()) { error in
            XCTAssertEqual(
                error as? KeychainTokenStoreError,
                KeychainTokenStoreError(operation: "decode", status: errSecDecode)
            )
        }
    }

    func testAddUpdateAndDeleteFailuresAreStructured() throws {
        let addBackend = FakeKeychainTokenBackend()
        addBackend.addStatus = errSecNotAvailable
        let addStore = KeychainTokenStore(service: "test", account: "add", backend: addBackend)
        XCTAssertThrowsError(try addStore.write("token")) { error in
            XCTAssertEqual(
                error as? KeychainTokenStoreError,
                KeychainTokenStoreError(operation: "write", status: errSecNotAvailable)
            )
        }

        let updateBackend = FakeKeychainTokenBackend(data: Data("old".utf8))
        updateBackend.updateStatus = errSecAuthFailed
        let updateStore = KeychainTokenStore(service: "test", account: "update", backend: updateBackend)
        XCTAssertThrowsError(try updateStore.write("new")) { error in
            XCTAssertEqual(
                error as? KeychainTokenStoreError,
                KeychainTokenStoreError(operation: "update", status: errSecAuthFailed)
            )
        }

        let deleteBackend = FakeKeychainTokenBackend(data: Data("token".utf8))
        deleteBackend.deleteStatus = errSecNotAvailable
        let deleteStore = KeychainTokenStore(service: "test", account: "delete", backend: deleteBackend)
        XCTAssertThrowsError(try deleteStore.clear()) { error in
            XCTAssertEqual(
                error as? KeychainTokenStoreError,
                KeychainTokenStoreError(operation: "clear", status: errSecNotAvailable)
            )
        }
    }

    #if os(macOS)
    func testRealSecurityBackendRoundTripUsesRandomNamespaceAndLeavesNoItem() throws {
        let nonce = UUID().uuidString
        let service = "dev.coflux.CofluxApplePlatformTests.\(nonce)"
        let account = "clientToken.\(nonce)"
        let store = KeychainTokenStore(
            service: service,
            account: account
        )
        defer {
            do {
                try store.clear()
                XCTAssertEqual(rawKeychainStatus(service: service, account: account), errSecItemNotFound)
            } catch {
                XCTFail("随机 Keychain namespace 收尾失败：\(error)")
            }
        }

        try store.clear()
        XCTAssertNil(try store.read())
        try store.write("temporary-\(nonce)")
        XCTAssertEqual(try store.read(), "temporary-\(nonce)")
        try store.write("updated-\(nonce)")
        XCTAssertEqual(try store.read(), "updated-\(nonce)")
        try store.clear()
        XCTAssertNil(try store.read())
        XCTAssertEqual(rawKeychainStatus(service: service, account: account), errSecItemNotFound)
    }

    private func rawKeychainStatus(service: String, account: String) -> OSStatus {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil)
    }
    #endif
}

import CofluxClientCore
import Foundation
import Security

public struct KeychainTokenStoreError: Error, Equatable, Sendable {
    public let operation: String
    public let status: OSStatus

    public init(operation: String, status: OSStatus) {
        self.operation = operation
        self.status = status
    }
}

struct KeychainReadResult: Sendable {
    let status: OSStatus
    let data: Data?
}

protocol KeychainTokenBackend: Sendable {
    func read(service: String, account: String) -> KeychainReadResult
    func add(service: String, account: String, data: Data) -> OSStatus
    func update(service: String, account: String, data: Data) -> OSStatus
    func delete(service: String, account: String) -> OSStatus
}

private struct SecurityKeychainTokenBackend: KeychainTokenBackend {
    private func query(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func read(service: String, account: String) -> KeychainReadResult {
        var attributes = query(service: service, account: account)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        return KeychainReadResult(status: status, data: item as? Data)
    }

    func add(service: String, account: String, data: Data) -> OSStatus {
        var attributes = query(service: service, account: account)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(service: String, account: String, data: Data) -> OSStatus {
        SecItemUpdate(
            query(service: service, account: account) as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
    }

    func delete(service: String, account: String) -> OSStatus {
        SecItemDelete(query(service: service, account: account) as CFDictionary)
    }
}

/// Apple 平台会话 token 的最小 Keychain adapter。namespace 必须由 App composition root 显式提供。
public struct KeychainTokenStore: TokenStore, Sendable {
    private let service: String
    private let account: String
    private let backend: any KeychainTokenBackend

    public init(service: String, account: String = "clientToken") {
        self.service = service
        self.account = account
        backend = SecurityKeychainTokenBackend()
    }

    init(service: String, account: String, backend: any KeychainTokenBackend) {
        self.service = service
        self.account = account
        self.backend = backend
    }

    public func read() throws -> String? {
        let result = backend.read(service: service, account: account)
        if result.status == errSecItemNotFound { return nil }
        guard result.status == errSecSuccess else {
            throw KeychainTokenStoreError(operation: "read", status: result.status)
        }
        guard let data = result.data, let token = String(data: data, encoding: .utf8) else {
            throw KeychainTokenStoreError(operation: "decode", status: errSecDecode)
        }
        return token
    }

    public func write(_ token: String) throws {
        let data = Data(token.utf8)
        let addStatus = backend.add(service: service, account: account, data: data)
        if addStatus == errSecSuccess { return }
        if addStatus == errSecDuplicateItem {
            let updateStatus = backend.update(service: service, account: account, data: data)
            guard updateStatus == errSecSuccess else {
                throw KeychainTokenStoreError(operation: "update", status: updateStatus)
            }
            return
        }
        throw KeychainTokenStoreError(operation: "write", status: addStatus)
    }

    public func clear() throws {
        let status = backend.delete(service: service, account: account)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainTokenStoreError(operation: "clear", status: status)
        }
    }
}

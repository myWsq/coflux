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

/// Apple 平台会话 token 的最小 Keychain adapter。namespace 必须由 App composition root 显式提供。
public struct KeychainTokenStore: TokenStore, Sendable {
    private let service: String
    private let account: String

    public init(service: String, account: String = "clientToken") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func read() throws -> String? {
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw KeychainTokenStoreError(operation: "read", status: status)
        }
        guard let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
            throw KeychainTokenStoreError(operation: "decode", status: errSecDecode)
        }
        return token
    }

    public func write(_ token: String) throws {
        let data = Data(token.utf8)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        if addStatus == errSecSuccess { return }
        if addStatus == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(
                query as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            guard updateStatus == errSecSuccess else {
                throw KeychainTokenStoreError(operation: "update", status: updateStatus)
            }
            return
        }
        throw KeychainTokenStoreError(operation: "write", status: addStatus)
    }

    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainTokenStoreError(operation: "clear", status: status)
        }
    }
}

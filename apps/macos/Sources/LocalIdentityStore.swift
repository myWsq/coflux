import CofluxApplePlatform
import CofluxProtocol
import CryptoKit
import Foundation
import Security

protocol LocalSigningIdentity: Sendable {
    var publicKeySec1: Data { get }
    func signTranscript(_ data: Data) throws -> Data
}
extension P256.Signing.PrivateKey: LocalSigningIdentity {
    var publicKeySec1: Data { publicKey.x963Representation }
    func signTranscript(_ data: Data) throws -> Data { try signature(for: data).rawRepresentation }
}

struct LocalIdentityStorageError: LocalizedError {
    let operation: String
    let status: OSStatus
    var errorDescription: String? { "本机直连凭据\(operation)失败（\(status)）" }
}

/// 直连协议依赖凭据能力；测试可显式提供内存存储，默认实现仍为 Keychain。
protocol LocalCredentialStore {
    func identity() throws -> any LocalSigningIdentity
    func saveGrant(daemonID: String, grantID: String, gateway: Coflux_V1_LocalGatewayDescriptor) throws
    func grant(daemonID: String) throws -> LocalIdentityStore.CachedGrant?
    func removeGrant(daemonID: String) throws
    func clearGrants() throws
    func clearIdentityAndGrants() throws
}

/// Keychain 的 service/account 唯一键裁决首次生成；不得覆盖另一进程已保存的身份。
/// 私钥只在受系统保护的 Keychain 和签名所需内存中存在，不写文件/偏好，不在失败时改用临时身份。
struct LocalIdentityStore: Sendable, LocalCredentialStore {
    private let identityService: String
    private let grantService: String
    private struct Grant: Codable {
        let daemonID: String
        let grantID: String
        let protocolVersion: UInt32
        let port: UInt32
        let gatewayKey: Data
        let identityKey: Data
    }
    struct CachedGrant {
        let daemonID: String
        let grantID: String
        let gateway: Coflux_V1_LocalGatewayDescriptor
    }

    init(serverURL: URL, accountID: String, origin: String) throws {
        guard ["ws", "wss"].contains(serverURL.scheme), serverURL.host != nil,
              serverURL.user == nil, serverURL.password == nil, serverURL.fragment == nil,
              !accountID.isEmpty, !origin.isEmpty else {
            throw LocalIdentityStorageError(operation: "命名空间校验", status: errSecParam)
        }
        let scope = LocalGatewayConnector.transcript("coflux-native-identity-v1", [Data(serverURL.absoluteString.utf8), Data(accountID.utf8), Data(origin.utf8)])
        let hash = SHA256.hash(data: scope).map { String(format: "%02x", $0) }.joined()
        identityService = "dev.coflux.desktop.local.\(hash).identity"
        grantService = "dev.coflux.desktop.local.\(hash).grants"
    }

    func identity() throws -> any LocalSigningIdentity {
        if let existing = try read(service: identityService, account: "p256") {
            return try P256.Signing.PrivateKey(rawRepresentation: existing)
        }
        let generated = P256.Signing.PrivateKey()
        var attributes = query(service: identityService, account: "p256")
        attributes[kSecValueData as String] = generated.rawRepresentation
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = KeychainAccess.perform { SecItemAdd(attributes as CFDictionary, nil) }
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw LocalIdentityStorageError(operation: "创建身份", status: status)
        }
        guard let persisted = try read(service: identityService, account: "p256") else {
            throw LocalIdentityStorageError(operation: "回读身份", status: errSecItemNotFound)
        }
        return try P256.Signing.PrivateKey(rawRepresentation: persisted)
    }

    func saveGrant(daemonID: String, grantID: String, gateway: Coflux_V1_LocalGatewayDescriptor) throws {
        guard !daemonID.isEmpty, !grantID.isEmpty, Self.validGateway(gateway) else {
            throw LocalIdentityStorageError(operation: "配对校验", status: errSecParam)
        }
        let grant = Grant(daemonID: daemonID, grantID: grantID, protocolVersion: gateway.protocolVersion,
                          port: gateway.port, gatewayKey: gateway.publicKeySec1, identityKey: try identity().publicKeySec1)
        try write(JSONEncoder().encode(grant), service: grantService, account: daemonID)
    }
    func grant(daemonID: String) throws -> CachedGrant? {
        guard let bytes = try read(service: grantService, account: daemonID) else { return nil }
        let stored = try JSONDecoder().decode(Grant.self, from: bytes)
        var gateway = Coflux_V1_LocalGatewayDescriptor()
        gateway.protocolVersion = stored.protocolVersion; gateway.port = stored.port; gateway.publicKeySec1 = stored.gatewayKey
        guard stored.daemonID == daemonID, !stored.grantID.isEmpty, Self.validGateway(gateway) else {
            throw LocalIdentityStorageError(operation: "配对解码", status: errSecDecode)
        }
        guard stored.identityKey == (try identity().publicKeySec1) else { return nil }
        return CachedGrant(daemonID: daemonID, grantID: stored.grantID, gateway: gateway)
    }
    func removeGrant(daemonID: String) throws {
        try remove(query(service: grantService, account: daemonID))
    }
    func clearGrants() throws {
        try remove(query(service: grantService))
    }
    /// 明确清除本命名空间；常规登出只调用 clearGrants，保留设备身份。
    func clearIdentityAndGrants() throws {
        try clearGrants()
        try remove(query(service: identityService))
    }

    static func validGateway(_ gateway: Coflux_V1_LocalGatewayDescriptor) -> Bool {
        gateway.protocolVersion == 1 && (1...65535).contains(gateway.port) && gateway.publicKeySec1.count == 65 &&
            gateway.publicKeySec1.first == 4 && (try? P256.Signing.PublicKey(x963Representation: gateway.publicKeySec1)) != nil
    }
    private func query(service: String, account: String? = nil) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let account { query[kSecAttrAccount as String] = account }
        return query
    }
    private func read(service: String, account: String) throws -> Data? {
        var attributes = query(service: service, account: account)
        attributes[kSecReturnData as String] = true; attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = KeychainAccess.perform { SecItemCopyMatching(attributes as CFDictionary, &value) }
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = value as? Data else { throw LocalIdentityStorageError(operation: "读取", status: status == errSecSuccess ? errSecDecode : status) }
        return bytes
    }
    private func write(_ data: Data, service: String, account: String) throws {
        let key = query(service: service, account: account)
        var attributes = key; attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = KeychainAccess.perform { SecItemAdd(attributes as CFDictionary, nil) }
        if status == errSecSuccess { return }
        guard status == errSecDuplicateItem else { throw LocalIdentityStorageError(operation: "保存配对", status: status) }
        let updated = KeychainAccess.perform { SecItemUpdate(key as CFDictionary, [kSecValueData as String: data] as CFDictionary) }
        guard updated == errSecSuccess else { throw LocalIdentityStorageError(operation: "更新配对", status: updated) }
    }
    private func remove(_ query: [String: Any]) throws {
        let status = KeychainAccess.perform { SecItemDelete(query as CFDictionary) }
        guard status == errSecSuccess || status == errSecItemNotFound else { throw LocalIdentityStorageError(operation: "清除", status: status) }
    }
}


/// 开发/性能客户端的进程内凭据，不读写 Security 存储，不在持久化失败时自动启用。
final class MemoryLocalCredentialStore: LocalCredentialStore {
    private let lock = NSLock()
    private var key = P256.Signing.PrivateKey()
    private var grants: [String: LocalIdentityStore.CachedGrant] = [:]
    func identity() -> any LocalSigningIdentity {
        lock.lock(); defer { lock.unlock() }
        return key
    }
    func saveGrant(daemonID: String, grantID: String, gateway: Coflux_V1_LocalGatewayDescriptor) throws {
        guard !daemonID.isEmpty, !grantID.isEmpty, LocalIdentityStore.validGateway(gateway) else {
            throw LocalIdentityStorageError(operation: "配对校验", status: errSecParam)
        }
        lock.lock(); defer { lock.unlock() }
        grants[daemonID] = .init(daemonID: daemonID, grantID: grantID, gateway: gateway)
    }
    func grant(daemonID: String) -> LocalIdentityStore.CachedGrant? {
        lock.lock(); defer { lock.unlock() }
        return grants[daemonID]
    }
    func removeGrant(daemonID: String) {
        lock.lock(); defer { lock.unlock() }
        grants[daemonID] = nil
    }
    func clearGrants() {
        lock.lock(); defer { lock.unlock() }
        grants.removeAll()
    }
    func clearIdentityAndGrants() {
        let replacement = P256.Signing.PrivateKey()
        lock.lock(); defer { lock.unlock() }
        grants.removeAll(); key = replacement
    }
}

/// 每个客户端（已绑定一个服务器）独立持有 scope，再按账号隔离临时身份。
@MainActor final class MemoryLocalCredentialScope {
    private var accounts: [String: MemoryLocalCredentialStore] = [:]
    func store(accountID: String) throws -> MemoryLocalCredentialStore {
        guard !accountID.isEmpty else { throw LocalIdentityStorageError(operation: "命名空间校验", status: errSecParam) }
        if let existing = accounts[accountID] { return existing }
        let created = MemoryLocalCredentialStore()
        accounts[accountID] = created
        return created
    }
}

import CryptoKit
import Foundation
import Security

enum NativeIdentityError: Error, Equatable, CustomStringConvertible {
    case keychain(operation: String, status: OSStatus)
    case corruptKey
    case invalidOrigin
    case transcriptFieldTooLarge

    var description: String {
        switch self {
        case .keychain(let operation, let status):
            return "Keychain \(operation) 失败（OSStatus=\(status)）"
        case .corruptKey:
            return "Keychain 中的 P-256 identity 无效"
        case .invalidOrigin:
            return "Origin 必须是无凭据、path、query、fragment 的 http(s) origin"
        case .transcriptFieldTooLarge:
            return "local auth transcript 字段超过 UInt32"
        }
    }
}

/// 原生客户端可导出的 P-256 signing identity。
///
/// 私钥只通过 `NativeIdentityStore` 进入 Keychain；对外只暴露 uncompressed SEC1 公钥与
/// IEEE-P1363 `r || s` 签名，线格式与 `proto/coflux/v1/device.proto` 保持一致。
struct NativeP256Identity: Sendable {
    private let signingKey: P256.Signing.PrivateKey

    init(rawPrivateKey: Data) throws {
        guard rawPrivateKey.count == 32 else { throw NativeIdentityError.corruptKey }
        do {
            signingKey = try P256.Signing.PrivateKey(rawRepresentation: rawPrivateKey)
        } catch {
            throw NativeIdentityError.corruptKey
        }
    }

    init() {
        signingKey = P256.Signing.PrivateKey()
    }

    fileprivate var rawPrivateKey: Data { signingKey.rawRepresentation }
    var publicKeySec1: Data { signingKey.publicKey.x963Representation }

    func signP1363(_ transcript: Data) throws -> Data {
        let signature = try signingKey.signature(for: transcript).rawRepresentation
        guard signature.count == 64 else { throw NativeIdentityError.corruptKey }
        return signature
    }
}

/// 单条 generic-password Keychain identity。`service` 可注入，真实 App 用 bundle-scoped
/// 固定值，interop 用每次随机值，确保不会读取或覆盖用户已有凭据。
struct NativeIdentityStore: Sendable {
    /// macOS legacy Keychain backend 的同进程并发查询/创建可能争用内部全局 mutex；先在
    /// App 进程内串行化 creation，跨 App 进程的唯一 winner 仍由 SecItemAdd 裁决。
    private static let creationLock = NSLock()

    let service: String
    let account: String

    init(
        service: String = "dev.coflux.macos.native-identity",
        account: String = "p256-signing-key"
    ) {
        self.service = service
        self.account = account
    }

    func load() throws -> NativeP256Identity? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw NativeIdentityError.keychain(operation: "读取", status: status)
        }
        guard let data = item as? Data else { throw NativeIdentityError.corruptKey }
        return try NativeP256Identity(rawPrivateKey: data)
    }

    /// `SecItemAdd` 是跨线程/跨进程的唯一 winner 裁决；首次并发创建的 loser 读取 winner，
    /// 不把两个只存在于各自进程的 identity 当作成功。
    func loadOrCreate() throws -> NativeP256Identity {
        Self.creationLock.lock()
        defer { Self.creationLock.unlock() }
        if let existing = try load() { return existing }
        let candidate = NativeP256Identity()
        var attributes = baseQuery
        attributes[kSecValueData as String] = candidate.rawPrivateKey
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess { return candidate }
        if status == errSecDuplicateItem, let winner = try load() { return winner }
        throw NativeIdentityError.keychain(operation: "创建", status: status)
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NativeIdentityError.keychain(operation: "删除", status: status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }
}

enum NativeLocalAuthWire {
    static let protocolVersion: UInt32 = 1
    private static let gatewayDomain = "coflux-local-gateway-v1"
    private static let clientDomain = "coflux-local-client-v1"

    static func gatewayTranscript(
        daemonID: String,
        origin: String,
        nonce: Data
    ) throws -> Data {
        try transcript(
            domain: gatewayDomain,
            fields: [u32(protocolVersion), Data(daemonID.utf8), Data(origin.utf8), nonce]
        )
    }

    static func clientTranscript(
        daemonID: String,
        origin: String,
        nonce: Data,
        gatewayPublicKeySec1: Data,
        grantID: String,
        browserPublicKeySec1: Data,
        clientInstanceID: String,
        transportGeneration: UInt64,
        leaseID: String?
    ) throws -> Data {
        try transcript(
            domain: clientDomain,
            fields: [
                u32(protocolVersion),
                Data(daemonID.utf8),
                Data(origin.utf8),
                nonce,
                gatewayPublicKeySec1,
                Data(grantID.utf8),
                browserPublicKeySec1,
                Data(clientInstanceID.utf8),
                u64(transportGeneration),
                Data((leaseID ?? "").utf8),
            ]
        )
    }

    static func verifyGatewaySignature(
        publicKeySec1: Data,
        signatureP1363: Data,
        transcript: Data
    ) -> Bool {
        guard publicKeySec1.count == 65,
              publicKeySec1.first == 4,
              signatureP1363.count == 64,
              let key = try? P256.Signing.PublicKey(x963Representation: publicKeySec1),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: signatureP1363)
        else { return false }
        return key.isValidSignature(signature, for: transcript)
    }

    static func webSocketRequest(url: URL, origin: String) throws -> URLRequest {
        guard let components = URLComponents(string: origin),
              let scheme = components.scheme,
              scheme == "http" || scheme == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.path.isEmpty,
              components.query == nil,
              components.fragment == nil,
              let parsed = components.url,
              let host = parsed.host,
              canonicalOrigin(scheme: scheme, host: host, port: parsed.port) == origin
        else { throw NativeIdentityError.invalidOrigin }
        var request = URLRequest(url: url)
        request.setValue(origin, forHTTPHeaderField: "Origin")
        return request
    }

    static func leaseIsValid(expiresAtMilliseconds: Double, now: Date = Date()) -> Bool {
        expiresAtMilliseconds.isFinite && expiresAtMilliseconds > now.timeIntervalSince1970 * 1_000
    }

    private static func transcript(domain: String, fields: [Data]) throws -> Data {
        var output = Data(domain.utf8)
        output.append(0)
        for field in fields {
            guard let length = UInt32(exactly: field.count) else {
                throw NativeIdentityError.transcriptFieldTooLarge
            }
            output.append(u32(length))
            output.append(field)
        }
        return output
    }

    /// 与 server 的 `new URL(origin).origin === origin` 对齐：scheme/host 小写、IDN 用
    /// punycode、默认端口省略，IPv6 host 保留方括号。
    private static func canonicalOrigin(scheme: String, host: String, port: Int?) -> String {
        let normalizedHost = host.contains(":") ? "[\(host.lowercased())]" : host.lowercased()
        let defaultPort = (scheme == "http" ? 80 : 443)
        let portSuffix = port.flatMap { $0 == defaultPort ? nil : ":\($0)" } ?? ""
        return "\(scheme)://\(normalizedHost)\(portSuffix)"
    }

    private static func u32(_ value: UInt32) -> Data {
        var bigEndian = value.bigEndian
        return withUnsafeBytes(of: &bigEndian) { Data($0) }
    }

    private static func u64(_ value: UInt64) -> Data {
        var bigEndian = value.bigEndian
        return withUnsafeBytes(of: &bigEndian) { Data($0) }
    }
}

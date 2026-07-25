import Foundation
import Security

protocol TokenStore {
    func read() -> String?
    func write(_ token: String)
    func clear()
}

/// coflux 会话 token 的 Keychain 存取（裸 Security framework，plan 044 决策：单条 token
/// 不引 keychain 库）。最朴素的 kSecClassGenericPassword 用法，不引入 access group/同步属性。
struct KeychainTokenStore: TokenStore {
    private let service = Bundle.main.bundleIdentifier ?? "dev.coflux.Coflux"
    private let account = "clientToken"

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func read() -> String? {
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(attributes as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(_ token: String) {
        let data = Data(token.utf8)
        var attributes = query
        attributes[kSecValueData as String] = data
        // 回前台自动重连可能发生在解锁后台过渡态，取 afterFirstUnlock 而非 whenUnlocked
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem {
            SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        }
    }

    func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

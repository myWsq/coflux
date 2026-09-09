import Foundation

/// Security 的 legacy Keychain 实现存在并发对象锁竞争；统一串行化本进程调用。
/// 不持锁跨 await，也不改变 Keychain 的跨进程唯一键和访问控制。
public enum KeychainAccess {
    private static let lock = NSLock()
    public static func perform<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try operation()
    }
}

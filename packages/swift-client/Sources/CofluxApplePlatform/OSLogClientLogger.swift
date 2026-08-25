import CofluxClientCore
import CryptoKit
import Foundation
import OSLog

protocol OSLogWriting: Sendable {
    func write(level: ClientLogLevel, message: String)
}

private final class SystemOSLogWriter: OSLogWriting, @unchecked Sendable {
    private let logger: Logger

    init(subsystem: String, category: String) {
        logger = Logger(subsystem: subsystem, category: category)
    }

    func write(level: ClientLogLevel, message: String) {
        switch level {
        case .debug:
            logger.debug("\(message, privacy: .public)")
        case .info:
            logger.info("\(message, privacy: .public)")
        case .notice:
            logger.notice("\(message, privacy: .public)")
        case .error:
            logger.error("\(message, privacy: .public)")
        }
    }
}

/// 把 shared core 的窄结构化事件写入统一 OSLog category；未知 metadata 会被丢弃。
public struct OSLogClientLogger: ClientLogger, Sendable {
    private let writer: any OSLogWriting

    public init(subsystem: String, category: String = "client") {
        writer = SystemOSLogWriter(subsystem: subsystem, category: category)
    }

    init(writer: any OSLogWriting) {
        self.writer = writer
    }

    public func log(_ event: ClientLogEvent) {
        writer.write(level: event.level, message: Self.sanitizedMessage(for: event))
    }

    static func sanitizedMessage(for event: ClientLogEvent) -> String {
        var fields = [
            "event.category=\(safeEventCategory(event.category))",
            "event.name=\(safeEventName(event.name))",
        ]
        for (key, value) in event.metadata.sorted(by: { $0.key < $1.key }) {
            guard let safeValue = sanitizedMetadata(key: key, value: value) else { continue }
            fields.append("\(key)=\(safeValue)")
        }
        return fields.joined(separator: " ")
    }

    private static func sanitizedMetadata(key: String, value: String) -> String? {
        switch key {
        case "generation":
            guard let number = UInt64(value) else { return "redacted" }
            return String(number)
        case "durationMs":
            guard let number = Double(value), number.isFinite, number >= 0 else { return "redacted" }
            return String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), number)
        case "status":
            let allowed = Set([
                "needLogin", "authenticating", "authed", "authFailed", "outdated",
                "connecting", "connected", "disconnected", "notSubscribed",
                "awaitingSnapshot", "synced", "open", "closed",
            ])
            return allowed.contains(value) ? value : "redacted"
        case "route":
            let allowed = Set(["control", "relay", "loopback", "p2p", "none"])
            return allowed.contains(value) ? value : "redacted"
        case "daemonID", "projectID", "workspaceID", "taskID", "sessionID", "channelID", "requestID", "grantID":
            return redactedID(value)
        default:
            return nil
        }
    }

    private static func safeEventCategory(_ value: String) -> String {
        let allowed = Set(["auth", "control", "device", "sync", "transport"])
        return allowed.contains(value) ? value : "redacted"
    }

    private static func safeEventName(_ value: String) -> String {
        let allowed = Set([
            "connection_state", "operation_duration", "route_changed", "send_failed",
            "silent_timeout", "sync_state",
        ])
        return allowed.contains(value) ? value : "redacted"
    }

    private static func redactedID(_ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        return "sha256:" + digest.prefix(6).map { String(format: "%02x", $0) }.joined()
    }
}

import CofluxClientCore
import Foundation
@testable import CofluxApplePlatform
import XCTest

private final class RecordingOSLogWriter: OSLogWriting, @unchecked Sendable {
    struct Record: Equatable {
        let level: ClientLogLevel
        let message: String
    }

    private let lock = NSLock()
    private var records: [Record] = []

    var captured: [Record] { lock.withLock { records } }

    func write(level: ClientLogLevel, message: String) {
        lock.withLock { records.append(Record(level: level, message: message)) }
    }
}

final class OSLogClientLoggerTests: XCTestCase {
    func testLoggerKeepsAllowlistedStateAndRedactsIdentifiers() {
        let writer = RecordingOSLogWriter()
        let logger = OSLogClientLogger(writer: writer)
        logger.log(ClientLogEvent(
            level: .notice,
            category: "control",
            name: "route_changed",
            metadata: [
                "status": "connected",
                "route": "relay",
                "generation": "7",
                "durationMs": "12.345",
                "daemonID": "daemon-secret-identifier",
            ]
        ))

        let record = try! XCTUnwrap(writer.captured.first)
        XCTAssertEqual(record.level, .notice)
        XCTAssertTrue(record.message.contains("event.category=control"))
        XCTAssertTrue(record.message.contains("event.name=route_changed"))
        XCTAssertTrue(record.message.contains("status=connected"))
        XCTAssertTrue(record.message.contains("route=relay"))
        XCTAssertTrue(record.message.contains("generation=7"))
        XCTAssertTrue(record.message.contains("durationMs=12.3"))
        XCTAssertTrue(record.message.contains("daemonID=sha256:"))
        XCTAssertFalse(record.message.contains("daemon-secret-identifier"))
    }

    func testLoggerDropsSensitiveAndUnknownMetadata() {
        let writer = RecordingOSLogWriter()
        let logger = OSLogClientLogger(writer: writer)
        logger.log(ClientLogEvent(
            level: .error,
            category: "ck_secret_category",
            name: "hunter2",
            metadata: [
                "token": "ck_secret_value",
                "password": "password-secret",
                "payload": "protobuf-secret",
                "terminal": "terminal-secret",
                "status": "ck_secret_value",
                "route": "https://secret.example",
            ]
        ))

        let message = try! XCTUnwrap(writer.captured.first?.message)
        XCTAssertTrue(message.contains("event.category=redacted"))
        XCTAssertTrue(message.contains("event.name=redacted"))
        XCTAssertTrue(message.contains("status=redacted"))
        XCTAssertTrue(message.contains("route=redacted"))
        for secret in [
            "ck_secret_category", "ck_secret_value", "hunter2", "password-secret",
            "protobuf-secret", "terminal-secret", "secret.example",
        ] {
            XCTAssertFalse(message.contains(secret))
        }
        XCTAssertFalse(message.contains("token="))
        XCTAssertFalse(message.contains("password="))
        XCTAssertFalse(message.contains("payload="))
        XCTAssertFalse(message.contains("terminal="))
    }
}

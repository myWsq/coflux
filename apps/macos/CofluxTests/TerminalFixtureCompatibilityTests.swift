import Foundation
import XCTest

final class TerminalFixtureCompatibilityTests: XCTestCase {
    private static let fixtureIDs = ["claude-cli", "codex-cli", "tui-vim"]

    func testRawSnapshotAndTailRemainEquivalent() throws {
        for fixtureID in Self.fixtureIDs {
            try assertFixture(fixtureID)
        }
    }

    private func assertFixture(_ fixtureID: String) throws {
        let fixtureRoot = repositoryRoot
            .appendingPathComponent("tests/fixtures/terminal", isDirectory: true)
        let fixture: TerminalFixture = try decode(
            fixtureRoot.appendingPathComponent("\(fixtureID).json")
        )

        let snapshotRoot: URL
        if let override = ProcessInfo.processInfo.environment["COFLUX_VT_SNAPSHOT_DIR"], !override.isEmpty {
            snapshotRoot = URL(fileURLWithPath: override, isDirectory: true)
        } else {
            snapshotRoot = fixtureRoot.appendingPathComponent("snapshots", isDirectory: true)
        }
        let snapshot: SessionSnapshotFixture = try decode(
            snapshotRoot.appendingPathComponent("\(fixtureID).json")
        )

        XCTAssertEqual(fixture.schemaVersion, 1, fixtureID)
        XCTAssertEqual(snapshot.schemaVersion, 1, fixtureID)
        XCTAssertEqual(snapshot.fixtureId, fixtureID)
        XCTAssertEqual(snapshot.fixtureName, fixture.name)

        let original = FixtureTerminal(cols: fixture.initial.cols, rows: fixture.initial.rows)
        for (index, stage) in fixture.stages.enumerated() {
            original.feed(try decodeBase64(stage.dataBase64, field: "stages[\(index)].dataBase64"))
            if let resize = stage.resizeAfter {
                original.resize(resize)
            }
        }

        let restored = FixtureTerminal(cols: snapshot.cols, rows: snapshot.rows)
        restored.feed(try decodeBase64(snapshot.ansiSnapshotBase64, field: "ansiSnapshotBase64"))

        try assertEquivalent(
            actual: TerminalStateCapture.capture(restored),
            expected: TerminalStateCapture.capture(original),
            label: "\(fixture.name) raw↔snapshot"
        )

        let tail = try decodeBase64(fixture.tailBase64, field: "tailBase64")
        original.feed(tail)
        restored.feed(tail)
        try assertEquivalent(
            actual: TerminalStateCapture.capture(restored),
            expected: TerminalStateCapture.capture(original),
            label: "\(fixture.name) snapshot+tail"
        )
    }

    private func assertEquivalent(actual: TerminalState, expected: TerminalState, label: String) throws {
        if let difference = actual.firstDifference(from: expected) {
            XCTFail("\(label) 不等价：\(difference)")
        }
    }

    private func decode<Value: Decodable>(_ url: URL) throws -> Value {
        try JSONDecoder().decode(Value.self, from: Data(contentsOf: url))
    }

    private var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // CofluxTests
            .deletingLastPathComponent() // macos
            .deletingLastPathComponent() // apps
            .deletingLastPathComponent() // repository root
    }
}

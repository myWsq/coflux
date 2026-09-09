import XCTest
import CofluxProtocol
@testable import Coflux

final class BranchChoicesTests: XCTestCase {
    func testFailedBranchListingNeverBecomesSuccessfulEmptyList() throws {
        var result = Coflux_V1_ExecResult()
        result.ok = false
        result.exitCode = 128
        result.error = " \n"
        result.stderr = "\t"
        XCTAssertThrowsError(try BranchChoices.loadedBranches(result)) { error in
            XCTAssertEqual(error.localizedDescription, "获取分支列表失败（git 退出码 128）")
        }
        result.stderr = " fatal: not a git repository\n"
        XCTAssertThrowsError(try BranchChoices.loadedBranches(result)) { error in
            XCTAssertEqual(error.localizedDescription, "fatal: not a git repository")
        }
        result.ok = true
        XCTAssertThrowsError(try BranchChoices.loadedBranches(result))
        result.exitCode = 0
        XCTAssertEqual(try BranchChoices.loadedBranches(result), [])
        result.stdout = "main\nfeature/中文\n"
        XCTAssertEqual(try BranchChoices.loadedBranches(result), ["main", "feature/中文"])
    }

    func testTrimmedCreateFirstAndExactExistingMatch() {
        let rows = BranchChoices.entries(query: "  feature  ", branches: ["feature-old"], taken: [], current: nil, loaded: true)
        XCTAssertEqual(rows.map(\.name), ["feature", "feature-old"])
        XCTAssertTrue(rows[0].createNew)
        let exact = BranchChoices.entries(query: " main\n", branches: ["main"], taken: ["main"], current: "main", loaded: true)
        XCTAssertEqual(exact.count, 1)
        XCTAssertFalse(exact[0].createNew)
        XCTAssertTrue(exact[0].current)
        XCTAssertTrue(exact[0].actionable)
    }
    func testKeyboardSkipsOccupiedBranchesAndStopsAtEdges() {
        let rows = BranchChoices.entries(query: "", branches: ["a", "b", "c"], taken: ["b"], current: nil, loaded: true)
        XCTAssertEqual(BranchChoices.move(0, delta: 1, entries: rows), 2)
        XCTAssertEqual(BranchChoices.move(2, delta: -1, entries: rows), 0)
        XCTAssertEqual(BranchChoices.move(2, delta: 1, entries: rows), 2)
        XCTAssertEqual(BranchChoices.move(0, delta: -1, entries: rows), 0)
        XCTAssertTrue(BranchChoices.entries(query: "new", branches: [], taken: [], current: nil, loaded: false).isEmpty)
    }
    func testRemoteBreadcrumbsDoNotConsultLocalFilesystem() {
        let rows = RemotePath.breadcrumbs("/remote/中文 folder/project")
        XCTAssertEqual(rows.map(\.path), ["/", "/remote", "/remote/中文 folder", "/remote/中文 folder/project"])
        XCTAssertEqual(RemotePath.parent("/remote"), "/")
        XCTAssertNil(RemotePath.parent("/"))
        XCTAssertTrue(RemotePath.breadcrumbs("relative").isEmpty)
    }
}

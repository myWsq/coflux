import XCTest
@testable import Coflux

@MainActor final class UntrackedDiffLoaderTests: XCTestCase {
    func testBoundedConcurrencyPreservesPathAndOrder() async throws {
        let paths = (0..<19).map { "\($0)-文件 😀\n.txt" }
        var active = 0
        var peak = 0
        var calls: [[String]] = []
        let result = try await UntrackedDiffLoader.load(paths: paths) { args in
            active += 1; peak = max(peak, active); calls.append(args)
            defer { active -= 1 }
            let path = args.last!
            let index = paths.firstIndex(of: path)!
            // 故意逆序完成每批，输出仍应按 paths 排列。
            try await Task.sleep(for: .milliseconds((8 - index % 8) * 5))
            return "[\(index)]"
        }
        XCTAssertEqual(peak, 8)
        XCTAssertEqual(active, 0)
        XCTAssertEqual(calls.count, 19)
        XCTAssertTrue(calls.allSatisfy { Array($0.dropLast()) == ["-c", "core.quotepath=false", "diff", "--no-index", "--", "/dev/null"] })
        XCTAssertEqual(result, (0..<19).map { "[\($0)]" }.joined())
    }

    func testVanishedFileDoesNotHideOtherDiffs() async throws {
        let result = try await UntrackedDiffLoader.load(paths: ["before", "gone", "after"]) { args in
            if args.last == "gone" { throw CocoaError(.fileReadNoSuchFile) }
            return args.last!
        }
        XCTAssertEqual(result, "beforeafter")
    }

    func testCancellationDoesNotStartNextBatch() async throws {
        var calls = 0
        let task = Task {
            try await UntrackedDiffLoader.load(paths: (0..<24).map(String.init)) { _ in
                calls += 1
                try await Task.sleep(for: .seconds(5))
                return "unexpected"
            }
        }
        while calls < 8 { await Task.yield() }
        task.cancel()
        do { _ = try await task.value; XCTFail("取消不能发布残缺 diff") } catch is CancellationError {} catch { XCTFail("意外错误：\(error)") }
        XCTAssertEqual(calls, 8)
    }
}

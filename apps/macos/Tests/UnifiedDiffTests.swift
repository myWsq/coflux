import XCTest
@testable import Coflux

final class UnifiedDiffTests: XCTestCase {
    func testRealGitCRLFContentKeepsDistinctCodeRows() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("coflux-crlf-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("windows.txt")
        try Data("first 中文😀\r\n\r\nthird\r\n".utf8).write(to: source)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.currentDirectoryURL = root
        process.arguments = ["-c", "core.autocrlf=false", "diff", "--no-index", "--", "/dev/null", source.path]
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 1)
        let raw = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(raw.contains("+first 中文😀\r\n+\r\n+third\r\n"))
        let file = try XCTUnwrap(UnifiedDiff.parse(raw).first)
        let code = file.lines.filter { $0.kind == "+" }
        XCTAssertEqual(code.map(\.text), ["first 中文😀", "", "third"])
        XCTAssertEqual(code.map(\.new), [1, 2, 3])
        XCTAssertEqual(file.additions, 3)
    }

    func testParsingStopsAtCancellationCheckpoint() {
        let raw = "diff --git a/test b/test\n--- a/test\n+++ b/test\n@@ -0,0 +1,5000 @@\n" + String(repeating: "+value\n", count: 5000)
        var checkpoints = 0
        XCTAssertThrowsError(try UnifiedDiff.parse(raw) {
            checkpoints += 1
            if checkpoints == 32 { throw CancellationError() }
        }) { XCTAssertTrue($0 is CancellationError) }
        XCTAssertEqual(checkpoints, 32, "取消后不能继续遍历剩余差异行")
    }

    func testVisibleRowsRemainBoundedAcrossLargeDiffAndHunkBoundaries() {
        let lines = (0..<5000).map { index in
            DiffLine(id: index, text: "row", kind: index.isMultiple(of: 100) ? "@" : "+", old: nil, new: index)
        }
        let layout = DiffRowLayout(lines: lines)
        XCTAssertEqual(layout.height, 100075) // 50 × 21.5pt 标题 + 4950 × 20pt 代码行
        for top in stride(from: 0, through: 100000, by: 200) {
            let visible = layout.visibleRange(top: CGFloat(top), height: 700)
            XCTAssertLessThanOrEqual(visible.count, 47)
            XCTAssertLessThanOrEqual(layout.offsets[visible.lowerBound], CGFloat(top))
            XCTAssertGreaterThanOrEqual(layout.offsets[visible.upperBound], min(layout.height, CGFloat(top + 700)))
        }
        XCTAssertEqual(layout.visibleRange(top: layout.height + 1000, height: 700), 5000..<5000)
        XCTAssertEqual(DiffRowLayout(lines: []).visibleRange(top: 0, height: 700), 0..<0)
    }

    func testMultipleHunksPreserveLineNumbersAndNewFileContent() {
        let files = UnifiedDiff.parse("""
        diff --git a/example.txt b/example.txt
        --- a/example.txt
        +++ b/example.txt
        @@ -2,2 +2,2 @@
         context
        -old
        +new
        @@ -20,1 +20,2 @@
         retained
        +added
        diff --git a/new file.txt b/new file.txt
        new file mode 100644
        --- /dev/null
        +++ b/new file.txt
        @@ -0,0 +1,1 @@
        +hello
        """)
        XCTAssertEqual(files.map(\.path), ["example.txt", "new file.txt"])
        XCTAssertEqual(files[0].additions, 2)
        XCTAssertEqual(files[0].deletions, 1)
        XCTAssertEqual(files[0].lines.last?.new, 21)
        XCTAssertNil(files[0].lines.last?.old)
        XCTAssertEqual(files[1].lines.last?.text, "hello")
        XCTAssertEqual(files[1].lines.last?.new, 1)
    }
    func testRealGitQuotedPathsRenamesBinaryAndHeaderLikeContent() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("coflux-diff-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        func git(_ args: [String]) throws -> String {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.currentDirectoryURL = root
            process.arguments = ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Diff Test", "-c", "user.email=diff@example.invalid"] + args
            let pipe = Pipe(); process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0)
            return String(decoding: data, as: UTF8.self)
        }
        func write(_ name: String, _ bytes: Data) throws {
            let url = root.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try bytes.write(to: url)
        }
        _ = try git(["init", "--initial-branch=main"])
        let special = "中文\n文件\t.txt"
        let deleted = "deleted \"quoted\".txt"
        let binary = "folder b/item.bin"
        try write(special, Data("-- a/not-a-header\n".utf8))
        try write(deleted, Data("deleted\n".utf8))
        try write(binary, Data([0, 1, 2]))
        try write("original.txt", Data("unchanged rename content\n".utf8))
        _ = try git(["add", "."])
        _ = try git(["commit", "-m", "初始测试数据"])
        try write(special, Data("++ b/not-a-header\n".utf8))
        try FileManager.default.removeItem(at: root.appendingPathComponent(deleted))
        try FileManager.default.moveItem(at: root.appendingPathComponent("original.txt"), to: root.appendingPathComponent("renamed \"file\".txt"))
        try write(binary, Data([0, 3, 4]))
        _ = try git(["add", "-A"])
        // 同时验 Git 默认的八进制 UTF-8 转义与 Web 使用的 core.quotepath=false。
        for quoting in ["true", "false"] {
            let diff = try git(["-c", "core.quotepath=" + quoting, "diff", "--find-renames", "HEAD"])
            let files = UnifiedDiff.parse(diff)
            XCTAssertEqual(Set(files.map(\.path)), Set([special, deleted, binary, "renamed \"file\".txt"]))
            let changed = try XCTUnwrap(files.first { $0.path == special })
            XCTAssertEqual(changed.additions, 1)
            XCTAssertEqual(changed.deletions, 1)
            XCTAssertEqual(changed.lines.last?.text, "++ b/not-a-header")
            XCTAssertEqual(files.first { $0.path == deleted }?.status, "deleted")
            XCTAssertEqual(files.first { $0.path == binary }?.binary, true)
            let renamed = try XCTUnwrap(files.first { $0.renamedFrom == "original.txt" })
            XCTAssertEqual(renamed.status, "renamed")
            XCTAssertTrue(renamed.lines.isEmpty)
        }
    }
}

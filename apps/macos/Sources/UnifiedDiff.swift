import Foundation

struct DiffLine: Identifiable, Sendable, Equatable {
    let id: Int
    let text: String
    let kind: Character
    let old: Int?
    let new: Int?
}
struct DiffFile: Identifiable, Sendable, Equatable {
    var id: String { path }
    var path: String
    var renamedFrom: String?
    var status = "modified"
    var binary = false
    var lines: [DiffLine] = []
    var additions: Int { lines.filter { $0.kind == "+" }.count }
    var deletions: Int { lines.filter { $0.kind == "-" }.count }
}

enum UnifiedDiff {
    /// Git 的 C 风格引用使用 UTF-8 字节的八进制转义，不能逐 Unicode 字符解码。
    private static func quotedPath(_ raw: String) -> (path: String, consumed: Int)? {
        let bytes = Array(raw.utf8)
        guard bytes.first == 34 else { return nil }
        var output: [UInt8] = [], i = 1
        let escapes: [UInt8: UInt8] = [97: 7, 98: 8, 116: 9, 110: 10, 118: 11, 102: 12, 114: 13, 92: 92, 34: 34]
        while i < bytes.count {
            let byte = bytes[i]; i += 1
            if byte == 34 { return (String(decoding: output, as: UTF8.self), i) }
            if byte != 92 { output.append(byte); continue }
            guard i < bytes.count else { return nil }
            let escaped = bytes[i]; i += 1
            if (48...55).contains(escaped) {
                var value = Int(escaped - 48), count = 1
                while count < 3 && i < bytes.count && (48...55).contains(bytes[i]) {
                    value = value * 8 + Int(bytes[i] - 48); i += 1; count += 1
                }
                guard value <= 255 else { return nil }
                output.append(UInt8(value))
            } else if let value = escapes[escaped] { output.append(value) }
            else { output.append(escaped) }
        }
        return nil
    }
    private static func path(_ raw: String, stripPrefix: Bool = false) -> String {
        let decoded = quotedPath(raw)?.path ?? String(raw.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)[0])
        if stripPrefix && (decoded.hasPrefix("a/") || decoded.hasPrefix("b/")) { return String(decoded.dropFirst(2)) }
        return decoded
    }
    private static func headerPath(_ header: String) -> String {
        let raw = String(header.dropFirst("diff --git ".count))
        if let first = quotedPath(raw) {
            let rest = String(decoding: Array(raw.utf8).dropFirst(first.consumed + 1), as: UTF8.self)
            return path(rest, stripPrefix: true)
        }
        // 无正文的 mode/binary diff 只能依赖文件头；同名路径中也可能包含字面量 " b/"。
        var range = raw.startIndex..<raw.endIndex
        var fallback = ""
        while let delimiter = raw.range(of: " b/", range: range) {
            let old = String(raw[..<delimiter.lowerBound].dropFirst(2))
            let new = String(raw[delimiter.upperBound...])
            if old == new { return new }
            fallback = new
            range = delimiter.upperBound..<raw.endIndex
        }
        if let delimiter = raw.range(of: " \"b/") { return path(String(raw[raw.index(after: delimiter.lowerBound)...]), stripPrefix: true) }
        return fallback
    }

    static func parse(_ text: String) -> [DiffFile] {
        parse(text, checkCancellation: {})
    }

    static func parse(_ text: String, checkCancellation: () throws -> Void) rethrows -> [DiffFile] {
        try checkCancellation()
        let hunk = try! NSRegularExpression(pattern: #"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#)
        var files: [DiffFile] = [], file: DiffFile?
        var old = 0, new = 0
        var inHunk = false
        // Swift Character 将 CRLF 视为一个字素；按 LF 标量拆分才能正确处理 Git 的混合换行。
        for raw in text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false) {
            try checkCancellation()
            var line = String(raw)
            // 文档按逻辑代码行显示，CRLF 的 CR 不再成为 TextKit 中额外的换行。
            if line.hasSuffix("\r") { line.removeLast() }
            if line.hasPrefix("diff --git ") {
                if let file { files.append(file) }
                file = DiffFile(path: headerPath(line)); inHunk = false
            } else if let match = hunk.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) {
                old = Int((line as NSString).substring(with: match.range(at: 1))) ?? 0
                new = Int((line as NSString).substring(with: match.range(at: 2))) ?? 0
                let id = file?.lines.count ?? 0
                file?.lines.append(DiffLine(id: id, text: line, kind: "@", old: nil, new: nil))
                inHunk = true
            } else if inHunk {
                // 正文里的 +++/--- 是增删内容，不是文件名头。
                guard let kind = line.first, ["+", "-", " ", "\\"].contains(kind) else { continue }
                let id = file?.lines.count ?? 0
                file?.lines.append(DiffLine(id: id, text: String(line.dropFirst()), kind: kind,
                    old: kind == "+" || kind == "\\" ? nil : old, new: kind == "-" || kind == "\\" ? nil : new))
                if kind == "-" || kind == " " { old += 1 }
                if kind == "+" || kind == " " { new += 1 }
            } else if line.hasPrefix("--- ") {
                let value = path(String(line.dropFirst(4)), stripPrefix: true)
                if value != "/dev/null" { file?.path = value }
            } else if line.hasPrefix("+++ ") {
                let value = path(String(line.dropFirst(4)), stripPrefix: true)
                if value != "/dev/null" { file?.path = value }
            } else if line.hasPrefix("rename from ") {
                file?.renamedFrom = path(String(line.dropFirst(12))); file?.status = "renamed"
            } else if line.hasPrefix("rename to ") {
                file?.path = path(String(line.dropFirst(10)))
            } else if line.hasPrefix("new file mode ") { file?.status = "added"
            } else if line.hasPrefix("deleted file mode ") { file?.status = "deleted"
            } else if line.hasPrefix("Binary files ") || line == "GIT binary patch" { file?.binary = true }
        }
        if let file { files.append(file) }
        return files
    }
}

import Foundation
import SwiftTreeSitter
import TreeSitterJavaScript
import TreeSitterTypeScript
import TreeSitterTSX
import TreeSitterRust
import TreeSitterPython
import TreeSitterGo
import TreeSitterJSON
import TreeSitterBash
import TreeSitterC
import TreeSitterR
import TreeSitterDart
import TreeSitterIni
import TreeSitterSql
import TreeSitterProto
import TreeSitterJSON5
import TreeSitterGraphQL
import TreeSitterGroovy
import TreeSitterZsh
import TreeSitterPerl
import TreeSitterPowershell
import TreeSitterVue
import TreeSitterSvelte
import TreeSitterLess
import TreeSitterSCSS
import TreeSitterCSS
import TreeSitterHTML
import TreeSitterXML
import TreeSitterPHP
import TreeSitterCPP
import TreeSitterJava
import TreeSitterErlang
import TreeSitterHaskell
import TreeSitterElixir
import TreeSitterKotlin
import TreeSitterYAML
import TreeSitterTOML
import TreeSitterSwift
import TreeSitterRuby
import TreeSitterCSharp
import TreeSitterDockerfile
import TreeSitterMake
import TreeSitterLua
import TreeSitterMarkdown
import TreeSitterMarkdownInline

struct SyntaxSpan: Sendable {
    let range: NSRange
    let color: UInt32
}

/// Tree-sitter C 解析器 + Swift 查询 API。actor 在后台隔离解析器与缓存，不执行源文件代码。
actor NativeDiffHighlighter {
    static let shared = NativeDiffHighlighter()
    private let parseTimeSlice: TimeInterval
    private(set) var parseYieldCount = 0
    private(set) var queryYieldCount = 0
    init(parseTimeSlice: TimeInterval = 0.02) {
        precondition(parseTimeSlice > 0 && parseTimeSlice.isFinite)
        self.parseTimeSlice = parseTimeSlice
    }
    private var configurations: [String: (Language, Query)] = [:]

    /// 分开解析旧版和新版；不把 diff 中相邻的删除/新增行当成同一份源文件。
    /// 不连续 hunk 单独处理，缺失的源文件上下文不能由上一段语法状态冒充。
    func highlight(_ file: DiffFile) async throws -> [Int: [SyntaxSpan]] {
        var result: [Int: [SyntaxSpan]] = [:]
        var hunk: [DiffLine] = []
        // 以 inout 传入而不是捕获：Swift 6 区域隔离检查把「actor 方法里的本地函数捕获可变局部变量」判为跨隔离共享。
        func flush(hunk: inout [DiffLine], result: inout [Int: [SyntaxSpan]]) async throws {
            guard !hunk.isEmpty else { return }
            for old in [true, false] {
                let lines = hunk.filter { $0.kind == " " || $0.kind == (old ? "-" : "+") }
                guard !lines.isEmpty, !old || lines.contains(where: { $0.kind == "-" }) else { continue }
                let source = lines.map(\.text).joined(separator: "\n")
                let spans = try await highlight(source, path: old ? (file.renamedFrom ?? file.path) : file.path)
                let ordered = spans.enumerated().sorted { $0.element.range.location < $1.element.range.location }
                var offset = 0, cursor = 0
                var overlaps: [(offset: Int, element: SyntaxSpan)] = []
                for (index, line) in lines.enumerated() {
                    if index % 128 == 0 { await Task.yield() }
                    try Task.checkCancellation()
                    let row = NSRange(location: offset, length: line.text.utf16.count)
                    overlaps.removeAll { NSMaxRange($0.element.range) <= offset }
                    while cursor < ordered.count && ordered[cursor].element.range.location < NSMaxRange(row) {
                        overlaps.append(ordered[cursor]); cursor += 1
                    }
                    if !old || line.kind == "-" {
                        result[line.id] = overlaps.sorted { $0.offset < $1.offset }.compactMap { item in
                            let range = NSIntersectionRange(row, item.element.range)
                            guard range.length > 0 else { return nil }
                            return SyntaxSpan(range: NSRange(location: range.location - offset, length: range.length), color: item.element.color)
                        }
                    }
                    offset += row.length + 1
                }
            }
            hunk.removeAll(keepingCapacity: true)
        }
        for (index, line) in file.lines.enumerated() {
            if index % 256 == 0 { await Task.yield(); try Task.checkCancellation() }
            if line.kind == "@" { try await flush(hunk: &hunk, result: &result) }
            else if ["+", "-", " "].contains(line.kind) { hunk.append(line) }
        }
        try await flush(hunk: &hunk, result: &result)
        return result
    }

    func highlight(_ text: String, path: String) async throws -> [SyntaxSpan] {
        try Task.checkCancellation()
        let basename = (path as NSString).lastPathComponent.lowercased()
        if ["dockerfile", "makefile"].contains(basename) {
            return try await highlight(text, languageKey: basename)
        }
        let ext = (path as NSString).pathExtension.lowercased()
        let key: String
        switch ext {
        case "js", "mjs", "cjs", "jsx": key = "jsx"
        case "ts", "mts", "cts": key = "typescript"
        case "tsx": key = "tsx"
        case "rs": key = "rust"
        case "py", "pyi", "pyw": key = "python"
        case "go": key = "go"
        case "dart": key = "dart"
        case "r": key = "r"
        case "ini": key = "ini"
        case "sql": key = "sql"
        case "proto": key = "proto"
        case "json5": key = "json5"
        case "json", "jsonc": key = "json"
        case "sh", "bash": key = "bash"
        case "c", "h": key = "c"
        case "cpp", "cc", "cxx", "hpp", "hh", "hxx": key = "cpp"
        case "java": key = "java"
        case "erl", "hrl": key = "erlang"
        case "hs": key = "haskell"
        case "ex", "exs": key = "elixir"
        case "kt", "kts": key = "kotlin"
        case "yaml", "yml": key = "yaml"
        case "toml": key = "toml"
        case "swift": key = "swift"
        case "rb": key = "ruby"
        case "cs": key = "csharp"
        case "lua": key = "lua"
        case "md", "markdown": key = "markdown"
        case "graphql", "gql": key = "graphql"
        case "groovy": key = "groovy"
        case "zsh": key = "zsh"
        case "pl": key = "perl"
        case "ps1": key = "powershell"
        case "vue": key = "vue"
        case "svelte": key = "svelte"
        case "less": key = "less"
        case "scss": key = "scss"
        case "css": key = "css"
        case "html", "htm": key = "html"
        case "xml": key = "xml"
        case "php": key = "php"
        default:
            guard [".bashrc", ".bash_profile", ".profile"].contains((path as NSString).lastPathComponent) else { return [] }
            key = "bash"
        }
        return try await highlight(text, languageKey: key)
    }

    private func highlight(_ text: String, languageKey key: String) async throws -> [SyntaxSpan] {
        try Task.checkCancellation()
        guard !text.isEmpty else { return [] }
        let (language, query) = try configuration(key)
        let parser = Parser()
        try parser.setLanguage(language)
        parser.timeout = parseTimeSlice
        // macOS 的 arm64 / x86_64 均为小端。一次编码供所有时间片复用，
        // 读取偏移以字节计；每次只交给上游 Input 至多 32 KiB，避免整文件重复复制。
        let input = text.data(using: .utf16LittleEndian)!
        let read: Parser.ReadBlock = { offset, _ in
            guard offset >= 0, offset < input.count else { return nil }
            return input.subdata(in: offset..<min(offset + 32 * 1024, input.count))
        }
        // Tree-sitter 超时后保留解析栈；使用相同文本重入会续算，不重置或丢弃后半段。
        var parsed: MutableTree?
        repeat {
            try Task.checkCancellation()
            parsed = parser.parse(tree: Optional<Tree>.none, readBlock: read)
            if parsed == nil {
                parseYieldCount += 1
                await Task.yield()
            }
        } while parsed == nil
        guard let tree = parsed else { return [] }
        try Task.checkCancellation()
        var matches = query.execute(in: tree).resolve(with: .init(string: text))
        var captures: [QueryCapture] = []
        var matchCount = 0
        while let match = matches.next() {
            captures.append(contentsOf: match.captures)
            matchCount += 1
            if matchCount % 128 == 0 {
                queryYieldCount += 1
                await Task.yield()
                try Task.checkCancellation()
            }
        }
        try Task.checkCancellation()
        // 与库的 highlights() 一样按 capture 优先级排序，不能因分批改变覆盖颜色。
        var spans: [SyntaxSpan] = []
        for (index, capture) in captures.sorted().enumerated() {
            if index % 512 == 0 { await Task.yield(); try Task.checkCancellation() }
            guard let highlight = capture.highlight, let color = Self.color(highlight.name) else { continue }
            spans.append(SyntaxSpan(range: highlight.range, color: color))
        }
        if key == "kotlin", let root = tree.rootNode {
            spans += try await kotlinSimpleInterpolationSpans(root: root, text: text)
        }
        if ["html", "vue", "svelte"].contains(key), let root = tree.rootNode {
            spans += try await embeddedHTMLSpans(root: root, text: text, component: key != "html")
            if key != "html" {
                spans += try await embeddedComponentSpans(root: root, text: text, language: key)
            }
        }
        if key == "php", let root = tree.rootNode {
            spans += try await embeddedPHPHTMLSpans(root: root, text: text)
        }
        if key == "markdown", let root = tree.rootNode {
            spans += try await embeddedMarkdownSpans(root: root, text: text)
        }
        if key == "makefile", let root = tree.rootNode {
            spans += try await embeddedMakeSpans(root: root, text: text)
        }
        if key == "dockerfile", let root = tree.rootNode {
            spans += try await embeddedDockerSpans(root: root, text: text)
        }
        return spans
    }

    private func embeddedDockerSpans(root: Node, text: String) async throws -> [SyntaxSpan] {
        let source = text as NSString
        var pending = [root]
        var result: [SyntaxSpan] = []
        while let node = pending.popLast() {
            try Task.checkCancellation()
            guard node.nodeType == "shell_command" else {
                pending.append(contentsOf: (0..<node.namedChildCount).reversed().compactMap { node.namedChild(at: $0) })
                continue
            }
            // Docker 原生树已排除 RUN 参数和 JSON exec 形式；连续正文保留反斜杠续行。
            let spans = try await highlight(source.substring(with: node.range), path: "command.sh")
            result += spans.map { SyntaxSpan(range: NSRange(location: node.range.location + $0.range.location, length: $0.range.length), color: $0.color) }
        }
        return result
    }

    private func embeddedMakeSpans(root: Node, text: String) async throws -> [SyntaxSpan] {
        let source = text as NSString
        var pending = [root]
        var result: [SyntaxSpan] = []
        while let node = pending.popLast() {
            try Task.checkCancellation()
            let children = (0..<node.namedChildCount).compactMap { node.namedChild(at: $0) }
            guard node.nodeType == "recipe_line" else {
                pending.append(contentsOf: children.reversed())
                continue
            }
            let fragments = children.filter { $0.nodeType == "shell_text" }
            guard let first = fragments.first, let last = fragments.last else { continue }
            // 连续配方片段一起解析，保留反斜杠续行和跨行字符串；不包含 @/-/+ 控制前缀。
            let range = NSRange(location: first.range.location, length: NSMaxRange(last.range) - first.range.location)
            let spans = try await highlight(source.substring(with: range), path: "recipe.sh")
            result += spans.map { SyntaxSpan(range: NSRange(location: range.location + $0.range.location, length: $0.range.length), color: $0.color) }
        }
        return result
    }

    /// 保留完整 HTML 上下文：PHP 区域按 UTF16 等长留白，宿主着色只映射回模板文本。
    private func embeddedPHPHTMLSpans(root: Node, text: String) async throws -> [SyntaxSpan] {
        var pending = [root]
        var regions: [NSRange] = []
        var visited = 0
        while let node = pending.popLast() {
            visited += 1
            if visited % 128 == 0 { await Task.yield() }
            try Task.checkCancellation()
            if node.nodeType == "text" { regions.append(node.range) }
            else { pending.append(contentsOf: (0..<node.namedChildCount).compactMap { node.namedChild(at: $0) }.reversed()) }
        }
        guard !regions.isEmpty else { return [] }
        regions.sort { $0.location < $1.location }
        let original = Array(text.utf16)
        var masked = original
        var regionIndex = 0
        for offset in original.indices {
            if offset % 4096 == 0 { await Task.yield(); try Task.checkCancellation() }
            while regionIndex < regions.count && NSMaxRange(regions[regionIndex]) <= offset { regionIndex += 1 }
            let inTemplate = regionIndex < regions.count && regions[regionIndex].location <= offset
            if !inTemplate && original[offset] != 10 && original[offset] != 13 { masked[offset] = 32 }
        }
        let hostSpans = try await highlight(String(decoding: masked, as: UTF16.self), languageKey: "html")
        var result: [SyntaxSpan] = []
        for (index, span) in hostSpans.enumerated() {
            if index % 128 == 0 { await Task.yield(); try Task.checkCancellation() }
            // Capture 按优先级排列，不能依赖其位置递增；二分寻找第一个相交文本区域。
            var low = 0, high = regions.count
            while low < high {
                let middle = (low + high) / 2
                if NSMaxRange(regions[middle]) <= span.range.location { low = middle + 1 }
                else { high = middle }
            }
            var count = 0
            while low < regions.count && regions[low].location < NSMaxRange(span.range) {
                if count % 128 == 0 { await Task.yield(); try Task.checkCancellation() }
                let intersection = NSIntersectionRange(span.range, regions[low])
                if intersection.length > 0 { result.append(SyntaxSpan(range: intersection, color: span.color)) }
                low += 1; count += 1
            }
        }
        return result
    }

    /// Markdown 块树负责定位行内段落和代码围栏；只对正文调用对应原生解析器。
    private func embeddedMarkdownSpans(root: Node, text: String) async throws -> [SyntaxSpan] {
        let source = text as NSString
        var pending = [root]
        var result: [SyntaxSpan] = []
        let aliases = ["perl": "pl", "powershell": "ps1", "pwsh": "ps1", "erlang": "erl", "haskell": "hs", "elixir": "ex", "kotlin": "kt", "javascript": "js", "typescript": "ts", "rust": "rs", "python": "py",
                       "csharp": "cs", "c#": "cs", "ruby": "rb", "shell": "sh", "shellscript": "sh", "c++": "cpp", "yml": "yaml"]
        while let node = pending.popLast() {
            try Task.checkCancellation()
            let children = (0..<node.namedChildCount).compactMap { node.namedChild(at: $0) }
            if node.nodeType == "inline" {
                let spans = try await highlight(source.substring(with: node.range), languageKey: "markdown-inline")
                result += spans.map { SyntaxSpan(range: NSRange(location: node.range.location + $0.range.location, length: $0.range.length), color: $0.color) }
            } else if node.nodeType == "fenced_code_block" {
                guard let info = children.first(where: { $0.nodeType == "info_string" }),
                      let language = source.substring(with: info.range).split(whereSeparator: { $0.isWhitespace }).first?.lowercased(),
                      !["md", "markdown"].contains(language) else { continue }
                for body in children where body.nodeType == "code_fence_content" {
                    let contents = source.substring(with: body.range)
                    let spans: [SyntaxSpan]
                    if language == "php", !contents.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("<?") {
                        spans = try await highlight(contents, languageKey: "php-only")
                    } else {
                        spans = try await highlight(contents, path: ["dockerfile", "makefile"].contains(language) ? language : "embedded." + (aliases[language] ?? language))
                    }
                    // 代码正文先恢复代码默认前景，避免普通标识符继承 Markdown 围栏字符串色。
                    result.append(SyntaxSpan(range: body.range, color: 0xe6edf3))
                    result += spans.map { SyntaxSpan(range: NSRange(location: body.range.location + $0.range.location, length: $0.range.length), color: $0.color) }
                }
            } else {
                pending.append(contentsOf: children.reversed())
            }
        }
        return result
    }

    /// 模板解析器负责定位表达式，脚本解析器只接收表达式正文，不执行模板。
    private func embeddedComponentSpans(root: Node, text: String, language: String) async throws -> [SyntaxSpan] {
        let source = text as NSString
        var pending = [root]
        var regions: [NSRange] = []
        while let node = pending.popLast() {
            try Task.checkCancellation()
            let children = (0..<node.namedChildCount).compactMap { node.namedChild(at: $0) }
            if ["script_element", "style_element"].contains(node.nodeType ?? "") { continue }
            if language == "svelte", node.nodeType == "svelte_raw_text" {
                regions.append(node.range)
            } else if language == "vue", node.nodeType == "interpolation" {
                regions += children.filter { $0.nodeType == "raw_text" }.map(\.range)
            } else if language == "vue", node.nodeType == "directive_attribute" {
                for part in children {
                    if part.nodeType == "attribute_value" { regions.append(part.range) }
                    if part.nodeType == "quoted_attribute_value" || part.nodeType == "dynamic_directive_value" {
                        regions += (0..<part.namedChildCount).compactMap { part.namedChild(at: $0) }
                            .filter { $0.nodeType == "attribute_value" || $0.nodeType == "dynamic_directive_inner_value" }.map(\.range)
                    }
                }
            } else { pending.append(contentsOf: children.reversed()) }
        }
        var result: [SyntaxSpan] = []
        for range in regions {
            guard NSMaxRange(range) <= source.length else { continue }
            let spans = try await highlight(source.substring(with: range), path: "expression.ts")
            // 清掉 HTML 属性字符串色，再应用脚本语义；普通变量保持默认前景。
            result.append(SyntaxSpan(range: range, color: 0xe6edf3))
            result += spans.map { SyntaxSpan(range: NSRange(location: range.location + $0.range.location, length: $0.range.length), color: $0.color) }
        }
        return result
    }

    /// 从原生 HTML 树定位正文，避免正则把注释、属性里的标签误判成代码。
    private func embeddedHTMLSpans(root: Node, text: String, component: Bool = false) async throws -> [SyntaxSpan] {
        let source = text as NSString
        var pending = [root]
        var result: [SyntaxSpan] = []
        func children(_ node: Node) -> [Node] {
            (0..<node.namedChildCount).compactMap { node.namedChild(at: $0) }
        }
        while let node = pending.popLast() {
            try Task.checkCancellation()
            let nested = children(node)
            guard node.nodeType == "script_element" || node.nodeType == "style_element" else {
                pending.append(contentsOf: nested.reversed())
                continue
            }
            var type = ""
            var lang = ""
            if let start = nested.first(where: { $0.nodeType == "start_tag" }) {
                for attribute in children(start) where attribute.nodeType == "attribute" {
                    let parts = children(attribute)
                    guard let name = parts.first(where: { $0.nodeType == "attribute_name" }) else { continue }
                    let attributeName = source.substring(with: name.range).lowercased()
                    guard attributeName == "type" || (component && attributeName == "lang") else { continue }
                    if let value = parts.first(where: { $0.nodeType == "attribute_value" || $0.nodeType == "quoted_attribute_value" }) {
                        let content = value.nodeType == "quoted_attribute_value"
                            ? children(value).first(where: { $0.nodeType == "attribute_value" }) : value
                        let value = content.map { source.substring(with: $0.range) } ?? ""
                        if attributeName == "type" { type = value } else { lang = value }
                    }
                }
            }
            type = type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            lang = lang.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let path: String
            if component && !lang.isEmpty {
                let aliases = node.nodeType == "style_element"
                    ? ["css": "css", "scss": "scss", "less": "less"]
                    : ["js": "js", "javascript": "js", "ts": "ts", "typescript": "ts", "jsx": "jsx", "tsx": "tsx"]
                guard let ext = aliases[lang] else { continue }
                path = "embedded." + ext
            } else if node.nodeType == "style_element" {
                guard type.isEmpty || type == "text/css" else { continue }
                path = "embedded.css"
            } else {
                switch type {
                case "", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript":
                    path = "embedded.js"
                case "application/json", "application/ld+json", "importmap", "speculationrules":
                    path = "embedded.json"
                default: continue // 未支持的模板类型保持纯文本，不能强行当作 JavaScript。
                }
            }
            for body in nested where body.nodeType == "raw_text" {
                let range = body.range
                let spans = try await highlight(source.substring(with: range), path: path)
                result += spans.map { SyntaxSpan(range: NSRange(location: range.location + $0.range.location, length: $0.range.length), color: $0.color) }
            }
        }
        return result
    }

    /// Kotlin 1.1.0 将普通字符串的 $name 拆为 string_content，原生树内补齐简单插值。
    /// 只合并相邻正文节点，转义和 ${expression} 都是边界，避免给普通文本误着色。
    private func kotlinSimpleInterpolationSpans(root: Node, text: String) async throws -> [SyntaxSpan] {
        let source = text as NSString
        let pattern = try NSRegularExpression(pattern: #"\$[_\p{L}][_\p{L}\p{N}]*"#)
        var pending = [root], result: [SyntaxSpan] = []
        var visited = 0
        while let node = pending.popLast() {
            visited += 1
            if visited % 128 == 0 { await Task.yield(); try Task.checkCancellation() }
            let children = (0..<node.namedChildCount).compactMap { node.namedChild(at: $0) }
            pending.append(contentsOf: children)
            guard node.nodeType == "string_literal" else { continue }
            var regions: [NSRange] = []
            for child in children where child.nodeType == "string_content" {
                if let last = regions.last, NSMaxRange(last) == child.range.location {
                    regions[regions.count - 1].length += child.range.length
                } else { regions.append(child.range) }
            }
            for region in regions {
                try Task.checkCancellation()
                for match in pattern.matches(in: text, range: region) {
                    guard NSMaxRange(match.range) <= source.length else { continue }
                    result.append(SyntaxSpan(range: match.range, color: 0x79c0ff))
                }
            }
        }
        return result
    }

    private func configuration(_ key: String) throws -> (Language, Query) {
        if let existing = configurations[key] { return existing }
        let language: Language
        switch key {
        case "typescript": language = Language(tree_sitter_typescript())
        case "tsx": language = Language(tree_sitter_tsx())
        case "rust": language = Language(tree_sitter_rust())
        case "python": language = Language(tree_sitter_python())
        case "go": language = Language(tree_sitter_go())
        case "dart": language = Language(tree_sitter_dart())
        case "r": language = Language(tree_sitter_r())
        case "ini": language = Language(tree_sitter_ini())
        case "sql": language = Language(tree_sitter_sql())
        case "proto": language = Language(tree_sitter_proto())
        case "json5": language = Language(tree_sitter_json5())
        case "json": language = Language(tree_sitter_json())
        case "bash": language = Language(tree_sitter_bash())
        case "c": language = Language(tree_sitter_c())
        case "graphql": language = Language(tree_sitter_graphql())
        case "groovy": language = Language(tree_sitter_groovy())
        case "zsh": language = Language(tree_sitter_zsh())
        case "perl": language = Language(tree_sitter_perl())
        case "powershell": language = Language(tree_sitter_powershell())
        case "vue": language = Language(tree_sitter_vue())
        case "svelte": language = Language(tree_sitter_svelte())
        case "less": language = Language(tree_sitter_less())
        case "scss": language = Language(tree_sitter_scss())
        case "css": language = Language(tree_sitter_css())
        case "html": language = Language(tree_sitter_html())
        case "xml": language = Language(tree_sitter_xml())
        case "php": language = Language(tree_sitter_php())
        case "php-only": language = Language(tree_sitter_php_only())
        case "cpp": language = Language(tree_sitter_cpp())
        case "java": language = Language(tree_sitter_java())
        case "erlang": language = Language(tree_sitter_erlang())
        case "haskell": language = Language(tree_sitter_haskell())
        case "elixir": language = Language(tree_sitter_elixir())
        case "kotlin": language = Language(tree_sitter_kotlin())
        case "yaml": language = Language(tree_sitter_yaml())
        case "toml": language = Language(tree_sitter_toml())
        case "swift": language = Language(tree_sitter_swift())
        case "ruby": language = Language(tree_sitter_ruby())
        case "csharp": language = Language(tree_sitter_c_sharp())
        case "dockerfile": language = Language(tree_sitter_dockerfile())
        case "makefile": language = Language(tree_sitter_make())
        case "lua": language = Language(tree_sitter_lua())
        case "markdown": language = Language(tree_sitter_markdown())
        case "markdown-inline": language = Language(tree_sitter_markdown_inline())
        default: language = Language(tree_sitter_javascript())
        }
        let resources: [String]
        switch key {
        case "vue", "svelte": resources = ["html-highlights", key + "-highlights"]
        case "scss": resources = ["css-highlights", "scss-highlights"]
        case "php-only": resources = ["php-highlights"]
        case "cpp": resources = ["c-highlights", "cpp-highlights"]
        case "jsx": resources = ["javascript-highlights", "jsx-highlights"]
        case "typescript": resources = ["javascript-highlights", "typescript-highlights"]
        case "tsx": resources = ["javascript-highlights", "jsx-highlights", "typescript-highlights"]
        default: resources = [key + "-highlights"]
        }
        var source = try resources.map { name in
            guard let url = Bundle.main.url(forResource: name, withExtension: "scm") else {
                throw CocoaError(.fileNoSuchFile)
            }
            return try String(contentsOf: url, encoding: .utf8)
        }.joined(separator: "\n")
        if ["javascript", "jsx", "typescript", "tsx"].contains(key) {
            // Web 暗色主题为 const 声明名着色；放在上游查询之前，保留函数声明等更具体的颜色。
            source = """
            (lexical_declaration kind: "const"
              (variable_declarator name: (identifier) @constant))
            """ + "\n" + source
        }
        let query = try Query(language: language, data: Data(source.utf8))
        configurations[key] = (language, query)
        return (language, query)
    }

    /// 保持 Web 暗色主题的视觉层级；语义来自原生语法树，允许合理的分词差异。
    private static func color(_ name: String) -> UInt32? {
        if name == "variable.zsh" { return 0xe6edf3 }
        if ["function.groovy.builtin", "function.zsh.builtin"].contains(name) { return 0x79c0ff }
        if name.hasPrefix("variable.perl") || name == "variable.powershell" { return 0xe6edf3 }
        if name.hasPrefix("function.perl.builtin") || name == "function.powershell.command" { return 0x79c0ff }
        switch name {
        case "type.dart", "type.dart.builtin", "type.graphql", "type.graphql.builtin": return 0x79c0ff
        case "variable.graphql", "property.graphql", "parameter.graphql": return 0xffa657
        case "punctuation.dart": return 0xe6edf3
        case "variable.dart": return 0x79c0ff
        case "variable.r", "variable.r.parameter": return 0xffa657
        case "variable.less", "property.less", "function.less", "selector.less": return 0x79c0ff
        case "unit.less": return 0xff7b72
        case "variable.scss": return 0xffa657
        case "unit.scss": return 0xff7b72
        case "text.title", "text.uri": return 0x79c0ff
        case "text.literal", "text.reference": return 0xa5d6ff
        default: break
        }
        return switch name.split(separator: ".").first {
        case "comment": 0x8b949e
        case "string", "character": 0xa5d6ff
        case "keyword", "operator", "conditional", "repeat", "include", "exception": 0xff7b72
        case "number", "constant", "boolean": 0x79c0ff
        case "function", "method": 0xd2a8ff
        case "type", "constructor": 0xffa657
        case "tag": 0x7ee787
        case "property", "attribute": 0x79c0ff
        default: nil
        }
    }
}

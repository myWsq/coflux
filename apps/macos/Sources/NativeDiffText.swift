import AppKit
import SwiftUI

/// Tab 相对代码起点按四个空格对齐；测量和 TextKit 共用制表位，不改写原文。
enum DiffTextMetrics {
    static let hunkHeight: CGFloat = 21.5
    static let codeHeight: CGFloat = 20
    static func prepare(_ line: DiffLine, measureWidth: Bool = true) -> (font: NSFont, paragraph: NSParagraphStyle, width: CGFloat) {
        let header = line.kind == "@"
        let font = NSFont.monospacedSystemFont(ofSize: header ? 10 : 11, weight: .regular)
        let indent: CGFloat = header ? 12 : 32
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = header ? hunkHeight : codeHeight
        paragraph.maximumLineHeight = paragraph.minimumLineHeight
        paragraph.firstLineHeadIndent = indent
        paragraph.headIndent = indent
        paragraph.lineBreakMode = .byClipping
        paragraph.tabStops = []
        var width: CGFloat = 0
        if line.text.contains("\t") {
            let interval = (" " as NSString).size(withAttributes: [.font: font]).width * 4
            paragraph.defaultTabInterval = interval
            let parts = line.text.components(separatedBy: "\t")
            var stops: [NSTextTab] = []
            for (index, part) in parts.enumerated() {
                width += (part as NSString).size(withAttributes: [.font: font]).width
                if index + 1 < parts.count {
                    // 避免恰好在制表位上的浮点舍入让 Tab 停在原地。
                    width = (floor(width / interval + 0.000001) + 1) * interval
                    stops.append(NSTextTab(textAlignment: .left, location: indent + width))
                }
            }
            paragraph.tabStops = stops
        } else if measureWidth {
            width = (line.text as NSString).size(withAttributes: [.font: font]).width
        }
        return (font, paragraph, max(600, ceil(indent + width) + 16))
    }
}

/// 整份文件共享一个 UTF-16 文本范围；增删符号不进入文档，复制时不会混入装饰。
@MainActor final class DiffTextDocument {
    let text: NSAttributedString
    let lines: [DiffLine]
    let layout: DiffRowLayout
    let trailingAttributes: [NSAttributedString.Key: Any]
    let highlightingComplete: Bool
    private let sourceFile: DiffFile
    var sourcePath: String { sourceFile.path }

    private init(file: DiffFile, builder: Builder, highlightingComplete: Bool = false) {
        sourceFile = file
        self.highlightingComplete = highlightingComplete
        lines = file.lines
        layout = DiffRowLayout(lines: file.lines)
        trailingAttributes = builder.lastAttributes
        text = builder.value.copy() as! NSAttributedString
    }

    convenience init(file: DiffFile, spans: [Int: [SyntaxSpan]] = [:]) {
        let builder = Builder()
        for (index, line) in file.lines.enumerated() {
            builder.append(line, newline: index + 1 < file.lines.count, spans: spans[line.id] ?? [])
        }
        self.init(file: file, builder: builder)
    }

    /// 准备期间保持旧文档完整可用，每批让出主线程；取消后不交付半成品。
    static func prepare(file: DiffFile, spans: [Int: [SyntaxSpan]] = [:], highlightingComplete: Bool = false) async throws -> DiffTextDocument {
        let builder = Builder()
        for (index, line) in file.lines.enumerated() {
            if index % 64 == 0 {
                await Task.yield()
                try Task.checkCancellation()
            }
            builder.append(line, newline: index + 1 < file.lines.count, spans: spans[line.id] ?? [])
        }
        try Task.checkCancellation()
        return DiffTextDocument(file: file, builder: builder, highlightingComplete: highlightingComplete)
    }

    /// 仍获取最新 Git 正文；只在完整源数据相等时复用显示文档，不能用增删行数当缓存版本。
    static func refresh(file: DiffFile, previous: DiffTextDocument?) async throws -> DiffTextDocument {
        try Task.checkCancellation()
        if let previous, previous.sourceFile == file { return previous }
        return try await prepare(file: file)
    }

    private final class Builder {
        let value = NSMutableAttributedString(string: "")
        var lastAttributes: [NSAttributedString.Key: Any] = [:]

        func append(_ line: DiffLine, newline: Bool, spans: [SyntaxSpan]) {
            let metrics = DiffTextMetrics.prepare(line, measureWidth: false)
            let start = value.length
            lastAttributes = [
                .font: metrics.font,
                .foregroundColor: Design.native(line.kind == "@" ? 0x75756d : 0xe6e6e3),
                .paragraphStyle: metrics.paragraph,
            ]
            value.append(NSAttributedString(string: line.text + (newline ? "\n" : ""), attributes: lastAttributes))
            let length = line.text.utf16.count
            for span in spans where span.range.location >= 0 && NSMaxRange(span.range) <= length {
                value.addAttribute(.foregroundColor, value: Design.native(span.color),
                                   range: NSRange(location: start + span.range.location, length: span.range.length))
            }
        }
    }
}

struct NativeDiffText: NSViewRepresentable {
    let document: DiffTextDocument
    let active: Bool

    func makeNSView(context: Context) -> DiffSelectionView {
        DiffSelectionView.make(frame: .zero)
    }

    func updateNSView(_ view: DiffSelectionView, context: Context) {
        view.setAccessibilityLabel("差异代码 " + document.sourcePath)
        // 首次屏外挂载不填充TextKit，避免AppKit测量时同步排版全文。
        // 一旦展示便保留完整文本；再次离开视口仅暂停预布局，不丢失选区。
        if active || view.document != nil { view.apply(document) }
        view.setLayoutActive(active)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: DiffSelectionView, context: Context) -> CGSize? {
        // 行高和横向宽度已由diff模型确定，不能再让NSTextView为固有尺寸排完整份文件。
        CGSize(width: proposal.width ?? 600, height: document.layout.height)
    }

    static func dismantleNSView(_ view: DiffSelectionView, coordinator: ()) {
        view.setLayoutActive(false)
    }
}

final class DiffSelectionView: NSTextView {
    private(set) var document: DiffTextDocument?
    private var layoutActive = false
    private var layoutPreparation: Task<Void, Never>?
    private var layoutGeneration = 0

    func setLayoutActive(_ active: Bool) {
        guard layoutActive != active else { return }
        layoutActive = active
        restartLayoutPreparation()
    }

    private func restartLayoutPreparation() {
        layoutGeneration += 1
        layoutPreparation?.cancel()
        layoutPreparation = nil
        guard layoutActive else { return }
        let generation = layoutGeneration
        layoutPreparation = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                // 每批之间留出事件处理时间，隐藏文档不继续占用主线程。
                do { try await Task.sleep(for: .milliseconds(8)) } catch { return }
                guard let self, self.layoutActive, self.layoutGeneration == generation,
                      let manager = self.layoutManager, let storage = self.textStorage else { return }
                let first = manager.firstUnlaidCharacterIndex()
                guard first < storage.length else { self.layoutPreparation = nil; return }
                manager.ensureLayout(forCharacterRange: NSRange(location: first, length: min(2048, storage.length - first)))
            }
        }
    }

    static func make(frame: NSRect) -> DiffSelectionView {
        let view = DiffSelectionView(frame: frame)
        view.configure()
        return view
    }

    private func configure() {
        isEditable = false
        isSelectable = true
        isRichText = false
        drawsBackground = false
        textContainerInset = .zero
        textContainer?.lineFragmentPadding = 0
        textContainer?.widthTracksTextView = true
        isVerticallyResizable = false
        isHorizontallyResizable = false
        // 非连续布局会估算未排版段落的高度，无法与固定 20/21.5 点背景坐标可靠对齐。
        layoutManager?.allowsNonContiguousLayout = false
        // 自动后台排版可能一次占用较久；由激活状态驱动分批预布局。
        layoutManager?.backgroundLayoutEnabled = false
        usesFindPanel = false
        setAccessibilityLabel("差异代码")
    }

    func apply(_ document: DiffTextDocument) {
        guard self.document !== document else { return }
        let selection = selectedRange()
        let sameText = string == document.text.string
        let colorOnly = self.document?.lines == document.lines
        self.document = document
        if colorOnly, let manager = layoutManager {
            // TextKit 的显示属性不改写文本存储，因此不会触发布局重算。
            let fullRange = NSRange(location: 0, length: document.text.length)
            manager.removeTemporaryAttribute(.foregroundColor, forCharacterRange: fullRange)
            document.text.enumerateAttribute(.foregroundColor, in: fullRange) { value, range, _ in
                if let value { manager.addTemporaryAttribute(.foregroundColor, value: value, forCharacterRange: range) }
            }
        } else {
            layoutManager?.removeTemporaryAttribute(.foregroundColor, forCharacterRange: NSRange(location: 0, length: (string as NSString).length))
            textStorage?.setAttributedString(document.text)
            if sameText { setSelectedRange(selection) }
            restartLayoutPreparation()
        }
        // 末尾空行没有字符承载属性，TextKit 从 typingAttributes 获取其行高。
        typingAttributes = document.trailingAttributes
        // NSTextView 的全视图重绘请求会同步布局整份文档；这里只失效可见区域。
        if window != nil, bounds.width > 0, bounds.height > 0 {
            let dirty = visibleRect.intersection(bounds)
            if !dirty.isEmpty, !dirty.isNull { setNeedsDisplay(dirty) }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        if let document {
            for index in document.layout.visibleRange(top: dirtyRect.minY, height: dirtyRect.height) {
                let line = document.lines[index]
                let y = document.layout.offsets[index]
                let height = document.layout.offsets[index + 1] - y
                let background: NSColor? = switch line.kind {
                case "+": Design.native(0x4fae6e).withAlphaComponent(0.1)
                case "-": Design.native(0xe05c6a).withAlphaComponent(0.1)
                case "@": Design.native(0x262624).withAlphaComponent(0.4)
                default: nil
                }
                background?.setFill()
                if background != nil { NSRect(x: 0, y: y, width: bounds.width, height: height).fill() }
                if line.kind == "+" || line.kind == "-" {
                    (String(line.kind) as NSString).draw(at: NSPoint(x: 12, y: y + 3), withAttributes: [
                        .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
                        .foregroundColor: Design.native(line.kind == "+" ? 0x4fae6e : 0xe05c6a),
                    ])
                }
            }
        }
        super.draw(dirtyRect)
    }
}

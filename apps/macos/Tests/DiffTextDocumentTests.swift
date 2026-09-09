import AppKit
import XCTest
@testable import Coflux

final class DiffTextDocumentTests: XCTestCase {
    @MainActor func testBackgroundPreparationStopsWhenHiddenAndResumes() async throws {
        let file = DiffFile(path: "warm.ts", lines: (0..<5000).map {
            DiffLine(id: $0, text: "const value_\($0) = 42;", kind: "+", old: nil, new: $0 + 1)
        })
        let document = try await DiffTextDocument.prepare(file: file)
        let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: 800, height: document.layout.height))
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 800, height: 700))
        scroll.documentView = view
        view.apply(document)
        defer { view.setLayoutActive(false) }
        let manager = try XCTUnwrap(view.layoutManager)
        XCTAssertFalse(manager.backgroundLayoutEnabled)
        let initial = manager.firstUnlaidCharacterIndex()
        view.setLayoutActive(true)
        let deadline = ContinuousClock.now + .seconds(5)
        while manager.firstUnlaidCharacterIndex() <= initial {
            guard ContinuousClock.now < deadline else { return XCTFail("可见页面未分批准备布局") }
            try await Task.sleep(for: .milliseconds(5))
        }
        view.setLayoutActive(false)
        let stopped = manager.firstUnlaidCharacterIndex()
        XCTAssertLessThan(stopped, document.text.length, "首批不能同步排完整份文档")
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(manager.firstUnlaidCharacterIndex(), stopped, "隐藏页面必须停止准备")
        view.setLayoutActive(true)
        while manager.firstUnlaidCharacterIndex() < document.text.length {
            guard ContinuousClock.now < deadline else { return XCTFail("恢复可见后未完成布局") }
            try await Task.sleep(for: .milliseconds(10))
        }
        let container = try XCTUnwrap(view.textContainer)
        let start = ContinuousClock.now
        manager.ensureLayout(forBoundingRect: NSRect(x: 0, y: 99000, width: 800, height: 700), in: container)
        print("5000行分批预布局后末尾访问：\(start.duration(to: .now))")
        XCTAssertEqual(manager.usedRect(for: container).height, 100000, accuracy: 0.1)
    }

    @MainActor func testTemporaryHighlightRendersAndClearsOnStructuralChange() throws {
        let line = DiffLine(id: 0, text: "const value = 42;", kind: "+", old: nil, new: 1)
        let file = DiffFile(path: "colors.ts", lines: [line])
        let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: 400, height: 80))
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        view.apply(DiffTextDocument(file: file))
        view.apply(DiffTextDocument(file: file, spans: [0: [SyntaxSpan(range: NSRange(location: 0, length: 5), color: 0xff0000)]]))
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: "/tmp/coflux-diff-temporary-highlight.png"))
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = "TextKit临时高亮实际绘制"; attachment.lifetime = .keepAlways; add(attachment)
        // 纯红仅来自const高亮，背景/增删标记均不是红色；直接检查绘制结果而非属性字典。
        var redPixels = 0
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                if color.alphaComponent > 0.5 && color.redComponent > 0.7 && color.greenComponent < 0.25 && color.blueComponent < 0.25 { redPixels += 1 }
            }
        }
        XCTAssertGreaterThan(redPixels, 10)
        var changed = file
        changed.lines = [DiffLine(id: 0, text: line.text, kind: "@", old: nil, new: nil)]
        view.apply(DiffTextDocument(file: changed))
        let manager = try XCTUnwrap(view.layoutManager), container = try XCTUnwrap(view.textContainer)
        XCTAssertNil(manager.temporaryAttribute(.foregroundColor, atCharacterIndex: 0, effectiveRange: nil))
        manager.ensureLayout(for: container)
        XCTAssertEqual(manager.usedRect(for: container).height, 21.5, accuracy: 0.1)
        XCTAssertEqual((view.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, 10)
        changed.lines = [DiffLine(id: 1, text: "x", kind: " ", old: 1, new: 1)]
        view.apply(DiffTextDocument(file: changed))
        XCTAssertEqual(view.string, "x")
        XCTAssertNil(manager.temporaryAttribute(.foregroundColor, atCharacterIndex: 0, effectiveRange: nil))
    }

    @MainActor func testColorRefreshKeepsLaidOutRowsAndSelection() async throws {
        let file = DiffFile(path: "colors.ts", lines: (0..<5000).map {
            DiffLine(id: $0, text: "const value_\($0) = \"中文😀\";", kind: "+", old: nil, new: $0 + 1)
        })
        let plain = try await DiffTextDocument.prepare(file: file)
        let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: 800, height: plain.layout.height))
        view.apply(plain)
        let manager = try XCTUnwrap(view.layoutManager), container = try XCTUnwrap(view.textContainer)
        manager.ensureLayout(for: container)
        let laidOut = manager.firstUnlaidCharacterIndex()
        let selected = (view.string as NSString).range(of: "value_4950")
        view.setSelectedRange(selected)
        let colored = try await DiffTextDocument.prepare(file: file, spans: Dictionary(uniqueKeysWithValues: file.lines.map {
            ($0.id, [SyntaxSpan(range: NSRange(location: 0, length: 5), color: 0xff7b72)])
        }))
        let start = ContinuousClock.now
        view.apply(colored)
        let after = manager.firstUnlaidCharacterIndex()
        manager.ensureLayout(for: container)
        print("5000行纯高亮更新及布局检查：\(start.duration(to: .now))，更新前/后已布局字符=\(laidOut)/\(after)")
        XCTAssertEqual(after, laidOut, "纯颜色更新不得丢弃已完成的文字布局")
        XCTAssertEqual(view.selectedRange(), selected)
        XCTAssertEqual(manager.temporaryAttribute(.foregroundColor, atCharacterIndex: 0, effectiveRange: nil) as? NSColor, Design.native(0xff7b72))
        view.apply(plain)
        XCTAssertEqual(manager.temporaryAttribute(.foregroundColor, atCharacterIndex: 0, effectiveRange: nil) as? NSColor, Design.native(0xe6e6e3))
    }

    @MainActor func testContinuousUnicodeSelectionExcludesDiffDecorations() throws {
        let file = try XCTUnwrap(UnifiedDiff.parse("""
        diff --git a/code.ts b/code.ts
        --- a/code.ts
        +++ b/code.ts
        @@ -1 +1,2 @@
        -const old = "旧😀";
        +const first = "新😀";
        +const second = "中文";
        """).first)
        let document = DiffTextDocument(file: file)
        XCTAssertEqual(document.text.string, "@@ -1 +1,2 @@\nconst old = \"旧😀\";\nconst first = \"新😀\";\nconst second = \"中文\";")
        let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: 700, height: document.layout.height))
        view.apply(document)
        let source = document.text.string as NSString
        let start = source.range(of: "const first").location
        view.setSelectedRange(NSRange(location: start, length: source.length - start))
        XCTAssertEqual((view.string as NSString).substring(with: view.selectedRange()),
                       "const first = \"新😀\";\nconst second = \"中文\";")
        // 使用独立命名的粘贴板验证 AppKit 实际导出，不接触用户的系统剪贴板。
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.declareTypes(view.writablePasteboardTypes, owner: nil)
        XCTAssertTrue(view.writeSelection(to: pasteboard, types: view.writablePasteboardTypes))
        XCTAssertEqual(pasteboard.string(forType: .string),
                       "const first = \"新😀\";\nconst second = \"中文\";")
        let selection = view.selectedRange()
        let refreshed = DiffTextDocument(file: file, spans: [
            file.lines[2].id: [SyntaxSpan(range: NSRange(location: 0, length: 5), color: 0xff0000)],
        ])
        view.apply(refreshed)
        XCTAssertEqual(view.selectedRange(), selection)
        XCTAssertTrue(view.writeSelection(to: pasteboard, types: view.writablePasteboardTypes))
        XCTAssertEqual(pasteboard.string(forType: .string),
                       "const first = \"新😀\";\nconst second = \"中文\";")

    }

    @MainActor func testUnchangedRefreshPreservesHighlightAndUnfinishedWorkCanResume() async throws {
        let file = DiffFile(path: "code.ts", lines: [DiffLine(id: 0, text: "const first = 1;", kind: "+", old: nil, new: 1)])
        let plain = try await DiffTextDocument.refresh(file: file, previous: nil)
        XCTAssertFalse(plain.highlightingComplete)
        let interrupted = try await DiffTextDocument.refresh(file: file, previous: plain)
        XCTAssertTrue(interrupted === plain)
        XCTAssertFalse(interrupted.highlightingComplete, "恢复页面时仍应继续未完成的高亮")
        let colored = try await DiffTextDocument.prepare(file: file, spans: [0: [SyntaxSpan(range: NSRange(location: 0, length: 5), color: 0xff0000)]], highlightingComplete: true)
        let refreshed = try await DiffTextDocument.refresh(file: file, previous: colored)
        XCTAssertTrue(refreshed === colored, "无变化时保留原文档，避免清除颜色和重新布局")
        XCTAssertTrue(refreshed.highlightingComplete)
        var changed = file
        changed.lines = [DiffLine(id: 0, text: "const second = 2;", kind: "+", old: nil, new: 1)]
        XCTAssertEqual(changed.additions, file.additions)
        let replacement = try await DiffTextDocument.refresh(file: changed, previous: colored)
        XCTAssertFalse(replacement === colored)
        XCTAssertFalse(replacement.highlightingComplete)
        XCTAssertEqual(replacement.text.string, "const second = 2;")
        var changedKind = file
        changedKind.lines = [DiffLine(id: 0, text: "const first = 1;", kind: "-", old: 1, new: nil)]
        let changedDecoration = try await DiffTextDocument.refresh(file: changedKind, previous: colored)
        XCTAssertFalse(changedDecoration === colored, "文本相同但增删类型变化时也必须刷新")
    }

    @MainActor func testPreparationYieldsAndPreservesAttributedDocument() async throws {
        let lines = (0..<5000).map {
            DiffLine(id: $0, text: $0 % 2 == 0 ? "\tconst 中文😀 = 1;" : "", kind: "+", old: nil, new: $0 + 1)
        }
        let file = DiffFile(path: "large.ts", lines: lines)
        let spans = [0: [SyntaxSpan(range: NSRange(location: 1, length: 5), color: 0xff0000)]]
        var ticks = 0
        let observer = Task { @MainActor in
            while !Task.isCancelled {
                ticks += 1
                await Task.yield()
            }
        }
        defer { observer.cancel() }
        let prepared = try await DiffTextDocument.prepare(file: file, spans: spans)
        XCTAssertGreaterThan(ticks, 1, "准备期间应多次让其他主线程任务运行，不能只在开始时让出一次")
        let expected = DiffTextDocument(file: file, spans: spans)
        XCTAssertTrue(prepared.text.isEqual(to: expected.text))
        XCTAssertEqual(prepared.layout.offsets, expected.layout.offsets)
    }

    @MainActor func testCancelledPreparationDoesNotReturnDocument() async {
        let file = DiffFile(path: "large.txt", lines: (0..<5000).map {
            DiffLine(id: $0, text: "line \($0)", kind: "+", old: nil, new: $0 + 1)
        })
        let preparation = Task { @MainActor in try await DiffTextDocument.prepare(file: file) }
        await Task.yield()
        preparation.cancel()
        do {
            _ = try await preparation.value
            XCTFail("取消的准备任务不得返回可发布的文档")
        } catch is CancellationError {
        } catch {
            XCTFail("非预期错误：\(error)")
        }
    }

    @MainActor func testLongTabLineFitsMeasuredContentWidth() throws {
        let content = String(repeating: "\t", count: 40) + String(repeating: "中文😀abc", count: 100) + "END"
        let file = DiffFile(path: "tabs.txt", lines: [
            DiffLine(id: 0, text: content, kind: "+", old: nil, new: 1),
        ])
        let width = DiffTextMetrics.prepare(file.lines[0]).width
        let document = DiffTextDocument(file: file)
        let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: width, height: document.layout.height))
        view.apply(document)
        let manager = try XCTUnwrap(view.layoutManager)
        let container = try XCTUnwrap(view.textContainer)
        manager.ensureLayout(for: container)
        let last = manager.glyphIndexForCharacter(at: document.text.length - 1)
        XCTAssertFalse(manager.notShownAttribute(forGlyphAt: last))
        let rect = manager.boundingRect(forGlyphRange: NSRange(location: last, length: 1), in: container)
        XCTAssertGreaterThan(rect.width, 0)
        XCTAssertLessThanOrEqual(rect.maxX, width)
        XCTAssertEqual(manager.usedRect(for: container).height, 20, accuracy: 0.1)
    }

    @MainActor func testTabsUseFourSpaceStopsRelativeToCodeOrigin() throws {
        for (content, columns) in [("\tX", 4), ("a\tX", 4), ("abcd\tX", 8), ("\t\tX", 8)] {
            let line = DiffLine(id: 0, text: content, kind: "+", old: nil, new: 1)
            let document = DiffTextDocument(file: DiffFile(path: "tabs.txt", lines: [line]))
            let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: 600, height: 20))
            view.apply(document)
            let manager = try XCTUnwrap(view.layoutManager)
            let container = try XCTUnwrap(view.textContainer)
            manager.ensureLayout(for: container)
            let glyph = manager.glyphIndexForCharacter(at: document.text.length - 1)
            let position = manager.location(forGlyphAt: glyph)
            let fragment = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            let space = (" " as NSString).size(withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)]).width
            XCTAssertEqual(fragment.minX + position.x, 32 + CGFloat(columns) * space, accuracy: 0.1, content)
            XCTAssertEqual(view.string, content)
        }
    }

    @MainActor func testTrailingEmptyLineHasItsOwnFullHeight() throws {
        let file = DiffFile(path: "empty.txt", lines: [
            DiffLine(id: 0, text: "first", kind: "+", old: nil, new: 1),
            DiffLine(id: 1, text: "", kind: "+", old: nil, new: 2),
        ])
        let document = DiffTextDocument(file: file)
        let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: 600, height: document.layout.height))
        view.apply(document)
        let manager = try XCTUnwrap(view.layoutManager)
        let container = try XCTUnwrap(view.textContainer)
        manager.ensureLayout(for: container)
        XCTAssertEqual(manager.extraLineFragmentRect.minY, 20, accuracy: 0.1)
        XCTAssertEqual(manager.extraLineFragmentRect.height, 20, accuracy: 0.1)
        XCTAssertEqual(manager.usedRect(for: container).height, document.layout.height, accuracy: 0.1)
        XCTAssertEqual(view.string, "first\n")
    }

    @MainActor func testSelectingHeaderDoesNotResizeTrailingEmptyCodeLine() throws {
        let file = DiffFile(path: "empty.txt", lines: [
            DiffLine(id: 0, text: "@@ -0,0 +1,2 @@", kind: "@", old: nil, new: nil),
            DiffLine(id: 1, text: "first", kind: "+", old: nil, new: 1),
            DiffLine(id: 2, text: "", kind: "+", old: nil, new: 2),
        ])
        let document = DiffTextDocument(file: file)
        let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: 600, height: document.layout.height))
        view.apply(document)
        let manager = try XCTUnwrap(view.layoutManager)
        let container = try XCTUnwrap(view.textContainer)
        for selection in [NSRange(location: 0, length: 2), NSRange(location: document.text.length, length: 0)] {
            view.setSelectedRange(selection)
            manager.ensureLayout(for: container)
            XCTAssertEqual(manager.extraLineFragmentRect.minY, 41.5, accuracy: 0.1)
            XCTAssertEqual(manager.extraLineFragmentRect.height, 20, accuracy: 0.1)
            XCTAssertEqual(manager.usedRect(for: container).height, 61.5, accuracy: 0.1)
        }
    }

    @MainActor func testViewportLayoutMatchesRowsNearStartAndEnd() async throws {
        let lines = (0..<5000).map {
            DiffLine(id: $0, text: "const value_\($0) = \"中文😀\";", kind: "+", old: nil, new: $0 + 1)
        }
        let document = try await DiffTextDocument.prepare(file: DiffFile(path: "viewport.ts", lines: lines))
        let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: 800, height: document.layout.height))
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 800, height: 700))
        scroll.documentView = view
        XCTAssertGreaterThan(view.visibleRect.height, 0)
        XCTAssertLessThanOrEqual(view.visibleRect.height, 700)
        let applyStart = ContinuousClock.now
        view.apply(document)
        let manager = try XCTUnwrap(view.layoutManager)
        let container = try XCTUnwrap(view.textContainer)
        print("差异视口内 apply：\(applyStart.duration(to: .now))，连续已布局字符=\(manager.firstUnlaidCharacterIndex())，总字符=\(document.text.length)")
        XCTAssertLessThan(manager.firstUnlaidCharacterIndex(), document.text.length, "首屏更新不应同步布局整份文档")
        for row in [0, 4950, 2000] {
            let rect = NSRect(x: 0, y: CGFloat(row) * 20, width: 800, height: 700)
            let start = ContinuousClock.now
            manager.ensureLayout(forBoundingRect: rect, in: container)
            let range = manager.glyphRange(forBoundingRect: rect, in: container)
            let elapsed = start.duration(to: .now)
            let characters = manager.characterRange(forGlyphRange: range, actualGlyphRange: nil)
            let visible = (view.string as NSString).substring(with: characters)
            XCTAssertTrue(visible.contains("const value_\(row) ="), "视口应覆盖第 \(row) 行")
            let target = (view.string as NSString).range(of: "const value_\(row) =")
            let glyph = manager.glyphIndexForCharacter(at: target.location)
            XCTAssertEqual(manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minY, CGFloat(row) * 20, accuracy: 0.1)
            print("差异局部布局 row=\(row)：\(elapsed)，视口字形数=\(range.length)，连续已布局字符=\(manager.firstUnlaidCharacterIndex())")
        }
    }

    @MainActor func testFiveThousandRowsRemainOneSelectableDocument() async throws {
        let lines = (0..<5000).map {
            DiffLine(id: $0, text: "const value_\($0) = \"中文😀\";", kind: "+", old: nil, new: $0 + 1)
        }
        let started = ContinuousClock.now
        let document = try await DiffTextDocument.prepare(file: DiffFile(path: "large.ts", lines: lines))
        let prepared = ContinuousClock.now
        let view = DiffSelectionView.make(frame: NSRect(x: 0, y: 0, width: 800, height: document.layout.height))
        let created = ContinuousClock.now
        print("差异视图创建：\(prepared.duration(to: created))")
        view.apply(document)
        let applied = ContinuousClock.now
        let manager = try XCTUnwrap(view.layoutManager)
        let container = try XCTUnwrap(view.textContainer)
        manager.ensureLayout(for: container)
        let laidOut = ContinuousClock.now
        print("差异文档 5000 行：准备=\(started.duration(to: prepared))，存储替换=\(prepared.duration(to: applied))，完整布局=\(applied.duration(to: laidOut))")
        XCTAssertEqual(manager.usedRect(for: container).height, 100000, accuracy: 0.1)
        let source = document.text.string as NSString
        let first = source.range(of: "const value_20 ").location
        let last = source.range(of: "const value_4999 ").location
        let selected = source.substring(with: NSRange(location: first, length: source.length - first))
        XCTAssertGreaterThan(last, first)
        XCTAssertEqual(selected.components(separatedBy: "\n").count, 4980)
        XCTAssertTrue(selected.hasSuffix("const value_4999 = \"中文😀\";"))
    }

    @MainActor func testTextKitRowsMatchPaintedBackgroundsWithoutWrapping() throws {
        let file = DiffFile(path: "code.ts", lines: [
            DiffLine(id: 0, text: "@@ -0,0 +1,2 @@", kind: "@", old: nil, new: nil),
            DiffLine(id: 1, text: String(repeating: "长行😀", count: 100), kind: "+", old: nil, new: 1),
            DiffLine(id: 2, text: "second", kind: "+", old: nil, new: 2),
        ])
        let document = DiffTextDocument(file: file)
        let storage = NSTextStorage(attributedString: document.text)
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 8000, height: 1000))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        var rows: [NSRect] = []
        manager.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: manager.numberOfGlyphs)) { rect, _, _, _, _ in
            rows.append(rect)
        }
        XCTAssertEqual(rows.count, 3)
        for index in rows.indices {
            XCTAssertEqual(rows[index].minY, document.layout.offsets[index], accuracy: 0.1)
            XCTAssertEqual(rows[index].height, document.layout.offsets[index + 1] - document.layout.offsets[index], accuracy: 0.1)
        }
    }
}

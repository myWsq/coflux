import AppKit
import CofluxClientCore
import CofluxProtocol
import ImageIO
import IOSurface
import GhosttyKit
import XCTest
@testable import Coflux

@MainActor
final class TerminalUploadTests: XCTestCase {
    func testClipboardShortcutOnlyTargetsFocusedTerminal() throws {
        final class PasteProbe: GhosttyTerminalView {
            var pasteCount = 0
            override func paste(_ sender: Any?) { pasteCount += 1 }
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        let host = NSView(frame: window.contentLayoutRect)
        let background = PasteProbe(frame: NSRect(x: 0, y: 0, width: 400, height: 600))
        let foreground = PasteProbe(frame: NSRect(x: 400, y: 0, width: 400, height: 600))
        window.contentView = host
        host.addSubview(background); host.addSubview(foreground)
        defer { background.prepareForRemoval(); foreground.prepareForRemoval(); window.orderOut(nil) }
        XCTAssertTrue(window.makeFirstResponder(foreground))
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
            modifierFlags: .command, timestamp: 0, windowNumber: window.windowNumber,
            context: nil, characters: "v", charactersIgnoringModifiers: "v", isARepeat: false, keyCode: 9))
        // AppKit 可向同一窗口中的多个视图查询快捷键，后台终端不能先消费粘贴。
        XCTAssertFalse(background.performKeyEquivalent(with: event))
        XCTAssertEqual(background.pasteCount, 0)
        XCTAssertTrue(foreground.performKeyEquivalent(with: event))
        XCTAssertEqual(foreground.pasteCount, 1)
        XCTAssertTrue(window.makeFirstResponder(background))
        XCTAssertFalse(foreground.performKeyEquivalent(with: event))
        XCTAssertTrue(background.performKeyEquivalent(with: event))
        XCTAssertEqual(background.pasteCount, 1)
        XCTAssertEqual(foreground.pasteCount, 1)
    }

    func testIMECandidateAnchorTracksCursorAndWindowCoordinates() async throws {
        let window = NSWindow(contentRect: NSRect(x: 100, y: 120, width: 900, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        let view = NativeTerminal.configuredView()
        view.frame = NSRect(x: 220, y: 35, width: 640, height: 520)
        window.contentView = host
        host.addSubview(view)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
        defer { view.prepareForRemoval(); window.orderOut(nil) }
        let missing = NSRange(location: NSNotFound, length: 0)
        func anchor() -> NSRect { view.firstRect(forCharacterRange: missing, actualRange: nil) }
        view.feed(text: "\u{1b}[2J\u{1b}[H")
        try await Task.sleep(for: .milliseconds(50))
        let origin = anchor()
        let screenBounds = window.convertToScreen(view.convert(view.bounds, to: nil))
        // 插入点可以是零宽矩形，系统候选窗依赖其位置和行高。
        XCTAssertGreaterThanOrEqual(origin.width, 0)
        XCTAssertGreaterThan(origin.height, 0)
        XCTAssertTrue(screenBounds.insetBy(dx: -1, dy: -1).contains(origin), "候选锚点必须位于有侧栏偏移的终端内")
        view.feed(text: "a")
        try await Task.sleep(for: .milliseconds(50))
        let ascii = anchor()
        let cellWidth = ascii.minX - origin.minX
        XCTAssertGreaterThan(cellWidth, 0)
        XCTAssertEqual(ascii.minY, origin.minY, accuracy: 1)
        view.feed(text: "中")
        try await Task.sleep(for: .milliseconds(50))
        let wide = anchor()
        XCTAssertEqual(wide.minX - ascii.minX, cellWidth * 2, accuracy: 1, "中文宽字符后候选窗应前移两格")
        view.feed(text: "\r\n")
        try await Task.sleep(for: .milliseconds(50))
        let nextLine = anchor()
        XCTAssertEqual(nextLine.minX, origin.minX, accuracy: 1)
        XCTAssertLessThan(nextLine.minY, origin.minY, "AppKit屏幕坐标向上，下一行的候选锚点应向下")
        let previousFrame = window.frame
        window.setFrameOrigin(NSPoint(x: previousFrame.minX + 70, y: previousFrame.minY + 40))
        let moved = anchor()
        XCTAssertEqual(moved.minX - nextLine.minX, 70, accuracy: 1)
        XCTAssertEqual(moved.minY - nextLine.minY, 40, accuracy: 1)
        view.removeFromSuperview()
        XCTAssertEqual(anchor(), .zero, "脱离窗口后不能返回旧屏幕位置")
    }

    func testFocusedWindowTerminalReleasesAfterRemoval() async throws {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        defer { window.orderOut(nil) }
        var view: GhosttyTerminalView? = autoreleasepool { NativeTerminal.configuredView() }
        let reference = WeakTerminalReference(try XCTUnwrap(view))
        autoreleasepool {
            window.contentView = view
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(view)
            view?.feed(text: String(repeating: "release row\r\n", count: 100))
        }
        autoreleasepool {
            view?.prepareForRemoval()
            window.contentView = nil
            view = nil
        }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNil(reference.view, "关闭持焦终端后不能由窗口或输入上下文保留")
    }

    @MainActor private final class WeakTerminalReference {
        weak var view: GhosttyTerminalView?
        init(_ view: GhosttyTerminalView) { self.view = view }
    }

    func testInitialResizeAppliesBeforeRemoteBytes() throws {
        let view = NativeTerminal.configuredView()
        for width in [800.0, 1000.0, 640.0] {
            view.setFrameSize(NSSize(width: width, height: 600))
            view.resetTerminal()
            let prefix = String(repeating: "x", count: view.columns - 2)
            view.feed(text: prefix + "中文链接")
            let selection = ghostty_selection_s(
                top_left: ghostty_point_s(tag: GHOSTTY_POINT_VIEWPORT, coord: GHOSTTY_POINT_COORD_EXACT, x: 0, y: 1),
                bottom_right: ghostty_point_s(tag: GHOSTTY_POINT_VIEWPORT, coord: GHOSTTY_POINT_COORD_EXACT, x: 10, y: 1), rectangle: false)
            let surface = try XCTUnwrap(view.surface)
            var text = ghostty_text_s()
            XCTAssertTrue(ghostty_surface_read_text(surface, selection, &text))
            let row = String(cString: try XCTUnwrap(text.text))
            ghostty_surface_free_text(surface, &text)
            XCTAssertTrue(row.hasPrefix("文链接"), "不能在尺寸生效前按旧列数换行：" + row)
        }
    }

    func testEmptyLayoutPreservesTerminalGrid() throws {
        let view = NativeTerminal.configuredView()
        defer { view.prepareForRemoval() }
        let columns = view.columns, rows = view.rows
        for size in [NSSize.zero, NSSize(width: 800, height: 0), NSSize(width: 0, height: 600)] {
            view.setFrameSize(size)
            XCTAssertEqual(view.columns, columns, "无可见面积的临时布局不能重排终端")
            XCTAssertEqual(view.rows, rows)
        }
        view.setFrameSize(NSSize(width: 640, height: 600))
        XCTAssertLessThan(view.columns, columns, "恢复有效布局后仍须同步真实尺寸")
        view.setFrameSize(NSSize(width: 640, height: 1))
        XCTAssertEqual(view.rows, 1, "有效的单行终端仍然受支持")
    }

    func testSurfaceReplacementDropsOldQueuedCallbacks() async throws {
        let view = NativeTerminal.configuredView()
        var input = Data()
        view.onInput = { input.append($0) }
        view.pasteUploadedPaths("OLD-INPUT")
        view.resetTerminal()
        view.pasteUploadedPaths("NEW-INPUT")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(String(decoding: input, as: UTF8.self), "NEW-INPUT")
        view.pasteUploadedPaths("AFTER-CLOSE")
        view.closeSurface()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(String(decoding: input, as: UTF8.self), "NEW-INPUT", "释放后不能投递旧表面的回调")
    }

    func testLinkOpeningAcceptsCaseInsensitiveWebSchemesAndRejectsOtherTargets() async throws {
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        var opened: [URL] = []
        let coordinator = NativeTerminal.Coordinator(client: client, taskID: "task", onTitle: { _, _ in },
            onUploadState: { _ in }, openURL: { opened.append($0) })
        let view = NativeTerminal.configuredView()
        for link in ["https://example.com/path", "HTTPS://example.com/upper", "HtTp://example.com/mixed",
                     "file:///tmp/example", "javascript:alert(1)", "mailto:a@example.com", "relative/path", "https://"] {
            coordinator.requestOpenLink(source: view, link: link, explicit: false)
        }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(opened.map(\.absoluteString), ["https://example.com/path", "HTTPS://example.com/upper", "HtTp://example.com/mixed"])
    }

    func testExplicitLinkRequiresAcceptanceButPlainURLDoesNot() async throws {
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        var opened: [URL] = []
        var decisions: [(Bool) -> Void] = []
        let coordinator = NativeTerminal.Coordinator(client: client, taskID: "task", onTitle: { _, _ in },
            onUploadState: { _ in }, openURL: { opened.append($0) }, confirmLink: { _, _, decide in decisions.append(decide) })
        let view = NativeTerminal.configuredView()
        view.onOpenLink = { [weak view] link, explicit in
            guard let view else { return }; coordinator.requestOpenLink(source: view, link: link, explicit: explicit)
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        view.feedOutput(Array("\u{1b}]8;;https://example.com/explicit\u{1b}\\CLICK HERE\u{1b}]8;;\u{1b}\\\r\nhttps://example.com/plain".utf8)[...])
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        func click(row: Int) throws {
            let point = view.convert(NSPoint(x: 30, y: 9 + CGFloat(row * 18)), to: nil)
            for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
                let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: 0,
                    windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
                if type == .leftMouseDown { view.mouseDown(with: event) } else { view.mouseUp(with: event) }
            }
        }
        try click(row: 0)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(decisions.count, 1)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(opened.isEmpty)
        try XCTUnwrap(decisions.first)(false)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(opened.isEmpty, "取消不得打开目标")
        try click(row: 0)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(decisions.count, 2)
        try XCTUnwrap(decisions.last)(true)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(opened.map(\.absoluteString), ["https://example.com/explicit"])
        try click(row: 1)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(decisions.count, 2, "普通 URL 不应新增确认")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(opened.last?.absoluteString, "https://example.com/plain")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(decisions.count, 2, "普通链接不能沿用上一次 OSC8 类型")
    }

    func testWrappedWideExplicitLinkRemainsCorrectInScrollback() async throws {
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        var confirmed: [String] = []
        var opened: [URL] = []
        let coordinator = NativeTerminal.Coordinator(client: client, taskID: "task", onTitle: { _, _ in },
            onUploadState: { _ in }, openURL: { opened.append($0) }, confirmLink: { url, _, decide in
                confirmed.append(url.absoluteString); decide(false)
            })
        let view = NativeTerminal.configuredView()
        view.onOpenLink = { [weak view] link, explicit in
            guard let view else { return }; coordinator.requestOpenLink(source: view, link: link, explicit: explicit)
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        let prefix = String(repeating: "x", count: view.columns - 2)
        view.feedOutput(Array((prefix + "\u{1b}]8;;https://example.com/wrapped\u{1b}\\中文链接\u{1b}]8;;\u{1b}\\").utf8)[...])
        func clickContinuation() throws {
            // 第二行第一个宽字符的后半格；必须回查它所属的 OSC8 目标。
            let point = view.convert(NSPoint(x: 10, y: 27), to: nil)
            for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
                let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: 0,
                    windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
                if type == .leftMouseDown { view.mouseDown(with: event) } else { view.mouseUp(with: event) }
            }
        }
        try clickContinuation()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(confirmed, ["https://example.com/wrapped"])
        view.feedOutput(Array(("\r\n" + (0..<80).map { "later \($0)" }.joined(separator: "\r\n")).utf8)[...])
        view.scroll(toPosition: 0)
        try clickContinuation()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(confirmed, ["https://example.com/wrapped", "https://example.com/wrapped"], "历史视口应查询显示缓冲区，不能错用当前输出行")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(opened.isEmpty)
    }

    func testExitedTerminalPreservesOutputUntilExplicitRestart() async throws {
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let coordinator = NativeTerminal.Coordinator(client: client, taskID: "exited-task", onTitle: { _, _ in }, onUploadState: { _ in })
        let view = NativeTerminal.configuredView()
        coordinator.view = view
        coordinator.output.view = view
        defer { coordinator.release() }
        var task = Coflux_V1_Task(); task.id = "exited-task"; task.status = .exited
        view.feedOutput(Array("OLD_SESSION_OUTPUT\u{1b}[?1000h".utf8)[...])
        coordinator.update(task: task, active: false, activationRequest: 0)
        coordinator.update(task: task, active: true, activationRequest: 0)
        XCTAssertFalse(coordinator.starting, "仅切回工作区不应重新启动已退出任务")
        XCTAssertTrue(view.readText().contains("OLD_SESSION_OUTPUT"))
        XCTAssertTrue(view.mouseCaptured)
        coordinator.update(task: task, active: true, activationRequest: 1)
        XCTAssertTrue(coordinator.starting)
        XCTAssertFalse(view.readText().contains("OLD_SESSION_OUTPUT"), "新会话不得混入旧输出")
        XCTAssertFalse(view.mouseCaptured, "重启必须清除旧程序鼠标模式")
    }

    func testProductionTerminalLinkOpensWithoutCommandModifier() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder()
        recorder.connect(view)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        view.feedOutput(Array("https://example.com/path".utf8)[...])
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        let point = view.convert(NSPoint(x: 30, y: view.isFlipped ? 9 : view.bounds.height - 9), to: nil)
        for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: 0,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
            if type == .leftMouseDown { view.mouseDown(with: event) } else { view.mouseUp(with: event) }
        }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(recorder.links, ["https://example.com/path"], "普通点击应与 Web 一样打开检测到的链接")
        for type: NSEvent.EventType in [.leftMouseDown, .leftMouseDragged, .leftMouseUp] {
            let location = type == .leftMouseDown ? point : NSPoint(x: point.x + 40, y: point.y)
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: 1,
                windowNumber: window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 1))
            switch type {
            case .leftMouseDown: view.mouseDown(with: event)
            case .leftMouseDragged: view.mouseDragged(with: event)
            default: view.mouseUp(with: event)
            }
        }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(recorder.links.count, 1, "拖动选择URL不能触发第二次打开")

    }

    func testRightButtonDragReportsPressMotionAndRelease() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder(); recorder.connect(view)
        let window = NSWindow(contentRect: view.bounds, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { view.prepareForRemoval(); window.contentView = nil }
        view.feed(text: "\u{1b}[?1002h\u{1b}[?1006h")
        for (type, x): (NSEvent.EventType, CGFloat) in [(.rightMouseDown, 20), (.rightMouseDragged, 40), (.rightMouseUp, 40)] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: view.convert(NSPoint(x: x, y: 9), to: nil),
                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
            switch type {
            case .rightMouseDown: view.rightMouseDown(with: event)
            case .rightMouseDragged: view.rightMouseDragged(with: event)
            default: view.rightMouseUp(with: event)
            }
        }
        try await Task.sleep(for: .milliseconds(30))
        let report = String(decoding: recorder.bytes, as: UTF8.self)
        XCTAssertTrue(report.contains("\u{1b}[<2;"), report.debugDescription)
        XCTAssertTrue(report.contains("\u{1b}[<34;"), report.debugDescription)
        XCTAssertTrue(report.hasSuffix("m"), report.debugDescription)
    }

    func testMouseDragCreatesTextSelection() async throws {
        let view = NativeTerminal.configuredView()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        view.feed(text: "selection-hello")
        for (type, x): (NSEvent.EventType, CGFloat) in [(.leftMouseDown, 2), (.leftMouseDragged, 150), (.leftMouseUp, 150)] {
            let point = view.convert(NSPoint(x: x, y: 9), to: nil)
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: 1, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
            switch type {
            case .leftMouseDown: view.mouseDown(with: event)
            case .leftMouseDragged: view.mouseDragged(with: event)
            default: view.mouseUp(with: event)
            }
        }
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(view.selectedText()?.trimmingCharacters(in: .whitespacesAndNewlines), "selection-hello")
    }

    func testShiftDragSelectsLocallyAcrossMouseReportingModes() async throws {
        for mode in [1000, 1002, 1003] {
            let view = NativeTerminal.configuredView()
            let recorder = Recorder(); recorder.connect(view)
            let window = NSWindow(contentRect: view.bounds, styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = view
            defer { view.prepareForRemoval(); window.contentView = nil }
            view.feed(text: "selection-中文😀\u{1b}[?\(mode)h\u{1b}[?1006h")
            func drag(_ modifiers: NSEvent.ModifierFlags) throws {
                for (type, x): (NSEvent.EventType, CGFloat) in [(.leftMouseDown, 2), (.leftMouseDragged, 200), (.leftMouseUp, 200)] {
                    let event = try XCTUnwrap(NSEvent.mouseEvent(with: type,
                        location: view.convert(NSPoint(x: x, y: 9), to: nil), modifierFlags: modifiers,
                        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                        context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
                    switch type {
                    case .leftMouseDown: view.mouseDown(with: event)
                    case .leftMouseDragged: view.mouseDragged(with: event)
                    default: view.mouseUp(with: event)
                    }
                }
            }
            try drag([])
            try await Task.sleep(for: .milliseconds(30))
            XCTAssertTrue(String(decoding: recorder.bytes, as: UTF8.self).contains("\u{1b}[<0;"), "模式\(mode)普通拖动须交给应用")
            XCTAssertNil(view.selectedText())
            recorder.bytes.removeAll()
            try drag(.shift)
            try await Task.sleep(for: .milliseconds(30))
            let reports = String(decoding: recorder.bytes, as: UTF8.self)
            if mode == 1003 {
                // 全移动报告包含按下前的悬停；Shift只绕过选择手势，不吞掉悬停移动。
                let frames = reports.components(separatedBy: "\u{1b}[<").filter { !$0.isEmpty }
                XCTAssertTrue(frames.allSatisfy { $0.hasPrefix("39;") && $0.hasSuffix("M") }, reports.debugDescription)
            } else {
                XCTAssertTrue(recorder.bytes.isEmpty, "模式\(mode)的Shift选区不能向应用发送鼠标事件")
            }
            XCTAssertEqual(view.selectedText()?.trimmingCharacters(in: .whitespacesAndNewlines), "selection-中文😀")
            XCTAssertTrue(view.mouseCaptured, "本地选择不应关闭应用的鼠标模式")
        }
    }

    func testMouseReportingReceivesReleaseOverURL() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder(); recorder.connect(view)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        view.feedOutput(Array("https://example.com/path\u{1b}[?1000h\u{1b}[?1006h".utf8)[...])
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        let point = view.convert(NSPoint(x: 30, y: view.isFlipped ? 9 : view.bounds.height - 9), to: nil)
        for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: 0,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
            if type == .leftMouseDown { view.mouseDown(with: event) } else { view.mouseUp(with: event) }
        }
        try await Task.sleep(for: .milliseconds(20))
        let output = String(decoding: recorder.bytes, as: UTF8.self)
        XCTAssertTrue(output.contains("\u{1b}[<0;"), "SGR鼠标按下应发送给终端程序")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(output.hasSuffix("m"), "URL不能吞掉鼠标松开报告: " + output.debugDescription)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(recorder.links.isEmpty, "鼠标报告模式不能在点击时打开URL")
    }

    func testExplicitLinkAndShiftBypassMouseReporting() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder(); recorder.connect(view)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        view.feedOutput(Array("\u{1b}]8;;https://example.com/explicit\u{1b}\\CLICK HERE\u{1b}]8;;\u{1b}\\".utf8)[...])
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        let point = view.convert(NSPoint(x: 30, y: view.isFlipped ? 9 : view.bounds.height - 9), to: nil)
        func click(_ modifiers: NSEvent.ModifierFlags) throws {
            for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
                let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: modifiers, timestamp: 0,
                    windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
                if type == .leftMouseDown { view.mouseDown(with: event) } else { view.mouseUp(with: event) }
            }
        }
        try click([])
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(recorder.links, ["https://example.com/explicit"], "OSC8标签应打开实际目标而非显示文字")
        recorder.links.removeAll(); recorder.bytes.removeAll()
        view.feedOutput(Array("\u{1b}[?1000h\u{1b}[?1006h".utf8)[...])
        try click([])
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(recorder.links.isEmpty)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(String(decoding: recorder.bytes, as: UTF8.self).hasSuffix("m"))
        recorder.bytes.removeAll()
        try click(.shift)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(recorder.bytes.isEmpty, "Shift默认绕过终端鼠标报告")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(recorder.links, ["https://example.com/explicit"])
    }

    func testWindowFocusReportsOnlyForItsFirstResponder() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder(); recorder.connect(view)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(window.makeFirstResponder(view))
        view.feedOutput(Array("\u{1b}[?1004h".utf8)[...])
        try await Task.sleep(for: .milliseconds(20)) // 启用模式会立即报告当前焦点，先消费该报告。
        recorder.bytes.removeAll()
        window.becomeKey()
        window.resignKey()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(String(decoding: recorder.bytes, as: UTF8.self), "\u{1b}[I\u{1b}[O", "窗口激活/失活必须报告给持焦终端")
        recorder.bytes.removeAll()
        let other = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        other.becomeKey(); other.resignKey()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(recorder.bytes.isEmpty, "其他窗口不能触发本终端焦点报告")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(window.makeFirstResponder(nil))
        recorder.bytes.removeAll()
        window.becomeKey(); window.resignKey()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(recorder.bytes.isEmpty, "非第一响应者终端不能收到窗口焦点报告")
    }

    func testOptionCharacterInputUsesMacCharacterInsteadOfMetaSequence() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder(); recorder.connect(view)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(window.makeFirstResponder(view))
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .option,
            timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "ƒ",
            charactersIgnoringModifiers: "f", isARepeat: false, keyCode: 3))
        view.keyDown(with: event)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(String(decoding: recorder.bytes, as: UTF8.self), "ƒ", "Option字符应交给macOS输入，不能变成ESC+f")
    }

    func testProductionControlAndCursorKeysPreserveTerminalSequences() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder(); recorder.connect(view)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(window.makeFirstResponder(view))
        func send(_ characters: String, bare: String, code: UInt16, modifiers: NSEvent.ModifierFlags = []) async throws -> String {
            recorder.bytes.removeAll()
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
                timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: characters,
                charactersIgnoringModifiers: bare, isARepeat: false, keyCode: code))
            view.keyDown(with: event)
            try await Task.sleep(for: .milliseconds(20))
            return String(decoding: recorder.bytes, as: UTF8.self)
        }
        try await Task.sleep(for: .milliseconds(20))
        let keyResult17825 = try await send("\u{3}", bare: "c", code: 8, modifiers: .control)
        XCTAssertEqual(keyResult17825, "\u{3}")
        try await Task.sleep(for: .milliseconds(20))
        let keyResult17970 = try await send("\u{f702}", bare: "\u{f702}", code: 123)
        XCTAssertEqual(keyResult17970, "\u{1b}[D")
        try await Task.sleep(for: .milliseconds(20))
        let keyResult18109 = try await send("\u{f703}", bare: "\u{f703}", code: 124)
        XCTAssertEqual(keyResult18109, "\u{1b}[C")
        view.feedOutput(Array("\u{1b}[?1h".utf8)[...])
        try await Task.sleep(for: .milliseconds(20))
        let keyResult18304 = try await send("\u{f702}", bare: "\u{f702}", code: 123)
        XCTAssertEqual(keyResult18304, "\u{1b}OD", "应用光标模式必须保留")
    }

    func testSelectionPreservesANSIForegroundInRenderedPixels() async throws {
        let view = NativeTerminal.configuredView()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 160), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        view.feedOutput(Array("\u{1b}[31m████ 红色\u{1b}[32m████ 绿色\u{1b}[0m 中文\r\n".utf8)[...])
        func render() throws -> NSBitmapImageRep {
            window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
            return try metalBitmap(view)
        }
        func coloredPixels(_ bitmap: NSBitmapImageRep) -> (red: Int, green: Int) {
            var red = 0, green = 0
            for y in 0..<bitmap.pixelsHigh {
                for x in 0..<bitmap.pixelsWide {
                    guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                    if color.redComponent > 0.65 && color.redComponent > color.greenComponent * 1.5 { red += 1 }
                    if color.greenComponent > 0.5 && color.greenComponent > color.redComponent * 1.4 { green += 1 }
                }
            }
            return (red, green)
        }
        try await Task.sleep(for: .milliseconds(50))
        let original = try render()
        let before = coloredPixels(original)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertGreaterThan(before.red, 50); XCTAssertGreaterThan(before.green, 50)
        view.selectAll(nil)
        try await Task.sleep(for: .milliseconds(50))
        let selected = try render()
        let after = coloredPixels(selected)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertGreaterThan(after.red, 50); XCTAssertGreaterThan(after.green, 50)
        let png = try XCTUnwrap(selected.representation(using: .png, properties: [:]))
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertNotEqual(png, original.representation(using: .png, properties: [:]), "确实绘制了选区背景")
        try png.write(to: URL(fileURLWithPath: "/tmp/coflux-terminal-selection-colors.png"))
        // 负向对照：恢复上游强制前景色，确认测试真的覆盖选区绘制分支。
        try forceSelectionForeground(view, color: "ffffff")
        try await Task.sleep(for: .milliseconds(50))
        let forced = coloredPixels(try render())
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertLessThan(forced.red, 5); XCTAssertLessThan(forced.green, 5)
    }

    func testProductionTerminalPaletteSnapshot() async throws {
        let view = NativeTerminal.configuredView()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 420), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        var sample = "coflux 原生终端 · 中文与 emoji 😀\r\n\r\n"
        for index in 0..<8 {
            sample += "\u{1b}[\(30 + index)m████ 普通 \(index)\u{1b}[0m    \u{1b}[\(90 + index)m████ 高亮 \(index + 8)\u{1b}[0m\r\n"
        }
        sample += "\r\n\u{1b}[1m粗体 Bold\u{1b}[0m  \u{1b}[4m下划线 underline\u{1b}[0m  \u{1b}[38;2;255;128;64m真彩色 RGB\u{1b}[0m\r\n"
        sample += "\r\n$ git status\r\nOn branch main\r\n"
        view.feedOutput(Array(sample.utf8)[...])
        try await Task.sleep(for: .milliseconds(80))
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        let bitmap = try metalBitmap(view)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: "/tmp/coflux-terminal-palette.png"))
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = "生产终端16色和文字样本"; attachment.lifetime = .keepAlways; add(attachment)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(view.readText().contains("On branch main"))
    }

    func testProductionPaletteAnswersANSIColorQueries() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder()
        recorder.connect(view)
        let expected = ["1a1a/1a1a/1a1a", "e0e0/5c5c/6a6a", "4f4f/aeae/6e6e", "c9c9/a2a2/2727",
                        "6b6b/9b9b/d1d1", "b0b0/7c7c/c6c6", "5656/b6b6/c2c2", "d4d4/d4d4/d4d4",
                        "6a6a/6a6a/6a6a", "efef/2929/2929", "8a8a/e2e2/3434", "fcfc/e9e9/4f4f",
                        "7272/9f9f/cfcf", "adad/7f7f/a8a8", "3434/e2e2/e2e2", "eeee/eeee/ecec"]
        for (index, rgb) in expected.enumerated() {
            recorder.bytes.removeAll()
            view.feedOutput(Array("\u{1b}]4;\(index);?\u{1b}\\".utf8)[...])
            try await Task.sleep(for: .milliseconds(20))
            XCTAssertTrue(String(decoding: recorder.bytes, as: UTF8.self).lowercased().contains("rgb:" + rgb), "ANSI \(index)")
        }
    }

    func testProductionTerminalRetainsWebSizedHistory() async throws {
        let view = NativeTerminal.configuredView()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(view.rows, 34, "Ghostty 保留 17.5pt 栅格，与 Web 行高一致；不沿用旧库向上取整到 18pt")
        let first = "history-first\r\n" + (0..<900).map { "line-\($0)\r\n" }.joined()
        view.feedOutput(Array(first.utf8)[...])
        func contents() -> String { view.readText() }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(contents().contains("history-first"), "历史不能在默认500行后被淘汰")
        let rest = (900..<11_000).map { "line-\($0)\r\n" }.joined()
        view.feedOutput(Array(rest.utf8)[...])
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertFalse(contents().contains("history-first"), "历史容量仍应有界")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(contents().contains("line-10999"))
    }

    func testOldUploadCompletionCannotClearNewSessionUploadState() async throws {
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        defer { client.logout() }
        var states: [Bool] = []
        let coordinator = NativeTerminal.Coordinator(client: client, taskID: "task", onTitle: { _, _ in }, onUploadState: { states.append($0) })
        let view = GhosttyTerminalView(frame: .zero)
        coordinator.view = view
        var task = Coflux_V1_Task(); task.id = "task"; task.sessionID = "old-session"; task.status = .exited
        coordinator.update(task: task, active: false, activationRequest: 0)
        var oldResume: CheckedContinuation<Void, Never>?
        var newResume: CheckedContinuation<Void, Never>?
        defer { oldResume?.resume(); newResume?.resume(); coordinator.release() }
        // 模拟不立即响应取消的网络操作，精确控制旧、新上传的完成顺序。
        coordinator.startUpload { await withCheckedContinuation { oldResume = $0 } }
        let oldUpload = try XCTUnwrap(coordinator.uploadTask)
        for _ in 0..<1000 { if oldResume != nil { break }; await Task.yield() }
        XCTAssertNotNil(oldResume)
        task.sessionID = "new-session"
        coordinator.update(task: task, active: false, activationRequest: 0)
        XCTAssertTrue(oldUpload.isCancelled)
        XCTAssertNil(coordinator.uploadTask, "取消必须立即释放新会话的上传资格")
        XCTAssertEqual(states, [true], "视图更新中不能同步回写界面忙态")
        coordinator.startUpload { await withCheckedContinuation { newResume = $0 } }
        let newUpload = try XCTUnwrap(coordinator.uploadTask)
        for _ in 0..<1000 { if newResume != nil { break }; await Task.yield() }
        XCTAssertNotNil(newResume)
        oldResume?.resume(); oldResume = nil
        await oldUpload.value
        XCTAssertNotNil(coordinator.uploadTask)
        XCTAssertFalse(newUpload.isCancelled)
        XCTAssertEqual(states, [true, true], "延迟取消通知和旧上传收尾都不能清除新上传忙态")
        newResume?.resume(); newResume = nil
        await newUpload.value
        XCTAssertNil(coordinator.uploadTask)
        XCTAssertEqual(states, [true, true, false])
    }

    func testReleaseDefersUploadNotificationAndRepeatedReleaseStillClearsIt() async throws {
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        defer { client.logout() }
        var states: [Bool] = []
        let coordinator = NativeTerminal.Coordinator(client: client, taskID: "task", onTitle: { _, _ in }, onUploadState: { states.append($0) })
        coordinator.startUpload { XCTFail("释放发生在任务启动前，不应执行上传") }
        let upload = try XCTUnwrap(coordinator.uploadTask)
        coordinator.release()
        coordinator.release()
        XCTAssertTrue(upload.isCancelled)
        XCTAssertNil(coordinator.uploadTask)
        XCTAssertEqual(states, [true], "卸载回调中不能同步修改 SwiftUI 状态")
        await upload.value
        for _ in 0..<1000 { if states.count == 2 { break }; await Task.yield() }
        XCTAssertEqual(states, [true, false], "重复释放不能使待发送的清理通知失效")
    }

    func testSessionReplacementCancelsUploadButOrdinaryUpdateDoesNot() async throws {
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        defer { client.logout() }
        let coordinator = NativeTerminal.Coordinator(client: client, taskID: "task", onTitle: { _, _ in }, onUploadState: { _ in })
        let view = GhosttyTerminalView(frame: .zero)
        coordinator.view = view
        defer { coordinator.release() }
        var task = Coflux_V1_Task(); task.id = "task"; task.sessionID = "old-session"; task.status = .exited
        coordinator.update(task: task, active: false, activationRequest: 0)
        let upload = Task { try? await Task.sleep(for: .seconds(30)) }
        coordinator.uploadTask = Task { await upload.value }
        // 使用能观察取消状态的真实任务句柄，不启动网络上传。
        let pending = try XCTUnwrap(coordinator.uploadTask)
        defer { upload.cancel(); pending.cancel() }
        coordinator.pendingPaste = " /tmp/old-upload "
        coordinator.update(task: task, active: false, activationRequest: 0)
        XCTAssertFalse(pending.isCancelled, "同一会话普通刷新不能取消上传")
        XCTAssertEqual(coordinator.pendingPaste, " /tmp/old-upload ")
        task.sessionID = "new-session"
        coordinator.update(task: task, active: false, activationRequest: 0)
        XCTAssertTrue(pending.isCancelled)
        XCTAssertEqual(coordinator.sessionID, "new-session")
        XCTAssertEqual(coordinator.pendingPaste, "", "旧路径不能带入新会话")
        upload.cancel()
        await pending.value
    }

    func testDragOverlayClearsWhenPermissionOrPasteboardChanges() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.writeObjects([URL(fileURLWithPath: "/tmp/coflux-drag-test.txt") as NSURL])
        let view = UploadTerminalView(frame: .zero)
        var allowed = true
        var states: [Bool] = []
        view.canUpload = { allowed }
        view.onDragState = { states.append($0) }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(view.updateDragOperation(for: board), .copy)
        allowed = false
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(view.updateDragOperation(for: board), [])
        allowed = true
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(view.updateDragOperation(for: board), .copy)
        board.clearContents()
        board.setString("不是文件", forType: .string)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(view.updateDragOperation(for: board), [])
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(states, [true, false, true, false])
    }

    func testBackgroundPreparationReceivesParentCancellation() async throws {
        let (started, signal) = AsyncStream<Bool>.makeStream()
        let resume = DispatchSemaphore(value: 0)
        let request = Task {
            try await BackgroundPreparation.run {
                signal.yield(false)
                // 只阻塞被测后台工作，主线程通过异步信号等待；上限避免失败时遗留线程。
                guard resume.wait(timeout: .now() + 5) == .success else { throw URLError(.timedOut) }
                signal.yield(Task.isCancelled)
                try Task.checkCancellation()
                return 42
            }
        }
        var iterator = started.makeAsyncIterator()
        await iterator.next()
        request.cancel()
        resume.signal()
        do {
            _ = try await request.value
            XCTFail("关闭上传方后，后台准备不能返回成功结果")
        } catch is CancellationError {
            // 取消确实传到后台任务的协作检查。
        }
        let backgroundCancelled = await iterator.next()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(backgroundCancelled, true, "必须取消后台任务本身，不能只丢弃返回值")
        signal.finish()
    }

    func testInputClientSelectionDoesNotRetainPreviousComposition() throws {
        let view = NativeTerminal.configuredView()
        let missing = NSRange(location: NSNotFound, length: 0)
        XCTAssertEqual(view.selectedRange(), missing)
        view.setMarkedText("你好😀", selectedRange: NSRange(location: 2, length: 2), replacementRange: missing)
        XCTAssertEqual(view.selectedRange(), NSRange(location: 2, length: 2))
        view.unmarkText()
        XCTAssertEqual(view.selectedRange(), missing, "取消后不能返回上一轮候选选区")
        view.setMarkedText("nihao", selectedRange: NSRange(location: 5, length: 0), replacementRange: missing)
        view.insertText("你好", replacementRange: missing)
        XCTAssertEqual(view.selectedRange(), missing, "提交后不能返回上一轮拼音位置")
        view.setMarkedText("reset", selectedRange: NSRange(location: 5, length: 0), replacementRange: missing)
        view.resetTerminal()
        XCTAssertFalse(view.hasMarkedText())
        XCTAssertEqual(view.selectedRange(), missing, "重连快照重建后不能保留候选位置")
        view.feed(text: "terminal selection")
        view.selectAll(nil)
        XCTAssertNotNil(view.selectedText())
        XCTAssertNotEqual(view.selectedRange().location, NSNotFound)
        XCTAssertGreaterThan(view.selectedRange().length, 0, "系统文本服务应取得真实终端选区")
        view.prepareForRemoval()
        XCTAssertEqual(view.selectedRange(), missing)
    }

    func testAttributedIMECommitSendsOnceAndClearsMarkedText() async throws {
        let view = UploadTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
        let recorder = Recorder()
        recorder.connect(view)
        let missing = NSRange(location: NSNotFound, length: 0)
        view.setMarkedText(NSAttributedString(string: "nihao"), selectedRange: NSRange(location: 5, length: 0), replacementRange: missing)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(view.hasMarkedText())
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(recorder.bytes.isEmpty, "组合阶段不能把候选文本发送到 PTY")
        view.insertText(NSAttributedString(string: "你好😀"), replacementRange: missing)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(String(decoding: recorder.bytes, as: UTF8.self), "你好😀")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertFalse(view.hasMarkedText())
        view.insertText("后续" as NSString, replacementRange: missing)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(String(decoding: recorder.bytes, as: UTF8.self), "你好😀后续")
    }

    func testIMECompositionUpdatesAndCancellationDoNotLeakText() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder(); recorder.connect(view)
        let missing = NSRange(location: NSNotFound, length: 0)
        for draft in ["n", "ni", "你好😀"] {
            let length = (draft as NSString).length
            view.setMarkedText(NSAttributedString(string: draft), selectedRange: NSRange(location: length, length: 0), replacementRange: missing)
            try await Task.sleep(for: .milliseconds(20))
            XCTAssertTrue(view.hasMarkedText())
            try await Task.sleep(for: .milliseconds(20))
            XCTAssertEqual(view.markedRange(), NSRange(location: 0, length: length))
            var actual = missing
            let marked = view.attributedSubstring(forProposedRange: NSRange(location: 0, length: length + 5), actualRange: &actual)
            try await Task.sleep(for: .milliseconds(20))
            XCTAssertEqual(marked?.string, draft)
            try await Task.sleep(for: .milliseconds(20))
            XCTAssertEqual(actual, NSRange(location: 0, length: length), "范围必须按UTF16截断，不能拆开emoji")
            try await Task.sleep(for: .milliseconds(20))
            XCTAssertTrue(recorder.bytes.isEmpty)
        }
        view.unmarkText()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertFalse(view.hasMarkedText())
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(recorder.bytes.isEmpty, "取消组合不能提交最后候选")
        view.setMarkedText("zaijian" as NSString, selectedRange: NSRange(location: 7, length: 0), replacementRange: missing)
        view.insertText(NSAttributedString(string: "再见"), replacementRange: missing)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(String(decoding: recorder.bytes, as: UTF8.self), "再见", "新一轮输入不得夹带取消的文本")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertFalse(view.hasMarkedText())
    }

    func testOutputBlockCoalescesScrollerAndPreservesManualScroll() async throws {
        let view = NativeTerminal.configuredView()
        let recorder = Recorder(); recorder.connect(view)
        let bytes = Array((0..<150).map { "line-\($0)\r\n" }.joined().utf8)
        view.feedOutput(bytes[...])
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertFalse(recorder.scrollPositions.isEmpty, "输出后应更新滚动位置")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(recorder.scrollPositions.last, view.scrollPosition)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(view.readText().contains("line-149"))
        recorder.scrollPositions.removeAll()
        view.scroll(toPosition: 0)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertFalse(recorder.scrollPositions.isEmpty, "主动滚动必须立即通知")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(view.scrollPosition, 0, accuracy: 0.001)
        view.feedOutput(Array("new-output\r\n".utf8)[...])
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(view.scrollPosition, 0, accuracy: 0.001, "历史视口不能被输出强制拉到底部")
    }

    func testUploadedPathsRespectBracketedPasteMode() async throws {
        let view = GhosttyTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
        let recorder = Recorder()
        recorder.connect(view)
        view.pasteUploadedPaths(" /tmp/upload.txt ")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(String(decoding: recorder.bytes, as: UTF8.self), " /tmp/upload.txt ")
        recorder.bytes.removeAll()
        view.feedOutput(Array("\u{1b}[?2004h".utf8)[...])
        view.pasteUploadedPaths(" /tmp/upload.txt ")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(String(decoding: recorder.bytes, as: UTF8.self), "\u{1b}[200~ /tmp/upload.txt \u{1b}[201~")

        // shell/编辑器需要把多行作为一次粘贴处理，不能丢失中文或内部换行。
        recorder.bytes.removeAll()
        let multiline = "第一行 😀\nsecond line\n"
        view.pasteUploadedPaths(multiline)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(String(decoding: recorder.bytes, as: UTF8.self), "\u{1b}[200~" + multiline + "\u{1b}[201~")

        // 程序退出并关闭模式后，后续粘贴不能继续携带旧模式的包装。
        recorder.bytes.removeAll()
        view.feedOutput(Array("\u{1b}[?2004l".utf8)[...])
        view.pasteUploadedPaths(multiline)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(String(decoding: recorder.bytes, as: UTF8.self), "第一行 😀\rsecond line\r")
    }

    func testFileLimitsAndDirectories() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertNil(try UploadPreparation.file(root))
        let file = root.appendingPathComponent("too-large.bin")
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: UInt64(UploadPreparation.fileLimit + 1))
        try handle.close()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertThrowsError(try UploadPreparation.file(file))
    }

    func testTiffBecomesDecodableImageWithinBudget() async throws {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 512, pixelsHigh: 512,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let bytes = try XCTUnwrap(bitmap.representation(using: .tiff, properties: [:]))
        let prepared = try UploadPreparation.image(bytes, type: "public.tiff")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertLessThanOrEqual(prepared.data.count, UploadPreparation.imageBudget)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(prepared.data as CFData, nil))
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertNotNil(CGImageSourceCreateImageAtIndex(source, 0, nil))
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(prepared.name.hasSuffix(".png"))
    }

    func testReencodedImageAppliesOrientationMetadata() async throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 120, height: 80, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 120, height: 80))
        let bitmap = try XCTUnwrap(context.makeImage())
        let bytes = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(bytes, "public.tiff" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, bitmap, [kCGImagePropertyOrientation: 6] as CFDictionary)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual((properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue, 6)

        let prepared = try UploadPreparation.image(bytes as Data, type: "public.tiff")
        let uploadedSource = try XCTUnwrap(CGImageSourceCreateWithData(prepared.data as CFData, nil))
        let uploaded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(uploadedSource, 0, nil))
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(uploaded.width, 80)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(uploaded.height, 120)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(prepared.name.hasSuffix(".png"))
    }

    func testLargeOrientedImageCompressesWithinBudget() async throws {
        let width = 1800, height = 1200
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        var seed: UInt32 = 93
        for index in pixels.indices where index % 4 != 3 {
            seed = seed &* 1664525 &+ 1013904223
            pixels[index] = UInt8(truncatingIfNeeded: seed >> 24)
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        let bitmap = try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let bytes = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(bytes, "public.jpeg" as CFString, 1, nil))
        let metadata: [CFString: Any] = [kCGImagePropertyOrientation: 6,
                                       kCGImageDestinationLossyCompressionQuality: 1.0]
        CGImageDestinationAddImage(destination, bitmap, metadata as CFDictionary)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertGreaterThan(bytes.length, UploadPreparation.imageBudget, "样例必须实际进入压缩路径")
        let inputSource = try XCTUnwrap(CGImageSourceCreateWithData(bytes, nil))
        let inputProperties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(inputSource, 0, nil) as? [CFString: Any])
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual((inputProperties[kCGImagePropertyOrientation] as? NSNumber)?.intValue, 6)

        let prepared = try UploadPreparation.image(bytes as Data, type: "public.jpeg")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertLessThanOrEqual(prepared.data.count, UploadPreparation.imageBudget)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(prepared.data as CFData, nil))
        let uploaded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(uploaded.width, height)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(uploaded.height, width)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(prepared.name.hasSuffix(".jpg"))
    }

    @MainActor private final class Recorder {
        var bytes = Data()
        var links: [String] = []
        var scrollPositions: [Double] = []
        func connect(_ view: GhosttyTerminalView) {
            view.onInput = { [weak self] in self?.bytes.append($0) }
            view.onOpenLink = { [weak self] link, _ in self?.links.append(link) }
            view.onScroll = { [weak self] in self?.scrollPositions.append($0) }
        }
    }
    private func metalBitmap(_ view: GhosttyTerminalView) throws -> NSBitmapImageRep {
        // 读取 Ghostty 已完成呈现的 IOSurface，不截取桌面或其他应用。
        let content = try XCTUnwrap(view.layer?.contents)
        let object = content as CFTypeRef
        XCTAssertEqual(CFGetTypeID(object), IOSurfaceGetTypeID())
        let surface = unsafeBitCast(object, to: IOSurfaceRef.self)
        XCTAssertEqual(IOSurfaceLock(surface, .readOnly, nil), kIOReturnSuccess)
        defer { IOSurfaceUnlock(surface, .readOnly, nil) }
        let width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface)
        let stride = IOSurfaceGetBytesPerRow(surface)
        let pointer = try XCTUnwrap(IOSurfaceGetBaseAddress(surface))
        let bytes = Data(bytes: pointer, count: stride * height)
        let provider = try XCTUnwrap(CGDataProvider(data: bytes as CFData))
        let color = try XCTUnwrap(CGColorSpace(name: CGColorSpace.displayP3))
        let image = try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: stride, space: color,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue).union(.byteOrder32Little),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        return NSBitmapImageRep(cgImage: image)
    }
    private func forceSelectionForeground(_ view: GhosttyTerminalView, color: String) throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let base = try String(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "terminal", withExtension: "conf")), encoding: .utf8)
        try (base + "\nselection-foreground = " + color + "\n").write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }
        let config = try XCTUnwrap(ghostty_config_new())
        defer { ghostty_config_free(config) }
        url.path.withCString { ghostty_config_load_file(config, $0) }
        ghostty_config_finalize(config)
        ghostty_surface_update_config(try XCTUnwrap(view.surface), config)
    }
}

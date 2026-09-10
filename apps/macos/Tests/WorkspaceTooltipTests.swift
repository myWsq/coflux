import AppKit
import CofluxProtocol
import SwiftUI
import XCTest
@testable import Coflux

@MainActor final class WorkspaceTooltipTests: XCTestCase {
    private func content(long: Bool = false) -> WorkspaceTooltipContent {
        var workspace = Coflux_V1_Workspace(); workspace.id = "w"; workspace.branch = "feature/native"
        workspace.name = "原生客户端"; workspace.path = "/work/coflux/native"; workspace.additions = 3; workspace.deletions = 2
        var project = Coflux_V1_Project(); project.defaultBranch = "main"
        var daemon = Coflux_V1_DaemonInfo(); daemon.name = "本机开发设备"; daemon.online = true
        var activity = WorkspaceActivity(workspaceID: "w", online: true, tasks: [], agents: [:])
        activity.state = "question"; activity.agent = "claude"
        activity.message = long ? String(repeating: "中文长留言😀需要完整阅读", count: 16) : "请选择方案\n保留现有工作区？"
        activity.progress = "正在验证原生终端，保留中文 😀"
        return WorkspaceTooltipContent(workspace: workspace, project: project, daemon: daemon, activity: activity)
    }
    func testSwiftUIRowAnchorAndContentUpdatesKeepPanelStable() async throws {
        let host = NSHostingView(rootView: VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 80)
            Text("工作区").frame(width: 240, height: 28)
                .modifier(SidebarDetailTooltip(tooltip: WorkbenchTooltipContent(text: "工作区详情")))
            Spacer(minLength: 0)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading))
        let window = NSWindow(contentRect: CGRect(x: 200, y: 200, width: 800, height: 600),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(100))
        window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
        func find(_ view: NSView) -> NativeTooltipAnchor? {
            if let anchor = view as? NativeTooltipAnchor { return anchor }
            return view.subviews.lazy.compactMap(find).first
        }
        let anchor = try XCTUnwrap(find(host))
        anchor.present()
        let panel = try XCTUnwrap(anchor.panel)
        let expected = window.convertToScreen(host.convert(host.bounds, to: nil))
        XCTAssertEqual(panel.frame.midY, expected.maxY - 94, accuracy: 1, "提示应贴着实际SwiftUI行，而非非翻转容器的镜像位置")
        let originalFrame = panel.frame
        let originalHost = panel.contentView
        try await Task.sleep(for: .milliseconds(200))
        anchor.update(AnyView(WorkbenchTooltipContent(text: "工作区详情")))
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(panel.contentView === originalHost, "数据刷新不能重建悬停容器")
        XCTAssertEqual(panel.frame, originalFrame)
        XCTAssertNil(panel.contentView?.layer?.animation(forKey: "tooltip.enter"), "刷新不能重播入场动画")
        anchor.update(AnyView(WorkbenchTooltipContent(text: String(repeating: "动态详情\n", count: 6))))
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(panel.contentView === originalHost)
        XCTAssertEqual(panel.frame.midY, expected.maxY - 94, accuracy: 1, "内容高度变化也必须继续对准同一行")
        anchor.dismiss()
    }
    func testDefaultTooltipAppearsAboveAndFlipsAtWindowTop() {
        let visible = CGRect(x: 100, y: 100, width: 1000, height: 700)
        let ordinary = NativeTooltipAnchor.placement(anchor: CGRect(x: 400, y: 400, width: 100, height: 28),
            size: CGSize(width: 200, height: 60), visible: visible, above: true)
        XCTAssertEqual(ordinary, CGRect(x: 350, y: 432, width: 200, height: 60))
        let top = NativeTooltipAnchor.placement(anchor: CGRect(x: 400, y: 750, width: 100, height: 28),
            size: CGSize(width: 200, height: 60), visible: visible, above: true)
        XCTAssertEqual(top.minY, 686)
    }
    func testPlacementFlipsAndStaysWithinWindow() {
        let visible = CGRect(x: 100, y: 100, width: 1000, height: 700)
        let left = NativeTooltipAnchor.placement(anchor: CGRect(x: 120, y: 400, width: 240, height: 28), size: CGSize(width: 300, height: 180), visible: visible)
        XCTAssertEqual(left.minX, 364)
        let right = NativeTooltipAnchor.placement(anchor: CGRect(x: 1000, y: 750, width: 90, height: 28), size: CGSize(width: 300, height: 180), visible: visible)
        XCTAssertEqual(right.maxX, 996)
        XCTAssertTrue(visible.contains(right))
        let bottom = NativeTooltipAnchor.placement(anchor: CGRect(x: 120, y: 100, width: 240, height: 28), size: CGSize(width: 300, height: 180), visible: visible)
        XCTAssertEqual(bottom.minY, 104)
    }
    func testBelowPlacementFlipsAtBottomAndClampsAtRightEdge() {
        let visible = CGRect(x: 100, y: 100, width: 1000, height: 700)
        let top = NativeTooltipAnchor.placement(anchor: CGRect(x: 400, y: 750, width: 100, height: 28),
                                               size: CGSize(width: 200, height: 60), visible: visible, below: true)
        XCTAssertEqual(top, CGRect(x: 350, y: 686, width: 200, height: 60))
        let bottom = NativeTooltipAnchor.placement(anchor: CGRect(x: 1040, y: 105, width: 50, height: 28),
                                                  size: CGSize(width: 200, height: 60), visible: visible, below: true)
        XCTAssertEqual(bottom.minY, 137)
        XCTAssertEqual(bottom.maxX, 1096)
        XCTAssertTrue(visible.contains(bottom))
    }
    func testLongMessageWrapsAndRenders() throws {
        let (short, shortSize) = NativeTooltipAnchor.measuredHost(AnyView(content()))
        let (long, longSize) = NativeTooltipAnchor.measuredHost(AnyView(content(long: true)))
        XCTAssertLessThanOrEqual(longSize.width, 300)
        XCTAssertGreaterThan(longSize.height, shortSize.height + 50)
        for (name, host) in [("short", short), ("long", long)] {
            host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: "/tmp/coflux-workspace-tooltip-\(name).png"))
        }
    }
    func testWorkbenchTooltipWrapsLongTitleWithoutStretchingShortLabel() throws {
        let (short, shortSize) = NativeTooltipAnchor.measuredHost(AnyView(WorkbenchTooltipContent(text: "刷新变更")))
        let (long, longSize) = NativeTooltipAnchor.measuredHost(AnyView(WorkbenchTooltipContent(
            text: String(repeating: "中文路径 /workspace/feature 😀 ", count: 10))))
        XCTAssertLessThan(shortSize.width, 150)
        XCTAssertLessThanOrEqual(longSize.width, 300)
        XCTAssertGreaterThan(longSize.height, shortSize.height * 2)
        for (name, host) in [("short", short), ("long", long)] {
            host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: "/tmp/coflux-workbench-tooltip-\(name).png"))
        }
    }
    func testCancelledHoverAndHiddenWindowDoNotOpenPanel() async throws {
        let window = NSWindow(contentRect: CGRect(x: 200, y: 200, width: 800, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let root = NSView(frame: CGRect(x: 0, y: 0, width: 800, height: 500))
        let anchor = NativeTooltipAnchor(frame: CGRect(x: 20, y: 200, width: 240, height: 28))
        root.addSubview(anchor); window.contentView = root
        defer { anchor.dismiss(); window.close() }
        anchor.update(AnyView(content()))
        anchor.setHovered(true, delay: .milliseconds(200))
        anchor.setHovered(false, delay: .milliseconds(100))
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertNil(anchor.panel, "快速掠过不能迟到弹出")
        XCTAssertFalse(window.isVisible)
        anchor.present()
        XCTAssertNil(anchor.panel, "隐藏窗口不应弹出提示")
    }
    func testVisibleTooltipPreservesFocusAndSupportsReading() async throws {
        let window = NSWindow(contentRect: CGRect(x: 200, y: 200, width: 800, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let root = NSView(frame: CGRect(x: 0, y: 0, width: 800, height: 500))
        let anchor = NativeTooltipAnchor(frame: CGRect(x: 20, y: 200, width: 240, height: 28))
        root.addSubview(anchor); window.contentView = root; window.orderFront(nil)
        defer { anchor.dismiss(); window.close() }
        let keyWindow = NSApp.keyWindow, responder = window.firstResponder
        anchor.update(AnyView(content()))
        anchor.setAnchorHovered(true)
        try await Task.sleep(for: .milliseconds(250))
        let panel = try XCTUnwrap(anchor.panel)
        XCTAssertTrue(panel.isVisible)
        XCTAssertTrue(panel.parent === window)
        XCTAssertFalse(panel.canBecomeKey)
        XCTAssertTrue(NSApp.keyWindow === keyWindow)
        XCTAssertTrue(window.firstResponder === responder)
        anchor.setHovered(false, delay: .milliseconds(100))
        anchor.setHovered(true, delay: .zero)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(anchor.panel === panel, "移入阅读不得关闭或重建窗口")
        anchor.update(AnyView(content(long: true)))
        XCTAssertTrue(anchor.panel === panel)
        anchor.setHovered(false, delay: .milliseconds(100))
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertNil(anchor.panel)
    }
    func testProgrammaticSidebarScrollAndWindowCloseDismissTooltip() throws {
        let window = NSWindow(contentRect: CGRect(x: 200, y: 200, width: 800, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 240, height: 500))
        let document = NSView(frame: CGRect(x: 0, y: 0, width: 240, height: 1400))
        let anchor = NativeTooltipAnchor(frame: CGRect(x: 0, y: 20, width: 240, height: 28))
        document.addSubview(anchor); scroll.documentView = document; window.contentView = scroll
        window.orderFront(nil)
        defer { anchor.dismiss(); window.close() }
        scroll.contentView.scroll(to: .zero)
        anchor.update(AnyView(content())); anchor.present()
        XCTAssertNotNil(anchor.panel)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 500))
        XCTAssertNil(anchor.panel, "自动滚动也必须关闭旧锚点提示")
        anchor.update(AnyView(content(long: true)))
        XCTAssertNil(anchor.panel, "数据更新不得复活已滚出视口的提示")
        scroll.contentView.scroll(to: .zero)
        anchor.present()
        let panel = try XCTUnwrap(anchor.panel)
        window.close()
        XCTAssertNil(anchor.panel)
        XCTAssertFalse(panel.isVisible)
        XCTAssertNil(panel.parent)
        XCTAssertNil(panel.contentView)
    }
    func testManyNewlinesRemainReadableInsideClampedPanel() async throws {
        let window = NSWindow(contentRect: CGRect(x: 200, y: 200, width: 800, height: 360), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let root = NSView(frame: CGRect(x: 0, y: 0, width: 800, height: 360))
        let anchor = NativeTooltipAnchor(frame: CGRect(x: 20, y: 100, width: 240, height: 28))
        root.addSubview(anchor); window.contentView = root; window.orderFront(nil)
        defer { anchor.dismiss(); window.close() }
        var fixture = content()
        var activity = fixture.activity
        activity.message = String(repeating: "行\n", count: 90) + "末行"
        fixture = WorkspaceTooltipContent(workspace: fixture.workspace, project: fixture.project, daemon: fixture.daemon, activity: activity)
        anchor.update(AnyView(fixture)); anchor.present()
        let panel = try XCTUnwrap(anchor.panel)
        XCTAssertLessThanOrEqual(panel.frame.height, root.bounds.height)
        try await Task.sleep(for: .milliseconds(100))
        func scrollView(in view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView { return scroll }
            return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
        }
        let scroll = try XCTUnwrap(scrollView(in: XCTUnwrap(panel.contentView)))
        let document = try XCTUnwrap(scroll.documentView)
        XCTAssertGreaterThan(document.bounds.height, scroll.contentView.bounds.height)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: document.bounds.height - scroll.contentView.bounds.height))
        scroll.reflectScrolledClipView(scroll.contentView)
        XCTAssertGreaterThan(scroll.contentView.bounds.minY, 0)
        XCTAssertTrue(anchor.panel === panel, "提示内部滚动不能关闭阅读窗口")
    }
}

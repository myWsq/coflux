import AppKit
import SwiftUI
import XCTest
import CofluxProtocol
@testable import CofluxClientCore
@testable import Coflux

@MainActor final class ErrorToastLayoutTests: XCTestCase {
    func testLongDeviceSidebarKeepsProjectsVisibleAndScrollsIndependently() async throws {
        let suite = "dev.coflux.sidebar-scroll." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: defaults)
        defer { model.logout(); defaults.removePersistentDomain(forName: suite) }
        var snapshot = Coflux_V1_StateSnapshot()
        snapshot.projects = (0..<80).map { index in
            var project = Coflux_V1_Project(); project.id = "project-\(index)"; project.name = "项目 \(index)"; return project
        }
        snapshot.daemons = (0..<60).map { index in
            var daemon = Coflux_V1_DaemonInfo(); daemon.daemonID = "device-\(index)"; daemon.name = "设备 \(index)"; return daemon
        }
        client.apply(.stateSnapshot(snapshot))
        let host = NSHostingView(rootView: SidebarView(model: model).preferredColorScheme(.dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 260, height: 600),
                              styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.orderOut(nil); window.contentView = nil }
        func scrollViews(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrollViews)
        }
        for height in [600.0, 300.0, 800.0] {
            window.setContentSize(NSSize(width: 260, height: height))
            try await Task.sleep(for: .milliseconds(160))
            host.layoutSubtreeIfNeeded()
            let lists = scrollViews(host).sorted { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
            XCTAssertEqual(lists.count, 2)
            let devices = try XCTUnwrap(lists.first), projects = try XCTUnwrap(lists.last)
            let listHeight = height - 28 // 顶部窗口按钮区不属于可滚动列表
            XCTAssertLessThanOrEqual(devices.frame.height, listHeight * 0.42 + 1)
            XCTAssertGreaterThanOrEqual(projects.frame.height, listHeight * 0.58 - 1, "长设备列表不能挤掉项目区")
            let document = try XCTUnwrap(devices.documentView)
            let projectOffset = projects.documentVisibleRect.origin
            devices.contentView.scroll(to: NSPoint(x: 0, y: document.frame.height - devices.contentView.bounds.height))
            devices.reflectScrolledClipView(devices.contentView)
            XCTAssertGreaterThan(devices.documentVisibleRect.minY, 1000)
            XCTAssertEqual(devices.documentVisibleRect.maxY, document.frame.height, accuracy: 1, "末尾设备必须可滚到")
            XCTAssertEqual(projects.documentVisibleRect.origin, projectOffset, "两个列表的滚动位置应独立")
        }
        snapshot.daemons = Array(snapshot.daemons.prefix(1)); client.apply(.stateSnapshot(snapshot))
        try await Task.sleep(for: .milliseconds(160))
        let compact = try XCTUnwrap(scrollViews(host).min { $0.frame.height < $1.frame.height })
        XCTAssertLessThan(compact.frame.height, 110, "少量设备时应收回空白空间")
        snapshot.daemons = []; client.apply(.stateSnapshot(snapshot))
        try await Task.sleep(for: .milliseconds(160))
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: "/tmp/coflux-sidebar-empty-device.png"))
    }

    func testConfirmationLayoutAndEscapeCancelWithoutConfirming() async throws {
        var cancelled = false
        var confirmed = false
        let host = NSHostingView(rootView: WorkbenchConfirmationView(
            title: "关闭终端「终端 1」？",
            message: "正在运行的 shell 会先停止，随后永久删除这个 Tab。终端中的历史输出不会保留。",
            confirmLabel: "停止并关闭", cancel: { cancelled = true }, confirm: { confirmed = true })
            .preferredColorScheme(.dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 160),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil; window.close() }
        try await Task.sleep(for: .milliseconds(120))
        host.layoutSubtreeIfNeeded()
        XCTAssertEqual(host.fittingSize.width, 400, accuracy: 1)
        XCTAssertLessThan(host.fittingSize.height, 170)
        host.setFrameSize(host.fittingSize)
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: "/tmp/coflux-confirmation-parity.png"))
        func send(_ code: UInt16, _ characters: String) throws {
            NSApp.postEvent(try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
                characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)), atStart: false)
        }
        try send(36, "\r")
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertFalse(confirmed, "危险操作不能成为默认回车动作")
        try send(53, "\u{1b}")
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(cancelled)
        XCTAssertFalse(confirmed)
    }

    func testRenderRenameDialogLayout() async throws {
        let suite = "dev.coflux.rename-layout." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: defaults)
        defer { model.logout(); defaults.removePersistentDomain(forName: suite) }
        for entity: WorkbenchEntity in [.project, .workspace, .device] {
            let host = NSHostingView(rootView: WorkbenchDialogView(model: model, dialog: .rename(entity, "visual", "coflux"))
                .preferredColorScheme(.dark))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 160),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            defer { window.contentView = nil }
            try await Task.sleep(for: .milliseconds(120))
            host.layoutSubtreeIfNeeded()
            let size = host.fittingSize
            XCTAssertEqual(size.width, 400, accuracy: 1)
            XCTAssertLessThan(size.height, 170)
            XCTAssertGreaterThan(size.height, 145)
            host.setFrameSize(size)
            host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: "/tmp/coflux-rename-\(entity)-parity.png"))
            print("RENAME_LAYOUT entity=\(entity) size=\(size)")
        }
    }

    func testSelectedTerminalTabScrollsIntoView() async throws {
        let suite = "dev.coflux.tab-scroll." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: defaults)
        defer { model.logout(); defaults.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "tab-account"; client.apply(.authOk(auth))
        var workspace = Coflux_V1_Workspace(); workspace.id = "tabs"; workspace.projectID = "project"; workspace.branch = "main"
        var snapshot = Coflux_V1_StateSnapshot(); snapshot.workspaces = [workspace]
        snapshot.tasks = (0..<20).map { index in
            var task = Coflux_V1_Task(); task.id = "tab-\(index)"; task.workspaceID = workspace.id
            task.title = "终端标签-\(index)"; task.createdAt = Double(index); return task
        }
        client.apply(.stateSnapshot(snapshot)); model.select(.workspace(workspace.id))
        model.openChanges(workspace.id)
        let host = NSHostingView(rootView: TerminalWorkspaceView(model: model))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 400),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        func scrollViews(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrollViews)
        }
        func settle() async throws {
            try await Task.sleep(for: .milliseconds(120))
            window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
        }
        try await settle()
        let tabs = try XCTUnwrap(scrollViews(host).first { $0.frame.height <= 40 && $0.documentView!.frame.width > $0.frame.width })
        XCTAssertLessThan(tabs.documentVisibleRect.minX, 2)
        model.activate(try XCTUnwrap(snapshot.tasks.last))
        try await settle()
        XCTAssertGreaterThan(tabs.documentVisibleRect.minX, 500, "末尾标签应滚入可见区域")
        XCTAssertGreaterThan(tabs.documentVisibleRect.maxX, try XCTUnwrap(tabs.documentView).frame.width - 70)
        model.openChanges(workspace.id)
        try await settle()
        XCTAssertLessThan(tabs.documentVisibleRect.minX, 2, "变更标签回到最左端")
        model.activate(try XCTUnwrap(snapshot.tasks.last))
        try await settle()
        model.performShortcut(.next)
        try await settle()
        XCTAssertLessThan(tabs.documentVisibleRect.minX, 120, "快捷键循环至首标签也应滚回")
        model.createTerminal()
        try await settle()
        XCTAssertNotNil(model.selectedPendingTerminal)
        XCTAssertGreaterThan(tabs.documentVisibleRect.minX, 500, "新建占位也应保持可见")
        model.activate(try XCTUnwrap(snapshot.tasks.last))
        let restoredHost = NSHostingView(rootView: TerminalWorkspaceView(model: model))
        window.contentView = restoredHost
        try await Task.sleep(for: .milliseconds(160))
        restoredHost.layoutSubtreeIfNeeded()
        let restoredTabs = try XCTUnwrap(scrollViews(restoredHost).first { $0.frame.height <= 40 && $0.documentView!.frame.width > $0.frame.width })
        XCTAssertGreaterThan(restoredTabs.documentVisibleRect.minX, 500, "重新显示工作台应恢复当前标签的位置")
    }

    func testImportKeyboardSelectionStartsEmptyAndResetsAfterFiltering() async throws {
        let suite = "dev.coflux.import-keyboard." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: defaults)
        defer { model.logout(); defaults.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "keyboard-account"; client.apply(.authOk(auth))
        var snapshot = Coflux_V1_StateSnapshot()
        var daemon = Coflux_V1_DaemonInfo(); daemon.daemonID = "keyboard-device"; daemon.name = "开发 Mac"; daemon.online = true
        snapshot.daemons = [daemon]; client.apply(.stateSnapshot(snapshot)); model.dialog = .importProject
        let host = NSHostingView(rootView: WorkbenchDialogView(model: model, dialog: .importProject).environment(\.colorScheme, .dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 420), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        func fields(_ view: NSView) -> [NativeSearchField.Field] {
            (view as? NativeSearchField.Field).map { [$0] } ?? view.subviews.flatMap(fields)
        }
        func field(_ placeholder: String) -> NativeSearchField.Field? {
            host.layoutSubtreeIfNeeded()
            return fields(host).first { $0.placeholderString == placeholder }
        }
        func command(_ selector: Selector) async throws {
            let input = try XCTUnwrap(field("搜索设备名或主机"))
            let coordinator = try XCTUnwrap(input.delegate as? NativeSearchField.Coordinator)
            XCTAssertTrue(coordinator.control(input, textView: NSTextView(), doCommandBy: selector))
            try await Task.sleep(for: .milliseconds(60))
        }
        try await Task.sleep(for: .milliseconds(80))
        try await command(#selector(NSResponder.insertNewline(_:)))
        XCTAssertNotNil(field("搜索设备名或主机"), "初始 Enter 不能擅自选择第一台设备")
        try await command(#selector(NSResponder.moveDown(_:)))
        try await command(#selector(NSResponder.moveUp(_:)))
        try await command(#selector(NSResponder.insertNewline(_:)))
        XCTAssertNotNil(field("搜索设备名或主机"), "首行按上键应撤销选择")
        try await command(#selector(NSResponder.moveDown(_:)))
        let input = try XCTUnwrap(field("搜索设备名或主机"))
        input.stringValue = "开发"
        let coordinator = try XCTUnwrap(input.delegate as? NativeSearchField.Coordinator)
        coordinator.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: input))
        try await Task.sleep(for: .milliseconds(60))
        try await command(#selector(NSResponder.insertNewline(_:)))
        XCTAssertNotNil(field("搜索设备名或主机"), "改过滤词后应清除旧选择")
        try await command(#selector(NSResponder.moveDown(_:)))
        try await command(#selector(NSResponder.insertNewline(_:)))
        XCTAssertNotNil(field("过滤或进入文件夹"), "明确选择后才进入目录步骤")
    }

    func testImportDeviceEmptyAndSearchFeedback() async throws {
        let suite = "dev.coflux.import-feedback." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: defaults)
        defer { model.logout(); defaults.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "render-account"; client.apply(.authOk(auth))
        var snapshot = Coflux_V1_StateSnapshot()
        client.apply(.stateSnapshot(snapshot))
        model.dialog = .importProject
        let host = NSHostingView(rootView: WorkbenchDialogView(model: model, dialog: .importProject).environment(\.colorScheme, .dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 420), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        func fields(_ view: NSView) -> [NativeSearchField.Field] {
            (view as? NativeSearchField.Field).map { [$0] } ?? view.subviews.flatMap(fields)
        }
        func capture(_ name: String) throws -> Data {
            window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: "/tmp/coflux-import-" + name + ".png"))
            return png
        }
        try await Task.sleep(for: .milliseconds(80))
        _ = try capture("no-devices")
        XCTAssertTrue(fields(host).isEmpty, "无在线设备时显示登记入口，不显示空搜索列表")
        var device = Coflux_V1_DaemonInfo(); device.daemonID = "render-device"; device.name = "开发 Mac"; device.host = "dev-mac"; device.online = true
        snapshot.daemons = [device]; client.apply(.stateSnapshot(snapshot))
        try await Task.sleep(for: .milliseconds(80))
        let field = try XCTUnwrap(fields(host).first)
        let coordinator = try XCTUnwrap(field.delegate as? NativeSearchField.Coordinator)
        field.stringValue = "不存在的设备"
        coordinator.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
        try await Task.sleep(for: .milliseconds(80))
        let unmatched = try capture("no-match")
        field.stringValue = "  开发 Mac  "
        coordinator.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
        try await Task.sleep(for: .milliseconds(80))
        let matched = try capture("matched")
        XCTAssertNotEqual(unmatched, matched)
        XCTAssertTrue(coordinator.control(field, textView: NSTextView(), doCommandBy: #selector(NSResponder.cancelOperation(_:))))
        XCTAssertNil(model.dialog, "设备搜索中的 Esc 应关闭导入对话框")
    }

    func testRenderWorkbenchWithIsolatedSnapshot() async throws {
        try await renderWorkbench(titles: [], artifact: "workbench")
    }
    func testRenderWorkbenchWithThreeTerminalTabs() async throws {
        try await renderWorkbench(titles: ["终端 1", "运行单元测试与构建验证", "终端 3"], artifact: "tabs")
    }
    func testRenderWorkbenchWithOverflowingLongTerminalTabs() async throws {
        try await renderWorkbench(titles: (1...12).map {
            "终端 \($0)：检查原生客户端与 Web 功能及交互对齐 —— Unicode 😀 / workspace"
        }, artifact: "overflow-tabs")
    }
    func testRenderDeviceEmptyState() async throws {
        try await renderWorkbench(titles: [], artifact: "device-empty", selectDevice: true)
    }
    func testRenderDeviceOfflineState() async throws {
        try await renderWorkbench(titles: [], artifact: "device-offline", selectDevice: true, deviceOnline: false)
        try await renderWorkbench(titles: [], artifact: "device-missing", deviceMissing: true)
    }
    func testRenderDeviceCreatingState() async throws {
        try await renderWorkbench(titles: [], artifact: "device-creating", selectDevice: true, deviceBusy: true)
    }
    func testRenderDeviceErrorState() async throws {
        try await renderWorkbench(titles: [], artifact: "device-error", selectDevice: true, deviceError: "无法解析设备 HOME 目录，请重试。")
    }
    func testRenderShortcutHelp() throws {
        let view = NSHostingView(rootView: ShortcutHelpView {}.environment(\.colorScheme, .dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 280), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        view.frame = NSRect(x: 0, y: 0, width: 380, height: 280)
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: "/tmp/coflux-native-shortcut-help.png"))
    }
    func testRenderPendingWorkspace() async throws {
        try await renderWorkbench(titles: [], artifact: "pending-workspace", pendingBranch: "feature/native-client")
    }
    func testRenderFirstProjectOnboarding() async throws {
        try await renderWorkbench(titles: [], artifact: "onboarding", emptyAccount: true)
    }
    func testRenderBeforeFirstSnapshot() async throws {
        try await renderWorkbench(titles: [], artifact: "awaiting-snapshot", emptyAccount: true, applySnapshot: false)
    }
    func testRenderLoginFailure() async throws {
        try await renderWorkbench(titles: [], artifact: "login-failure", emptyAccount: true, loginFailure: true)
    }
    private func renderWorkbench(titles: [String], artifact: String, selectDevice: Bool = false, deviceOnline: Bool = true, deviceMissing: Bool = false, deviceBusy: Bool = false, deviceError: String? = nil, emptyAccount: Bool = false, applySnapshot: Bool = true, loginFailure: Bool = false, pendingBranch: String? = nil) async throws {
        let suite = "dev.coflux.render." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: defaults)
        defer { model.logout(); defaults.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "render-account"; client.apply(.authOk(auth))
        var device = Coflux_V1_DaemonInfo(); device.daemonID = "render-device"; device.name = "开发 Mac"; device.online = deviceOnline
        var project = Coflux_V1_Project(); project.id = "render-project"; project.name = "coflux"; project.daemonID = device.daemonID; project.repoPath = "/work/coflux"
        var main = Coflux_V1_Workspace(); main.id = "main"; main.projectID = project.id; main.daemonID = device.daemonID
        main.branch = "main"; main.isMain = true
        var feature = main; feature.id = "feature"; feature.branch = "feature/native-client"; feature.isMain = false
        var snapshot = Coflux_V1_StateSnapshot(); snapshot.daemons = deviceMissing ? [] : [device]; snapshot.projects = [project]; snapshot.workspaces = [main, feature]
        if !titles.isEmpty {
            snapshot.tasks = titles.enumerated().map { index, title in
                var task = Coflux_V1_Task(); task.id = "render-task-\(index)"; task.title = title
                task.workspaceID = main.id; task.projectID = project.id; task.daemonID = device.daemonID
                task.status = .running; task.sessionID = "render-session-\(index)"; task.createdAt = Double(index + 1)
                return task
            }
        }
        if emptyAccount { snapshot.projects = []; snapshot.workspaces = [] }
        if applySnapshot { client.apply(.stateSnapshot(snapshot)) }
        if !emptyAccount { model.select(selectDevice ? .device(device.daemonID) : .workspace(main.id)) }
        if let pendingBranch {
            let pending = PendingWorkspace(id: "pending-render", projectID: project.id, daemonID: device.daemonID, branch: pendingBranch, knownIDs: Set(snapshot.workspaces.map(\.id)))
            model.pendingWorkspaces.append(pending)
            model.select(.workspace(pending.id))
        }
        if deviceBusy { model.creatingDeviceTerminals.insert(device.daemonID) }
        model.deviceTerminalErrors[device.daemonID] = deviceError
        if loginFailure { client.apply(.authError(Coflux_V1_AuthError())) }
        let view = NSHostingView(rootView: RootView(model: model).environment(\.colorScheme, .dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        view.frame = NSRect(x: 0, y: 0, width: 1360, height: 860)
        window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(titles.isEmpty ? 100 : 650))
        window.displayIfNeeded(); view.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: "/tmp/coflux-native-\(artifact)-snapshot.png"))
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = "原生工作台隔离快照"; attachment.lifetime = .keepAlways; add(attachment)
        XCTAssertEqual(CGFloat(bitmap.pixelsWide) / CGFloat(bitmap.pixelsHigh), 1360.0 / 860.0, accuracy: 0.01)
        XCTAssertEqual(client.tasks.count, titles.count)
        XCTAssertFalse(client.hasSessionControl(sessionID: "render-session-0"))
    }

    func testRenderErrorToastArtifact() throws {
        let content = WorkbenchErrorToast(message: "创建任务失败：远程设备上的目录不存在。\n请检查路径后重试。", dismiss: {})
            .background(Design.background).environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: content)
        renderer.proposedSize = ProposedViewSize(width: 480, height: nil)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage)
        let bitmap = try XCTUnwrap(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        let url = URL(fileURLWithPath: "/tmp/coflux-native-error-toast.png")
        try png.write(to: url)
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = "原生错误提示组件"
        attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertGreaterThan(bitmap.pixelsWide, 0)
        XCTAssertGreaterThan(bitmap.pixelsHigh, 0)
    }

    func testErrorToastUsesContentHeightInsideWorkbenchOverlay() async throws {
        for (message, maximumHeight) in [("session logical client identity 已达上限 256", CGFloat(140)),
                                         (String(repeating: "远程设备返回错误：路径不存在，检查目录后重试。😀\n", count: 80), CGFloat(376))] {
            var actualSize = CGSize.zero
            let host = NSHostingView(rootView: Color.black.overlay(alignment: .bottomTrailing) {
                WorkbenchErrorToast(message: message, dismiss: {})
                    .onGeometryChange(for: CGSize.self) { $0.size } action: { actualSize = $0 }
            })
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 860),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            defer { window.contentView = nil }
            window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(120))
            print("ERROR_TOAST_OVERLAY characters=\(message.count) actual=\(actualSize)")
            XCTAssertGreaterThan(actualSize.height, 24)
            XCTAssertLessThanOrEqual(actualSize.height, maximumHeight)
            XCTAssertLessThanOrEqual(actualSize.width, 480)
        }
    }

    func testShortAndLongErrorsFitAvailableWidthAndBoundHeight() {
        for (message, maximumHeight) in [("创建终端失败，请重试", CGFloat(120)),
                                         (String(repeating: "远程设备返回错误：路径不存在，检查目录后重试。😀\n", count: 80), CGFloat(376))] {
            let view = NSHostingView(rootView: WorkbenchErrorToast(message: message, dismiss: {}))
            view.frame = NSRect(x: 0, y: 0, width: 480, height: 600)
            view.layoutSubtreeIfNeeded()
            let size = view.fittingSize
            print("ERROR_TOAST_LAYOUT characters=\(message.count) fitting=\(size)")
            XCTAssertGreaterThan(size.height, 24)
            XCTAssertLessThanOrEqual(size.height, maximumHeight)
            XCTAssertLessThanOrEqual(size.width, 480)
        }
    }
}

import AppKit
import CofluxClientCore
import CofluxProtocol
import ImageIO
import GhosttyKit
import SwiftUI
import XCTest
@testable import Coflux

@MainActor
final class NativeIntegrationTests: XCTestCase {
    /// 真实 PTY → Device → Ghostty Metal；只操作本用例创建的会话，并检查窗口中的彩色像素。
    func testRealTerminalColorRendering() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.host == "127.0.0.1",
              ProcessInfo.processInfo.environment["COFLUX_NATIVE_COLOR_VISUAL"] == "1" else {
            throw XCTSkip("需显式开启本机隔离终端颜色验收")
        }
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let suite = "dev.coflux.color.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: suite)!
        let model = WorkbenchModel(client: client, preferences: preferences)
        let host = NSHostingView(rootView: RootView(model: model).preferredColorScheme(.dark))
        let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 1200, height: 760),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { client.logout(); window.close(); preferences.removePersistentDomain(forName: suite) }
        client.login(username: "admin", password: "admin")
        try await wait("颜色验收登录") { client.snapshotRevision > 0 }
        model.reconcile()
        let workspaceID = try XCTUnwrap(client.workspaces.first { !$0.isMain }?.id)
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        let quotedRepository = "'" + repository.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
        let title = "颜色渲染验收-" + UUID().uuidString
        client.createTask(workspaceID: workspaceID, title: title)
        try await wait("独立颜色终端创建") { client.tasks.contains { $0.title == title } }
        let created = try XCTUnwrap(client.tasks.first { $0.title == title })
        do {
            model.select(.workspace(workspaceID))
            model.activate(created)
            try await wait("颜色终端启动") { model.activeTask?.id == created.id && model.activeTask?.status == .running && model.activeTask?.hasSessionID == true }
            let task = try XCTUnwrap(client.tasks.first { $0.id == created.id })
            _ = try XCTUnwrap(task.hasSessionID ? task.sessionID : nil)
            try await wait("颜色终端控制权") { client.hasSessionControl(sessionID: task.sessionID) }
            let terminal = try XCTUnwrap(terminals(in: host).first {
                ($0.sessionCoordinator as? NativeTerminal.Coordinator)?.taskID == task.id
            })
            client.sendInput(sessionID: task.sessionID, "printf '\\nCOLOR_ENV=%s TERM=%s\\n' \"$NO_COLOR\" \"$TERM\"\r")
            try await wait("记录 shell 颜色环境") { terminal.readText().contains("COLOR_ENV= TERM=xterm-256color") }
            print("NATIVE_COLOR_ENV", terminal.readText().split(separator: "\n").filter { $0.contains(" TERM=xterm-256color") }.joined(separator: "\n"))
            client.sendInput(sessionID: task.sessionID,
                "printf '\\033[2J\\033[H\\033[31mRED \\033[32mGREEN \\033[34mBLUE\\033[0m\\n\\033[41m        \\033[42m        \\033[44m        \\033[0m\\n\\033[48;2;255;0;128m        \\033[48;2;0;200;255m        \\033[0m\\n%s%s\\n' COLOR_ READY\r")
            try await wait("ANSI 色块进入 Ghostty") { terminal.readText().contains("COLOR_READY") }
            try await Task.sleep(for: .seconds(1))
            try await captureColorWindow(window, terminal: terminal, name: "terminal-ansi-colors.png")
            client.sendInput(sessionID: task.sessionID, "cd \(quotedRepository) && clear && claude\r")
            try await wait("Claude 启动", timeout: .seconds(35)) {
                terminal.readText().contains("Claude Code v") || terminal.readText().contains("Yes, I trust this folder")
            }
            if terminal.readText().contains("Yes, I trust this folder") {
                // 仅确认本测试刚 cd 进入、用户已授权开发的当前工作树。
                XCTAssertTrue(terminal.readText().contains(repository))
                client.sendInput(sessionID: task.sessionID, "\u{1b}[B\r")
            }
            try await wait("Claude 完整首页", timeout: .seconds(35)) { terminal.readText().contains("Claude Code v") }
            try await Task.sleep(for: .seconds(3))
            try await captureColorWindow(window, terminal: terminal, name: "terminal-claude-colors.png")
            await client.closeTask(task)
            try await wait("颜色诊断任务清理") { !client.tasks.contains { $0.id == task.id } }
        } catch {
            if let task = client.tasks.first(where: { $0.id == created.id }) { await client.closeTask(task) }
            throw error
        }
    }

    private func captureColorWindow(_ window: NSWindow, terminal: GhosttyTerminalView, name: String) async throws {
        let directory = URL(fileURLWithPath: "/tmp/coflux-native-color-validation")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(name)
        // AppKit cacheDisplay 不包含 CAMetalLayer；窗口捕获才能验收实际合成的 Ghostty 颜色。
        let request = directory.appendingPathComponent("capture-request.json")
        try? FileManager.default.removeItem(at: file)
        try JSONSerialization.data(withJSONObject: ["windowID": window.windowNumber, "path": file.path])
            .write(to: request, options: .atomic)
        // 由已获屏幕权限的开发宿主捕获，测试宿主无需申请新的系统权限。
        try await wait("宿主捕获 Metal 窗口", timeout: .seconds(45)) {
            FileManager.default.fileExists(atPath: file.path)
        }
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: file)))
        let frame = terminal.convert(terminal.bounds, to: nil)
        let scale = CGFloat(bitmap.pixelsWide) / window.frame.width
        let left = Int(frame.minX * scale), right = min(bitmap.pixelsWide, Int(frame.maxX * scale))
        let top = max(0, Int((window.frame.height - frame.maxY) * scale))
        let bottom = min(bitmap.pixelsHigh, Int((window.frame.height - frame.minY) * scale))
        var colorful = 0
        for y in stride(from: top, to: bottom, by: 2) {
            for x in stride(from: left, to: right, by: 2) {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                let components = [color.redComponent, color.greenComponent, color.blueComponent]
                if components.max()! - components.min()! > 0.15 { colorful += 1 }
            }
        }
        XCTAssertGreaterThan(colorful, 100, "终端实际画面必须存在彩色像素，不计侧栏和标签颜色")
        print("NATIVE_COLOR_RENDER \(name) colorfulSamples=\(colorful) path=\(file.path)")
    }

    func testAgentHookRoundProgressAndPresenceRecovery() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.scheme == "ws", url.host == "127.0.0.1",
              let fixturePath = ProcessInfo.processInfo.environment["COFLUX_NATIVE_FIXTURE_FILE"], !fixturePath.isEmpty else {
            throw XCTSkip("需隔离 dev-fixture URL 和 fixture 文件")
        }
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: fixturePath))) as? [String: Any])
        XCTAssertEqual(fixture["serverURL"] as? String, raw)
        let gatewayPort = try XCTUnwrap(fixture["gatewayPort"] as? Int)
        let cli = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/cli/cofluxd.mjs").path
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        defer { client.logout() }
        client.login(username: "admin", password: "admin")
        try await wait("Agent 验收登录") { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        // fixture 主仓库的私有辅助文件不参与 Git 变更计数，避免异步统计影响下一个用例。
        let directory = ".git/native-agent-" + UUID().uuidString
        // 受控进程只模拟 Agent 的存活及 hook 信使，不调用模型。脚本名用于真实进程树识别。
        let script = """
        import json, os, subprocess, sys
        os.environ['COFLUX_LOCAL_GATEWAY_PORT'] = sys.argv[2]
        print('NATIVE_AGENT_READY', flush=True)
        for line in sys.stdin:
            request = json.loads(line)
            if request['kind'] == 'exit': break
            if request['kind'] == 'hook':
                result = subprocess.run(['node', sys.argv[1], 'hook', 'claude'], input=json.dumps(request['payload']), text=True)
            else:
                result = subprocess.run(['node', sys.argv[1], request['kind'], request['message']])
            print('NATIVE_AGENT_ACK:' + str(result.returncode), flush=True)
        """
        let created = try await client.executeInWorkspace(workspaceID: workspace.id, command: "python3", args: ["-c",
            "import os,sys; os.mkdir(sys.argv[1]); open(os.path.join(sys.argv[1], 'controller.py'), 'x').write(sys.argv[2]); p=os.path.join(sys.argv[1], 'claude'); open(p, 'x').write(sys.argv[3]); os.chmod(p, 0o755)",
            directory, script, "#!/bin/sh\npython3 \"$(dirname \"$0\")/controller.py\" \"$@\"\nexit $?\n"])
        XCTAssertEqual(created.exitCode, 0)
        var taskID: String?
        func clean() async throws {
            if let task = client.tasks.first(where: { $0.id == taskID }) { await client.closeTask(task) }
            let result = try await client.executeInWorkspace(workspaceID: workspace.id, command: "python3", args: ["-c",
                "import os,sys; os.unlink(os.path.join(sys.argv[1], 'claude')); os.unlink(os.path.join(sys.argv[1], 'controller.py')); os.rmdir(sys.argv[1])", directory])
            XCTAssertEqual(result.exitCode, 0)
        }
        do {
            client.createTask(workspaceID: workspace.id, title: directory)
            try await wait("创建 Agent 验收终端") { client.tasks.contains { $0.title == directory } }
            taskID = try XCTUnwrap(client.tasks.first { $0.title == directory }).id
            client.startTask(taskID: taskID!, cols: 100, rows: 30)
            try await wait("Agent 真实会话") { client.tasks.first { $0.id == taskID }?.hasSessionID == true }
            let session = try XCTUnwrap(client.tasks.first { $0.id == taskID }).sessionID
            let release = client.registerSessionConsumer(sessionID: session) { _, _ in }
            defer { release() }
            client.startTask(taskID: taskID!, cols: 100, rows: 30)
            try await wait("Agent 终端控制权") { client.hasSessionControl(sessionID: session) }
            func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
            client.sendInput(sessionID: session, "\(quote("./" + directory + "/claude")) \(quote(cli)) \(gatewayPort)\r")
            try await wait("真实进程树 presence") { client.sessionAgents[session]?.session.agent == "claude" }
            func activity() -> WorkspaceActivity {
                WorkspaceActivity(workspaceID: workspace.id, online: true, tasks: client.tasks, agents: client.sessionAgents)
            }
            func send(_ request: [String: Any]) throws {
                let data = try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys])
                client.sendInput(sessionID: session, String(decoding: data, as: UTF8.self) + "\r")
            }
            func hook(_ event: String, expected: String) async throws {
                try send(["kind": "hook", "payload": ["hook_event_name": event]])
                try await wait("hook \(event) → \(expected)") { client.sessionAgents[session]?.session.state == expected }
                XCTAssertEqual(activity().state, expected)
                print("NATIVE_AGENT_PHASE state=\(expected)")
            }
            try await hook("PreToolUse", expected: "active")
            let progress = "正在验证原生终端，保留中文 😀"
            try send(["kind": "progress", "message": progress])
            try await wait("真实进度播报") { activity().progress == progress }
            try await hook("PermissionRequest", expected: "approval")
            XCTAssertEqual(activity().progress, progress)
            let question = "请选择方案\n保留现有工作区？"
            try send(["kind": "notify", "message": question])
            try await wait("真实留言及待回答状态") { activity().state == "question" && activity().message == question }
            XCTAssertEqual(activity().progress, progress)
            try await hook("Stop", expected: "done")
            XCTAssertTrue(activity().message.isEmpty, "完成后不能继续显示旧问题")
            XCTAssertEqual(activity().progress, progress)
            let revision = client.snapshotRevision
            client.suspend(); client.resume()
            try await wait("重新订阅恢复 presence 与进度") {
                client.snapshotRevision > revision && client.sessionAgents[session]?.session.state == "done" && activity().progress == progress
            }
            client.startTask(taskID: taskID!, cols: 100, rows: 30)
            try await wait("重新取得输入控制权") { client.hasSessionControl(sessionID: session) }
            try await hook("PreToolUse", expected: "active")
            try send(["kind": "exit"])
            try await wait("进程退出清除 presence") { client.sessionAgents[session] == nil }
            XCTAssertNil(activity().state)
            XCTAssertTrue(activity().progress.isEmpty)
            print("NATIVE_AGENT_PHASE state=exited presence=empty")
        } catch { try await clean(); throw error }
        try await clean()
    }

    func testControlledSessionReactivationDoesNotShowConnecting() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.scheme == "ws", url.host == "127.0.0.1" else {
            throw XCTSkip("需隔离 dev-fixture")
        }
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        defer { client.logout() }
        client.login(username: "admin", password: "admin")
        try await wait("连接状态验收登录") { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        let title = "native-attach-indicator-" + UUID().uuidString
        client.createTask(workspaceID: workspace.id, title: title)
        try await wait("创建连接状态验收任务") { client.tasks.contains { $0.title == title } }
        let task = try XCTUnwrap(client.tasks.first { $0.title == title })
        func clean() async {
            if let current = client.tasks.first(where: { $0.id == task.id }) { await client.closeTask(current) }
        }
        do {
            client.startTask(taskID: task.id, cols: 80, rows: 24)
            XCTAssertTrue(client.attachingTaskIDs.contains(task.id), "首次启动仍须给出连接反馈")
            try await wait("服务端创建真实会话") {
                client.tasks.first { $0.id == task.id }.map { $0.status == .running && $0.hasSessionID } == true
            }
            let current = try XCTUnwrap(client.tasks.first { $0.id == task.id })
            let release = client.registerSessionConsumer(sessionID: current.sessionID) { _, _ in }
            defer { release() }
            client.startTask(taskID: task.id, cols: 80, rows: 24)
            try await wait("真实会话取得控制权") {
                client.tasks.first { $0.id == task.id }.map { $0.hasSessionID && client.hasSessionControl(sessionID: $0.sessionID) } == true
            }
            for _ in 0..<3 {
                client.startTask(taskID: task.id, cols: 80, rows: 24)
                XCTAssertFalse(client.attachingTaskIDs.contains(task.id), "已连接终端重新激活不应显示正在连接")
                XCTAssertTrue(client.hasSessionControl(sessionID: current.sessionID))
            }
            client.startTask(taskID: task.id, cols: 80, rows: 24, force: true)
            XCTAssertTrue(client.attachingTaskIDs.contains(task.id), "强制接管仍需要重新裁决")
            try await wait("强制接管完成") { client.hasSessionControl(sessionID: current.sessionID) && !client.attachingTaskIDs.contains(task.id) }
            await clean()
        } catch { await clean(); throw error }
    }

    func testChangesRetryAfterControlConnectionRecovery() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.scheme == "ws", url.host == "127.0.0.1" else {
            throw XCTSkip("需隔离 dev-fixture")
        }
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        defer { client.logout() }
        client.login(username: "admin", password: "admin")
        try await wait("错误恢复登录") { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        let path = "native-retry-" + UUID().uuidString + ".ts"
        let created = try await client.executeInWorkspace(workspaceID: workspace.id, command: "python3",
            args: ["-c", "import sys; open(sys.argv[1], 'x').write(sys.argv[2])", path, "const recovered = 42;\n"])
        XCTAssertEqual(created.exitCode, 0)
        func restore() async throws {
            if client.status == .disconnected {
                let revision = client.snapshotRevision
                client.resume()
                try await wait("中心恢复并收到新快照") { client.snapshotRevision > revision }
            }
        }
        func clean() async throws {
            try await restore()
            let removed = try await client.executeInWorkspace(workspaceID: workspace.id, command: "python3",
                args: ["-c", "import os,sys; os.unlink(sys.argv[1])", path])
            XCTAssertEqual(removed.exitCode, 0)
        }
        do {
            client.suspend()
            let host = NSHostingView(rootView: ChangesView(client: client, workspace: workspace, active: true, defaultBranch: ""))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 780),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            window.isReleasedWhenClosed = false
            window.makeKeyAndOrderFront(nil)
            defer { try? capture(host, "changes-retry-final-state.png"); window.orderOut(nil); window.contentView = nil; window.close() }
            func documents(_ view: NSView) -> [DiffSelectionView] {
                (view as? DiffSelectionView).map { [$0] } ?? view.subviews.flatMap(documents)
            }
            // 离线请求在本地拒绝；保留真实错误页截图，避免依赖 SwiftUI 离屏 AX 树。
            try await Task.sleep(for: .milliseconds(500))
            XCTAssertTrue(documents(host).isEmpty)
            try capture(host, "changes-offline-error.png")
            try await restore()
            // 截图中按钮位于 1040×780 内容区中心下方；通过窗口事件点击，不调用加载函数。
            for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
                let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: NSPoint(x: 520, y: 360),
                    modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                    context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
                NSApp.postEvent(event, atStart: false)
            }
            try await wait("重试清除错误并显示真实文件") {
                host.layoutSubtreeIfNeeded()
                return documents(host).contains { $0.string.contains("const recovered = 42;") }
            }
            try capture(host, "changes-retry-recovered.png")
        } catch {
            try await clean()
            throw error
        }
        try await clean()
    }

    func testOffscreenDiffFileDefersLayoutUntilVisible() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.scheme == "ws", url.host == "127.0.0.1" else {
            throw XCTSkip("需启动隔离 dev-fixture")
        }
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        defer { client.logout() }
        client.login(username: "admin", password: "admin")
        try await wait("多文件diff登录") { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        let folder = "native-visibility-" + UUID().uuidString
        let created = try await client.executeInWorkspace(workspaceID: workspace.id, command: "python3", args: ["-c", """
        import os,sys
        os.mkdir(sys.argv[1])
        for name,count,prefix in [('a.ts',80,'first'),('b.ts',5000,'second')]:
            with open(os.path.join(sys.argv[1],name),'x') as f:
                f.write(''.join(f'const {prefix}_{i} = {i};\\n' for i in range(count)))
        """, folder])
        XCTAssertEqual(created.exitCode, 0)
        func clean() async throws {
            let result = try await client.executeInWorkspace(workspaceID: workspace.id, command: "python3", args: ["-c", """
            import os,sys
            for name in ['a.ts','b.ts']: os.unlink(os.path.join(sys.argv[1],name))
            os.rmdir(sys.argv[1])
            """, folder])
            XCTAssertEqual(result.exitCode, 0)
        }
        do {
            let host = NSHostingView(rootView: ChangesView(client: client, workspace: workspace, active: true, defaultBranch: "")
                .environment(\.colorScheme, .dark))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 780),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            defer { window.contentView = nil }
            func documents(_ view: NSView) -> [DiffSelectionView] {
                (view as? DiffSelectionView).map { [$0] } ?? view.subviews.flatMap(documents)
            }
            try await wait("屏外大文件容器挂载") {
                window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
                return documents(host).contains { $0.accessibilityLabel()?.contains(folder + "/b.ts") == true }
            }
            let second = try XCTUnwrap(documents(host).first { $0.accessibilityLabel()?.contains(folder + "/b.ts") == true })
            let manager = try XCTUnwrap(second.layoutManager)
            let before = manager.firstUnlaidCharacterIndex()
            XCTAssertEqual(before, 0, "首次屏外挂载不应提前布局")
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(manager.firstUnlaidCharacterIndex(), before, "屏外文件不应继续预布局")
            var ancestor: NSView? = second
            var scrolls: [NSScrollView] = []
            while let view = ancestor {
                if let scroll = view as? NSScrollView { scrolls.append(scroll) }
                ancestor = view.superview
            }
            let outer = try XCTUnwrap(scrolls.last)
            let content = try XCTUnwrap(outer.documentView)
            let target = second.convert(NSRect(x: 0, y: 0, width: 100, height: 40), to: content)
            outer.contentView.scroll(to: NSPoint(x: 0, y: max(0, target.minY)))
            outer.reflectScrolledClipView(outer.contentView)
            try await wait("进入视口后继续布局") {
                window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
                return manager.firstUnlaidCharacterIndex() > before && second.document?.highlightingComplete == true
            }
            XCTAssertTrue(second.string.contains("second_4999"), "保留屏外正文以支持完整选择")
            let document = try XCTUnwrap(second.document)
            let selected = (second.string as NSString).range(of: "second_12")
            second.setSelectedRange(selected)
            outer.contentView.scroll(to: .zero)
            outer.reflectScrolledClipView(outer.contentView)
            try await wait("大文件再次离开视口") {
                window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
                return second.visibleRect.isEmpty
            }
            try await Task.sleep(for: .milliseconds(40))
            let paused = manager.firstUnlaidCharacterIndex()
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(manager.firstUnlaidCharacterIndex(), paused)
            XCTAssertTrue(second.document === document, "离屏不能重建或移除已展示的文档")
            XCTAssertEqual(second.selectedRange(), selected)
            XCTAssertTrue(second.string.contains("second_4999"))
            print("多文件离屏暂停时已布局字符：\(paused)/\(second.string.utf16.count)")
            outer.contentView.scroll(to: NSPoint(x: 0, y: max(0, target.minY)))
            outer.reflectScrolledClipView(outer.contentView)
            try await wait("大文件再次进入视口") {
                window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
                return !second.visibleRect.isEmpty
            }
            XCTAssertTrue(second.document === document)
            XCTAssertEqual(second.selectedRange(), selected)
        } catch {
            try await clean()
            throw error
        }
        try await clean()
    }

    func testChangesPageRendersRealGitFile() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.scheme == "ws", url.host == "127.0.0.1" else {
            throw XCTSkip("需启动隔离 dev-fixture")
        }
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        defer { client.logout() }
        client.login(username: "admin", password: "admin")
        try await wait("diff渲染登录") { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        let path = "native-render-" + UUID().uuidString + ".ts"
        let source = "// 原生 diff 页面：中文与 emoji 😀\nconst greeting = \"hello\";\n\n" +
            (0..<24).map { "export const value\($0) = \($0);" }.joined(separator: "\n") + "\n" +
            "export const longLine = \"" + String(repeating: "长行内容", count: 80) + "RIGHT_EDGE\";\n"
        let created = try await client.executeInWorkspace(workspaceID: workspace.id, command: "python3",
            args: ["-c", "import sys; open(sys.argv[1], 'x').write(sys.argv[2])", path, source])
        XCTAssertEqual(created.exitCode, 0)
        func clean() async throws {
            let result = try await client.executeInWorkspace(workspaceID: workspace.id, command: "python3",
                args: ["-c", "import os,sys; os.unlink(sys.argv[1])", path])
            XCTAssertEqual(result.exitCode, 0)
        }
        do {
            try await wait("设备推送最新变更计数") {
                client.workspaces.contains { $0.id == workspace.id && $0.additions >= workspace.additions + 28 }
            }
            let updated = try XCTUnwrap(client.workspaces.first { $0.id == workspace.id })
            let host = NSHostingView(rootView: ChangesView(client: client, workspace: updated, active: true, defaultBranch: "")
                .environment(\.colorScheme, .dark))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 780),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            defer { window.contentView = nil }
            func documents(_ view: NSView) -> [DiffSelectionView] {
                (view as? DiffSelectionView).map { [$0] } ?? view.subviews.flatMap(documents)
            }
            try await wait("真实Git文件完成原生高亮") {
                window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
                return documents(host).contains { $0.string.contains("const greeting") && $0.document?.highlightingComplete == true }
            }
            let text = try XCTUnwrap(documents(host).first { $0.string.contains("const greeting") })
            XCTAssertTrue(text.string.contains("中文与 emoji 😀"))
            XCTAssertEqual((text.textStorage?.attribute(.font, at: text.string.range(of: "const greeting").map {
                NSRange($0, in: text.string).location
            } ?? 0, effectiveRange: nil) as? NSFont)?.pointSize, 11)
            try capture(host, "changes-real-git.png")
            XCTAssertGreaterThan(text.bounds.width, host.bounds.width, "完整长行必须纳入横向滚动范围")
            let marker = (text.string as NSString).range(of: "RIGHT_EDGE")
            XCTAssertNotEqual(marker.location, NSNotFound)
            text.setSelectedRange(marker)
            text.scrollRangeToVisible(marker)
            window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertGreaterThan(text.visibleRect.minX, 0, "定位长行末尾应移动横向视口")
            XCTAssertEqual(text.selectedRange(), marker)
            XCTAssertTrue(text.string.contains("中文与 emoji 😀"), "横向滚动不能替换或截断文档")
            try capture(host, "changes-real-git-right-edge.png")

            // 增删行数不是正文版本：切走期间同样行数的修改，重新进入必须重新获取。
            host.rootView = ChangesView(client: client, workspace: updated, active: false, defaultBranch: "")
                .environment(\.colorScheme, .dark)
            try await Task.sleep(for: .milliseconds(80))
            let replacement = source.replacingOccurrences(of: "\"hello\"", with: "\"updated-same-line-count\"")
            XCTAssertEqual(source.components(separatedBy: "\n").count, replacement.components(separatedBy: "\n").count)
            let rewritten = try await client.executeInWorkspace(workspaceID: workspace.id, command: "python3",
                args: ["-c", "import sys; open(sys.argv[1], 'w').write(sys.argv[2])", path, replacement])
            XCTAssertEqual(rewritten.exitCode, 0)
            // 保持完全相同的workspace值，明确排除变更计数触发刷新。
            host.rootView = ChangesView(client: client, workspace: updated, active: true, defaultBranch: "")
                .environment(\.colorScheme, .dark)
            try await wait("重新进入变更页读取相同行数的新正文") {
                window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
                return documents(host).contains {
                    $0.string.contains("updated-same-line-count") && $0.document?.highlightingComplete == true
                }
            }
            XCTAssertFalse(documents(host).contains { $0.string.contains("\"hello\"") }, "不能保留旧正文文档")
        } catch {
            try await clean()
            throw error
        }
        try await clean()
    }

    func testDeviceTerminalCreateCoalescesConcurrentClicks() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.scheme == "ws", url.host == "127.0.0.1" else {
            throw XCTSkip("需启动隔离 dev-fixture")
        }
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let suite = "dev.coflux.device-create." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let model = WorkbenchModel(client: client, preferences: preferences)
        defer { client.logout(); preferences.removePersistentDomain(forName: suite) }
        client.login(username: "admin", password: "admin")
        try await wait("设备创建测试登录") { client.snapshotRevision > 0 }
        let daemon = try XCTUnwrap(client.daemons.first(where: \.online))
        let known = Set(client.tasks.map(\.id))
        async let first: Void = model.createDeviceTerminal(daemon.daemonID)
        async let second: Void = model.createDeviceTerminal(daemon.daemonID)
        _ = await (first, second)
        try await wait("设备 HOME 终端出现") { client.tasks.contains { !known.contains($0.id) } }
        let created = client.tasks.filter { !known.contains($0.id) }
        XCTAssertEqual(created.count, 1, "同一设备的并发点击必须合并")
        XCTAssertFalse(model.creatingDeviceTerminals.contains(daemon.daemonID))
        XCTAssertNil(model.deviceTerminalErrors[daemon.daemonID])
        for task in created { await client.closeTask(task) }
        try await wait("清理本测试创建的设备终端") { !client.tasks.contains { !known.contains($0.id) } }
    }

    func testDesktopDirectoryGitAndWorkspaceLifecycle() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.scheme == "ws", url.host == "127.0.0.1" else {
            throw XCTSkip("需启动隔离 dev-fixture")
        }
        var phase = "登录"
        // 保留失败阶段，区分真实生命周期断言与连接或调用方取消。
        defer { print("NATIVE_WORKSPACE_LIFECYCLE phase=\(phase) taskCancelled=\(Task.isCancelled)") }
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        defer { client.logout() }
        client.login(username: "admin", password: "admin")
        try await wait("工作台控制面登录") { client.snapshotRevision > 0 }
        let base = try XCTUnwrap(client.workspaces.first { $0.isMain })
        phase = "浏览设备目录"
        let home = try await client.listDeviceDirectory(daemonID: base.daemonID, path: "~")
        XCTAssertTrue(home.ok)
        XCTAssertTrue(home.path.hasPrefix("/"))
        phase = "浏览工作区目录"
        let list = try await client.listWorkspaceDirectory(workspaceID: base.id, path: "")
        XCTAssertTrue(list.ok)
        XCTAssertTrue(list.entries.contains { $0.name == ".git" })
        phase = "读取不存在文件"
        let missing = try await client.readWorkspaceFile(workspaceID: base.id, path: "missing-\(UUID().uuidString)")
        XCTAssertFalse(missing.ok)
        let child = "native-test-" + UUID().uuidString.lowercased()
        phase = "初始化临时仓库"
        let initialized = try await client.executeInWorkspace(workspaceID: base.id, command: "git", args: ["init", "--initial-branch=main", child])
        XCTAssertTrue(initialized.ok)
        XCTAssertEqual(initialized.exitCode, 0)
        phase = "提交临时仓库"
        let commit = try await client.executeInWorkspace(workspaceID: base.id, command: "git", args: ["-C", child, "-c", "user.name=Native Test", "-c", "user.email=native@example.invalid", "commit", "--allow-empty", "-m", "原生集成测试"])
        XCTAssertEqual(commit.exitCode, 0)
        phase = "导入临时项目"
        var imported = Coflux_V1_ProjectImport()
        imported.daemonID = base.daemonID
        imported.path = (base.path as NSString).appendingPathComponent(child)
        imported.name = child
        XCTAssertTrue(client.sendWorkbenchCommand(.projectImport(imported)))
        try await wait("原生客户端执行 prepared 导入") { client.projects.contains { $0.name == child } }
        let project = try XCTUnwrap(client.projects.first { $0.name == child })
        try await wait("导入主工作区") { client.workspaces.contains { $0.projectID == project.id && $0.isMain } }
        let suite = "dev.coflux.branch.integration." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let model = WorkbenchModel(client: client, preferences: preferences)
        phase = "创建首个工作区"
        model.dialog = .createWorkspace(project)
        let panel = NSHostingView(rootView: WorkbenchDialogView(model: model, dialog: .createWorkspace(project)))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 360), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = panel
        window.orderFront(nil)
        defer { window.close(); preferences.removePersistentDomain(forName: suite) }
        func fields(_ view: NSView) -> [NativeSearchField.Field] {
            (view as? NativeSearchField.Field).map { [$0] } ?? view.subviews.flatMap(fields)
        }
        try await wait("分支输入框挂载") { !fields(panel).isEmpty }
        let field = try XCTUnwrap(fields(panel).first)
        XCTAssertTrue(window.makeFirstResponder(field))
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        editor.insertText(" native-test ", replacementRange: NSRange(location: 0, length: 0))
        let enter = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\r",
            charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        // 原生 field editor 分派回车；列表尚在加载时不提交，加载完成后提交并关闭。
        var sawPendingWorkspace = false
        try await wait("原生回车提交新分支") {
            if model.dialog != nil {
                editor.keyDown(with: enter)
                if model.dialog == nil {
                    sawPendingWorkspace = model.pendingWorkspace?.branch == "native-test" && model.workspace == nil
                }
            }
            return model.dialog == nil
        }
        XCTAssertTrue(sawPendingWorkspace, "提交后应立即显示本地占位，不能给假 ID 绑定终端")
        try await wait("原生 worktree 创建") { client.workspaces.contains { $0.projectID == project.id && $0.branch == "native-test" } }
        let worktree = try XCTUnwrap(client.workspaces.first { $0.projectID == project.id && !$0.isMain })
        model.reconcile()
        XCTAssertTrue(model.pendingWorkspaces.isEmpty)
        XCTAssertEqual(model.selection, .workspace(worktree.id))
        let branch = try await client.executeInWorkspace(workspaceID: worktree.id, command: "git", args: ["branch", "--show-current"])
        XCTAssertEqual(branch.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "native-test")
        phase = "切换分支"
        let switched = try await client.executeInWorkspace(workspaceID: worktree.id, command: "git", args: ["checkout", "-b", "native-switched"])
        XCTAssertEqual(switched.exitCode, 0)
        try await wait("分支真相从设备同步") { client.workspaces.contains { $0.id == worktree.id && $0.branch == "native-switched" } }
        var rename = Coflux_V1_WorkspaceSetName(); rename.workspaceID = worktree.id; rename.name = "已重命名"
        XCTAssertTrue(client.sendWorkbenchCommand(.workspaceSetName(rename)))
        try await wait("工作区重命名广播") { client.workspaces.contains { $0.id == worktree.id && $0.name == "已重命名" } }
        // 完整 RootView 接收错误后应撤掉占位，不把临时选择写入偏好。
        let workbench = NSHostingView(rootView: RootView(model: model).preferredColorScheme(.dark))
        window.contentView = workbench
        window.setContentSize(NSSize(width: 1024, height: 640))
        workbench.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        let storedSelection = preferences.data(forKey: "selection")
        phase = "验证非法分支错误恢复"
        let previousError = client.lastError?.id
        XCTAssertTrue(model.createWorkspace(project: project, branch: "invalid..branch", createNew: true))
        XCTAssertNotNil(model.pendingWorkspace)
        XCTAssertEqual(preferences.data(forKey: "selection"), storedSelection)
        try await wait("创建失败从真实设备返回错误") { client.lastError?.id != previousError }
        try await wait("错误撤掉原生占位并恢复有效选择") {
            model.pendingWorkspaces.isEmpty && model.workspace != nil
        }
        XCTAssertTrue(model.pendingWorkspaceTimers.isEmpty)
        phase = "后台工作区创建"
        XCTAssertTrue(model.createWorkspace(project: project, branch: "native-background", createNew: true))
        let pendingID = model.pendingWorkspace?.id
        XCTAssertTrue(model.createWorkspace(project: project, branch: "native-background", createNew: true))
        XCTAssertEqual(model.pendingWorkspaces.count, 1, "重复提交应复用占位")
        XCTAssertEqual(model.pendingWorkspace?.id, pendingID)
        model.select(.workspace(worktree.id))
        try await wait("后台创建成功后占位收敛") {
            client.workspaces.contains { $0.projectID == project.id && $0.branch == "native-background" } && model.pendingWorkspaces.isEmpty
        }
        XCTAssertEqual(model.selection, .workspace(worktree.id), "用户切走后不抢回选择")
        let background = try XCTUnwrap(client.workspaces.first { $0.projectID == project.id && $0.branch == "native-background" })
        // 留下一个真实 worktree，覆盖项目级移除的级联清理，而不是只删除空项目记录。
        phase = "准备主仓库保留断言"
        let marker = child + "/native-preserve-marker"
        let marked = try await client.executeInWorkspace(workspaceID: base.id, command: "touch", args: [marker])
        XCTAssertEqual(marked.exitCode, 0)
        let refsBefore = try await client.executeInWorkspace(workspaceID: base.id, command: "git", args: ["-C", child, "show-ref"])
        let headBefore = try await client.executeInWorkspace(workspaceID: base.id, command: "git", args: ["-C", child, "rev-parse", "HEAD"])
        XCTAssertEqual(refsBefore.exitCode, 0)
        XCTAssertEqual(headBefore.exitCode, 0)

        phase = "删除单个工作区"
        var remove = Coflux_V1_WorkspaceRemove(); remove.workspaceID = worktree.id
        XCTAssertTrue(client.sendWorkbenchCommand(.workspaceRemove(remove)))
        try await wait("删除 worktree") { !client.workspaces.contains { $0.id == worktree.id } }
        var removeProject = Coflux_V1_ProjectRemove(); removeProject.projectID = project.id
        phase = "级联移除项目"
        model.dialog = .remove(.project, project.id, project.name)
        model.remove(.project, id: project.id)
        XCTAssertNil(model.dialog, "确认发送成功后关闭对话框")
        try await wait("移除项目及全部工作区记录") {
            !client.projects.contains { $0.id == project.id } &&
            !client.workspaces.contains { $0.projectID == project.id }
        }
        phase = "检查真实目录与Git保留"
        let removedDirectory = try await client.executeInWorkspace(workspaceID: base.id, command: "test", args: ["!", "-e", background.path])
        XCTAssertEqual(removedDirectory.exitCode, 0, "项目移除应清理真实子 worktree 目录")
        let preservedMarker = try await client.executeInWorkspace(workspaceID: base.id, command: "test", args: ["-f", marker])
        XCTAssertEqual(preservedMarker.exitCode, 0, "主仓库未跟踪文件必须保留")
        let refsAfter = try await client.executeInWorkspace(workspaceID: base.id, command: "git", args: ["-C", child, "show-ref"])
        let headAfter = try await client.executeInWorkspace(workspaceID: base.id, command: "git", args: ["-C", child, "rev-parse", "HEAD"])
        XCTAssertEqual(refsAfter.exitCode, 0)
        XCTAssertEqual(headAfter.exitCode, 0)
        XCTAssertEqual(refsAfter.stdout, refsBefore.stdout, "移除项目不应删除主仓库分支")
        XCTAssertEqual(headAfter.stdout, headBefore.stdout, "移除项目不应改变主仓库 HEAD")
        // 删除测试造的嵌套仓库；仅该 UUID 路径，且仍处于 harness 临时根内。
        phase = "清理测试仓库"
        let cleaned = try await client.executeInWorkspace(workspaceID: base.id, command: "rm", args: ["-rf", "--", child])
        XCTAssertEqual(cleaned.exitCode, 0)
        phase = "完成"
        client.logout()
        XCTAssertFalse(client.sendWorkbenchCommand(.projectRemove(removeProject)))
    }

    private var artifactDirectory: URL {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        return root.appendingPathComponent(".coflux-dev/macos")
    }

    func testRealLoginTerminalSwitchAndReconnect() async throws {
        try await verifyRealLoginTerminalSwitchAndReconnect(measureRoundtrip: false)
    }

    @MainActor private final class SwitchHeartbeat {
        var largestGapMS = 0.0
    }

    /// 完整工作台的真实会话切换基线；焦点就绪不等于 GPU 已呈现。
    func testWorkbenchSwitchPerformanceWithEightLiveTerminals() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.scheme == "ws", url.host == "127.0.0.1" else {
            throw XCTSkip("需隔离 dev-fixture")
        }
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let suite = "dev.coflux.switch-benchmark." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let model = WorkbenchModel(client: client, preferences: preferences)
        let host = NSHostingView(rootView: RootView(model: model).preferredColorScheme(.dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 684),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer {
            client.logout(); window.orderOut(nil); window.contentView = nil; window.close()
            preferences.removePersistentDomain(forName: suite)
        }
        client.login(username: "admin", password: "admin")
        try await wait("切换基准登录") { client.snapshotRevision > 0 }
        let workspace = try XCTUnwrap(client.workspaces.first { $0.isMain })
        model.select(.workspace(workspace.id))
        let prefix = "switch-benchmark-" + UUID().uuidString
        var tasks: [Coflux_V1_Task] = []
        var views: [GhosttyTerminalView] = []
        func clean() async {
            for task in client.tasks.filter({ $0.title.hasPrefix(prefix) }) { await client.closeTask(task) }
        }
        func python(_ script: String, session: String) {
            let encoded = Data(script.utf8).base64EncodedString()
            client.sendInput(sessionID: session, "python3 -u -c \"import base64;exec(base64.b64decode('\(encoded)'))\"\r")
        }
        func milliseconds(_ duration: Duration) -> Double {
            Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
        }
        func cpuSeconds() -> Double {
            var usage = rusage()
            guard getrusage(RUSAGE_SELF, &usage) == 0 else { return -1 }
            return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec)
                + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1e6
        }
        func footprint() throws -> UInt64 {
            var info = task_vm_info_data_t()
            var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
            let result = withUnsafeMutablePointer(to: &info) { pointer in
                pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                    task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
                }
            }
            guard result == KERN_SUCCESS else { throw NSError(domain: "MachTaskInfo", code: Int(result)) }
            return info.phys_footprint
        }
        do {
            // 总标签数必须与Web一致；只补本轮拥有的占位任务，不删除fixture已有任务。
            let existingTabs = client.tasks.filter { $0.workspaceID == workspace.id }.count
            guard existingTabs <= 32 else { throw NSError(domain: "SwitchBenchmark", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "隔离工作区已有超过32个标签，请使用干净fixture"] ) }
            for index in existingTabs..<32 {
                let title = "\(prefix)-padding-\(index)"
                client.createTask(workspaceID: workspace.id, title: title)
                try await wait("创建固定标签负载") { client.tasks.contains { $0.title == title } }
            }
            for index in 0..<8 {
                let title = "\(prefix)-\(index)"
                client.createTask(workspaceID: workspace.id, title: title)
                try await wait("创建基准终端") { client.tasks.contains { $0.title == title } }
                let task = try XCTUnwrap(client.tasks.first { $0.title == title })
                model.activate(task)
                try await wait("基准终端运行并取得控制权") {
                    guard let current = client.tasks.first(where: { $0.id == task.id }) else { return false }
                    return current.status == .running && current.hasSessionID && client.hasSessionControl(sessionID: current.sessionID)
                        && self.terminals(in: host).contains { ($0.sessionCoordinator as? NativeTerminal.Coordinator)?.taskID == task.id }
                }
                let current = try XCTUnwrap(client.tasks.first { $0.id == task.id })
                let view = try XCTUnwrap(terminals(in: host).first {
                    ($0.sessionCoordinator as? NativeTerminal.Coordinator)?.taskID == task.id
                })
                tasks.append(current); views.append(view)
                python("print('\\033[2J\\033[H', end=''); print(('历史 \(index) 中文😀 abcdefghijklmnopqrstuvwxyz\\n') * 5000); print('READY_\(index)_END')", session: current.sessionID)
                try await wait("预填真实终端历史") { view.readText(viewport: true).contains("READY_\(index)_END") }
            }
            model.visitedTasks = Set(tasks.map(\.id))
            model.dismissedError = client.lastError?.id
            try await Task.sleep(for: .milliseconds(200))
            XCTAssertEqual(model.workspaceTasks.count, 40, "两端性能对照必须固定40标签")
            XCTAssertEqual(terminals(in: host).count, 8)
            var phases: [[String: Any]] = []
            @MainActor func sample(loaded: Bool) async throws {
                // 供外部采样器定位真实阶段；写入在计时外，采样轮的数据不得混入基线。
                let phaseFile = artifactDirectory.appendingPathComponent("native-switch-profile-phase.json")
                try FileManager.default.createDirectory(at: artifactDirectory, withIntermediateDirectories: true)
                func mark(_ state: String) throws {
                    try JSONSerialization.data(withJSONObject: ["runID": prefix,
                        "pid": ProcessInfo.processInfo.processIdentifier,
                        "loaded": loaded, "state": state])
                        .write(to: phaseFile, options: .atomic)
                }
                if !loaded && ProcessInfo.processInfo.environment["COFLUX_SWITCH_METAL_TRACE"] == "1" {
                    // Instruments附加准备不计入基准；最终仍须核对轨迹是否覆盖实际阶段。
                    try mark("preparing")
                    try await Task.sleep(for: .seconds(15))
                }
                try mark("sampling")
                defer { try? mark("finished") }
                let memoryBefore = try footprint(), cpuBefore = cpuSeconds()
                let phaseStart = ContinuousClock.now
                let heartbeatStats = SwitchHeartbeat()
                let heartbeat = Task { @MainActor in
                    var previous = ContinuousClock.now
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .milliseconds(2)) } catch { return }
                        let now = ContinuousClock.now
                        heartbeatStats.largestGapMS = max(heartbeatStats.largestGapMS, milliseconds(previous.duration(to: now)))
                        previous = now
                    }
                }
                defer { heartbeat.cancel() }
                var samples: [Double] = []
                for iteration in 0..<65 {
                    // 当前为最后一个终端，从首项开始；5次预热后记录60次。
                    let index = iteration % tasks.count
                    let start = ContinuousClock.now
                    model.activate(tasks[index])
                    let deadline = start + .seconds(5)
                    while window.firstResponder !== views[index] ||
                            (views[index].sessionCoordinator as? NativeTerminal.Coordinator)?.active != true {
                        guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
                        try await Task.sleep(for: .milliseconds(1))
                    }
                    let elapsed = milliseconds(start.duration(to: .now))
                    if iteration >= 5 { samples.append(elapsed) }
                    XCTAssertEqual(views.filter { ($0.sessionCoordinator as? NativeTerminal.Coordinator)?.active == true }.count, 1)
                    try await Task.sleep(for: .milliseconds(20))
                }
                heartbeat.cancel()
                let sorted = samples.sorted()
                phases.append(["loaded": loaded, "samplesMS": samples,
                    "medianMS": (sorted[29] + sorted[30]) / 2, "p95MS": sorted[56],
                    "largestHeartbeatGapMS": heartbeatStats.largestGapMS, "wallMS": milliseconds(phaseStart.duration(to: .now)),
                    "cpuSeconds": cpuSeconds() - cpuBefore,
                    "footprintBeforeBytes": memoryBefore, "footprintAfterBytes": try footprint()])
            }
            try await sample(loaded: false)
            for (index, task) in tasks.enumerated() {
                python("import time,sys\nprint('LOAD_READY_\(index)',flush=True)\nsys.stdin.readline()\nend=time.monotonic()+20\nn=0\nwhile time.monotonic()<end:\n print(('LOAD_\(index)_%d_END 中文😀 abcdefghijklmnopqrstuvwxyz\\n' % n)*16, end='', flush=True)\n n+=1\n time.sleep(.005)", session: task.sessionID)
            }
            for (index, view) in views.enumerated() {
                try await wait("所有负载程序准备完成") { view.readText(viewport: true).contains("LOAD_READY_\(index)") }
            }
            for task in tasks { client.sendInput(sessionID: task.sessionID, "go\r") }
            for (index, view) in views.enumerated() {
                try await wait("并发输出已进入所有终端") { view.readText(viewport: true).contains("LOAD_\(index)_") }
            }
            func counter(_ index: Int) -> Int {
                let text = views[index].readText(viewport: true)
                let prefix = "LOAD_\(index)_"
                return text.components(separatedBy: prefix).dropFirst()
                    .compactMap { Int($0.components(separatedBy: "_END").first ?? "") }.max() ?? -1
            }
            let countersBefore = views.indices.map(counter)
            try await sample(loaded: true)
            let countersAfter = views.indices.map(counter)
            for index in views.indices {
                XCTAssertGreaterThan(countersAfter[index], countersBefore[index], "每个后台终端都必须持续收到新输出")
                let text = views[index].readText(viewport: true)
                for other in views.indices where other != index { XCTAssertFalse(text.contains("LOAD_\(other)_")) }
            }
            XCTAssertEqual(terminals(in: host).filter { view in
                tasks.contains { $0.id == (view.sessionCoordinator as? NativeTerminal.Coordinator)?.taskID }
            }.count, 8)
            for (index, view) in views.enumerated() {
                XCTAssertTrue(terminals(in: host).contains { $0 === view }, "切换不能重建已访问终端")
                client.sendInput(sessionID: tasks[index].sessionID, "\u{03}")
            }
            let report: [String: Any] = ["terminalCount": 8, "historyLinesPerTerminal": 5000,
                "windowWidth": 1280, "windowHeight": 684, "workspaceTabCount": model.workspaceTasks.count, "phases": phases,
                "loadCountersBefore": countersBefore, "loadCountersAfter": countersAfter,
                "grids": views.map { ["cols": $0.columns, "rows": $0.rows] },
                "backingScaleFactor": window.backingScaleFactor,
                "loadPreparation": "所有程序就绪后统一发送go",
                "scope": "真实RootView/8个隔离PTY；model.activate到目标NSView取得焦点；1ms轮询，非GPU呈现；CPU和内存仅本原生测试进程"]
            try FileManager.default.createDirectory(at: artifactDirectory, withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                .write(to: artifactDirectory.appendingPathComponent("native-workbench-switch.json"))
            print("NATIVE_WORKBENCH_SWITCH \(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)")
            await clean()
            try await wait("基准终端已清理") { !client.tasks.contains { $0.title.hasPrefix(prefix) } }
        } catch { await clean(); throw error }
    }

    func testRealInputRoundtripThroughPTY() async throws {
        try await verifyRealLoginTerminalSwitchAndReconnect(measureRoundtrip: true)
    }

    func testRealInputRoundtripDuringPTYOutput() async throws {
        try await verifyRealLoginTerminalSwitchAndReconnect(measureRoundtrip: true, outputLoad: true)
    }

    private func verifyRealLoginTerminalSwitchAndReconnect(measureRoundtrip: Bool, outputLoad: Bool = false) async throws {
        guard let raw = ProcessInfo.processInfo.environment["COFLUX_NATIVE_TEST_URL"],
              let url = URL(string: raw), url.scheme == "ws", url.host == "127.0.0.1" else {
            throw XCTSkip("需启动隔离 dev-fixture 并设置 COFLUX_NATIVE_TEST_URL")
        }
        let inputTrace = measureRoundtrip && ["1", "frames"].contains(ProcessInfo.processInfo.environment["COFLUX_INPUT_TRACE"] ?? "") ? InputTransportTrace() : nil
        let transport: any Transport
        if let inputTrace { transport = InputTracingTransport(trace: inputTrace) } else { transport = SocketTransport() }
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                  transport: transport, tokenStore: EmptyTokenStore())
        let suite = "dev.coflux.desktop.integration.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: suite)!
        let model = WorkbenchModel(client: client, preferences: preferences)
        let host = NSHostingView(rootView: RootView(model: model).preferredColorScheme(.dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: measureRoundtrip ? 1280 : 1360, height: measureRoundtrip ? 684 : 800),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer {
            client.logout()
            window.orderOut(nil)
            window.close()
            preferences.removePersistentDomain(forName: suite)
        }
        try await Task.sleep(for: .milliseconds(250))
        try capture(host, "native-login.png")
        client.login(username: "admin", password: "wrong-password")
        try await wait("错误密码进入失败态") { client.authState == .authFailed }
        XCTAssertFalse(client.loginError.isEmpty)
        client.login(username: "admin", password: "admin")
        try await wait("登录与首快照") { client.authState == .authed && client.snapshotRevision > 0 }
        XCTAssertFalse(client.projects.isEmpty)
        model.reconcile()
        let workspaceID = try XCTUnwrap(model.workspace?.id)
        let knownTasks = Set(client.tasks.map(\.id))
        func cleanCreatedTasks() async {
            for task in client.tasks.filter({ $0.workspaceID == workspaceID && !knownTasks.contains($0.id) }) {
                await client.closeTask(task)
            }
        }
        do {
            // 每轮用独立会话，避免长期 fixture 的身份上限和旧输出让验收失真。
            let title = "原生验收-" + UUID().uuidString
            client.createTask(workspaceID: workspaceID, title: title)
            try await wait("本轮独立终端创建") { client.tasks.contains { $0.title == title } }
            model.activate(try XCTUnwrap(client.tasks.first { $0.title == title }))
            do {
                try await wait("主工作区原生终端启动") {
                    model.activeTask?.status == .running && model.activeTask?.hasSessionID == true && !self.terminals(in: host).isEmpty
                }
            } catch {
                print("TERMINAL_START_DIAGNOSTIC", "status:", String(describing: model.activeTask?.status),
                      "hasSession:", model.activeTask?.hasSessionID ?? false,
                      "views:", self.terminals(in: host).count,
                      "connection:", client.status,
                      "error:", client.lastError?.message ?? "none")
                throw error
            }
            let first = try XCTUnwrap(model.activeTask)
            let terminal = try XCTUnwrap(terminals(in: host).first {
                ($0.sessionCoordinator as? NativeTerminal.Coordinator)?.taskID == first.id
            })
            try await wait("本轮终端取得控制权") { client.hasSessionControl(sessionID: first.sessionID) }
            let session = first.sessionID
            // 唯一标记且拆开参数，排除旧快照和输入回显造成的假阳性。
            let readyID = UUID().uuidString
            let readyMarker = "coflux:" + readyID
            client.sendInput(sessionID: session, "\u{03}printf '\\033[2J\\033[H%s:%s\\n' coflux \(readyID)\r")
            try await wait("真实 PTY 输出进入原生终端") {
                self.text(terminal).contains(readyMarker)
            }
            if measureRoundtrip {
                try await measureInputRoundtrip(terminal: terminal, client: client, sessionID: session, outputLoad: outputLoad, trace: inputTrace)
            }
            // 字符故意使用不同键盘布局的结果；物理 T 键仍须创建终端且不能发给 PTY。
            let shortcut = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
                modifierFlags: [.command], timestamp: 0, windowNumber: window.windowNumber,
                context: nil, characters: "y", charactersIgnoringModifiers: "y", isARepeat: false, keyCode: 17))
            window.makeKeyAndOrderFront(nil)
            NSApp.postEvent(shortcut, atStart: false)
            try await wait("第二个终端启动并切换") { model.activeTask?.id != first.id && model.activeTask?.status == .running }
            let second = try XCTUnwrap(model.activeTask)
            try await wait("两个原生视图同时保活") { self.terminals(in: host).contains { ($0.sessionCoordinator as? NativeTerminal.Coordinator)?.taskID == second.id } }
            model.activate(first)
            try await Task.sleep(for: .milliseconds(250))
            do {
                try await wait("设备确认原生终端控制权") { client.hasSessionControl(sessionID: session) }
            } catch {
                let current = terminal.sessionCoordinator as? NativeTerminal.Coordinator
                print("CONTROL_DIAGNOSTIC first=\(first.id) session=\(session) active=\(model.activeTask?.id ?? "nil") detached=\(client.detachedTaskIDs.contains(first.id)) coordinatorActive=\(current?.active ?? false) bound=\(current?.sessionID ?? "nil") activation=\(model.activationRequests[first.id] ?? 0)/\(current?.handledActivation ?? -1) error=\(client.lastError?.message ?? "none")")
                throw error
            }
            let uploadView = try XCTUnwrap(terminal as? UploadTerminalView)
            let coordinator = try XCTUnwrap(terminal.sessionCoordinator as? NativeTerminal.Coordinator)
            let local = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: local, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: local) }
            let fileA = local.appendingPathComponent("有 空格'文件.txt")
            let fileB = local.appendingPathComponent("second.txt")
            try Data("native-upload-a".utf8).write(to: fileA)
            try Data("native-upload-b".utf8).write(to: fileB)
            let missingFile = local.appendingPathComponent("已被移走的文件.txt")
            let errorBeforeUpload = client.lastError?.id
            // Finder 拖出后文件仍可能被移走；中间一项失败不能丢弃前后成功文件。
            uploadView.onFiles?([fileA, local, missingFile, fileB])
            XCTAssertNotNil(coordinator.uploadTask)
            // 模拟上传期间切走；路径必须留在原 coordinator，不能注入当前别的会话。
            model.activate(second)
            try await wait("原终端转入后台") { !coordinator.active }
            try await wait("多文件上传完成") { coordinator.uploadTask == nil }
            XCTAssertNotEqual(client.lastError?.id, errorBeforeUpload, "无法读取的文件必须显示错误，不能静默跳过")
            XCTAssertFalse(client.lastError?.message.isEmpty ?? true)
            model.dismissedError = client.lastError?.id
            let uploaded = coordinator.pendingPaste.split(separator: " ").map(String.init)
            XCTAssertEqual(uploaded.count, 2, client.lastError?.message ?? "上传结果未留在后台终端")
            guard uploaded.count == 2 else { throw URLError(.cannotParseResponse) }
            XCTAssertFalse(uploaded.contains { $0.contains("有") || $0.contains("'") })
            let remoteBytes = try await client.executeInWorkspace(workspaceID: first.workspaceID, command: "cat", args: uploaded)
            XCTAssertEqual(remoteBytes.exitCode, 0)
            XCTAssertEqual(remoteBytes.stdout, "native-upload-anative-upload-b")
            coordinator.pendingPaste = ""
            model.activate(first)
            try await wait("返回原终端") { coordinator.active }
            let removedUploads = try await client.executeInWorkspace(workspaceID: first.workspaceID, command: "rm", args: ["--"] + uploaded)
            XCTAssertEqual(removedUploads.exitCode, 0)

            // 图片走原生转换与真实上传，再从设备回读，避免只验证本地编码结果。
            let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 120, pixelsHigh: 80,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            let picture = try XCTUnwrap(bitmap.cgImage)
            let imageBytes = NSMutableData()
            let destination = try XCTUnwrap(CGImageDestinationCreateWithData(imageBytes, "public.tiff" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, picture, [kCGImagePropertyOrientation: 6] as CFDictionary)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
            uploadView.onImage?(imageBytes as Data, "public.tiff")
            XCTAssertNotNil(coordinator.uploadTask)
            model.activate(second)
            try await wait("图片上传期间原终端转入后台") { !coordinator.active }
            try await wait("图片上传完成") { coordinator.uploadTask == nil }
            let imagePaths = coordinator.pendingPaste.split(separator: " ").map(String.init)
            XCTAssertEqual(imagePaths.count, 1, client.lastError?.message ?? "图片路径未留在原终端")
            let imagePath = try XCTUnwrap(imagePaths.first)
            XCTAssertTrue(imagePath.hasSuffix(".png"))
            do {
                let secondTerminal = try XCTUnwrap(terminals(in: host).first {
                    ($0.sessionCoordinator as? NativeTerminal.Coordinator)?.taskID == second.id
                })
                XCTAssertFalse(text(secondTerminal).replacingOccurrences(of: "\n", with: "").contains(imagePath), "后台图片路径不能注入当前会话")
            }
            let encoded = try await client.executeInWorkspace(workspaceID: first.workspaceID, command: "sh",
                args: ["-c", "base64 < \"$1\"", "coflux-image-check", imagePath])
            XCTAssertEqual(encoded.exitCode, 0)
            let remoteImage = try XCTUnwrap(Data(base64Encoded: encoded.stdout, options: .ignoreUnknownCharacters))
            let remoteSource = try XCTUnwrap(CGImageSourceCreateWithData(remoteImage as CFData, nil))
            let remoteBitmap = try XCTUnwrap(CGImageSourceCreateImageAtIndex(remoteSource, 0, nil))
            XCTAssertEqual(remoteBitmap.width, 80)
            XCTAssertEqual(remoteBitmap.height, 120)
            let removedImage = try await client.executeInWorkspace(workspaceID: first.workspaceID, command: "rm", args: ["--", imagePath])
            XCTAssertEqual(removedImage.exitCode, 0)
            model.activate(first)
            try await wait("图片验收后返回原终端") { coordinator.active && client.hasSessionControl(sessionID: session) }
            do {
                try await wait("后台图片路径只在返回原终端后插入") {
                    // Buffer 导出在自动折行处插入换行；本测试 UUID 路径不含换行，比较时去除这些视觉分行。
                    coordinator.pendingPaste.isEmpty && self.text(terminal).replacingOccurrences(of: "\n", with: "").contains(imagePath)
                }
            } catch {
                print("IMAGE_PASTE_DIAGNOSTIC pending=\(coordinator.pendingPaste) control=\(client.hasSessionControl(sessionID: session)) path=\(imagePath) terminal=\(text(terminal).suffix(1200))")
                throw error
            }
            // 清掉测试路径所在的 shell 输入行，不执行已清理的图片路径。
            client.sendInput(sessionID: session, "\u{15}")
            client.sendInput(sessionID: session, "printf '\\033]0;native-title\\007'\r")
            try await wait("OSC 标题同步") { model.terminalTitles[session] == "native-title" }
            XCTAssertTrue(terminals(in: host).contains { $0 === terminal })
            XCTAssertTrue(text(terminal).contains(readyMarker))
            XCTAssertEqual(model.activeTask?.sessionID, session)
            try capture(host, "native-workbench.png")

            let probe = try await client.executeInWorkspace(workspaceID: first.workspaceID, command: "sh", args: ["-c", "printf '/* 中文注释 */\\nconst answer: number = 42;\\nconst label = \"你好\";\\n' > native-highlight-probe.ts"])
            XCTAssertEqual(probe.exitCode, 0)
            model.openChanges(first.workspaceID)
            try await Task.sleep(for: .seconds(1))
            try capture(host, "native-changes.png")
            model.activate(first)
            let removedProbe = try await client.executeInWorkspace(workspaceID: first.workspaceID, command: "rm", args: ["--", "native-highlight-probe.ts"])
            XCTAssertEqual(removedProbe.exitCode, 0)

            let revision = client.snapshotRevision
            client.suspend()
            XCTAssertEqual(client.status, .disconnected)
            XCTAssertFalse(client.hasSessionControl(sessionID: session))
            do {
                _ = try await client.uploadSessionFile(sessionID: session, data: Data([1]), suggestedName: "must-not-upload")
                XCTFail("断线时不得上传")
            } catch {}
            XCTAssertEqual(client.authState, .authed)
            XCTAssertFalse(client.workspaces.isEmpty)
            client.resume()
            try await wait("重新连接取得新快照") { client.status == .connected && client.snapshotRevision > revision }
            // 重连期间保留 consumer，输出仍进入原来的终端对象。
            client.sendInput(sessionID: session, "printf '%s:%s\\n' reconnect preserved\r")
            try await wait("重连后原终端继续收发") { self.text(terminal).contains("reconnect:preserved") }
            XCTAssertTrue(terminals(in: host).contains { $0 === terminal })
            // 第二个真实客户端接管；原生标签显式点击才能拿回，后台刷新不能争抢。
            let competitor = CofluxClient(configuration: ClientConfiguration(serverURL: url, buildID: "dev"),
                                          transport: SocketTransport(), tokenStore: EmptyTokenStore())
            defer { competitor.logout() }
            competitor.login(username: "admin", password: "admin")
            try await wait("竞争客户端登录") { competitor.snapshotRevision > 0 }
            competitor.startTask(taskID: first.id, cols: 91, rows: 31, force: true)
            try await wait("另一客户端取得控制权") {
                competitor.hasSessionControl(sessionID: session) && client.detachedTaskIDs.contains(first.id)
            }
            XCTAssertFalse(coordinator.canUpload)
            model.reconcile()
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertTrue(competitor.hasSessionControl(sessionID: session))
            // 仅隐藏后重新显示（工作区切换/变更页返回）不是用户主动接管。
            let detached = try XCTUnwrap(client.tasks.first { $0.id == first.id })
            let activation = coordinator.handledActivation
            coordinator.update(task: detached, active: false, activationRequest: activation)
            coordinator.update(task: detached, active: true, activationRequest: activation)
            XCTAssertTrue(client.detachedTaskIDs.contains(first.id), "面板重新显示不能清掉被接管状态")
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertTrue(competitor.hasSessionControl(sessionID: session), "显示旧面板不能抢走另一客户端的控制权")
            coordinator.resize?.cancel()
            coordinator.resize = nil
            coordinator.sizeChanged(source: terminal, newCols: 37, newRows: 9)
            XCTAssertNil(coordinator.resize, "已失去控制权的可见终端不能继续排队发送窗口尺寸")
            model.activate(first)
            try await wait("点击已接管标签拿回控制权") {
                client.hasSessionControl(sessionID: session) && competitor.detachedTaskIDs.contains(first.id)
            }
            client.sendInput(sessionID: session, "printf '%s:%s\\n' reclaimed native\r")
            try await wait("接管后输入恢复") { self.text(terminal).contains("reclaimed:native") }
            coordinator.sizeChanged(source: terminal, newCols: 93, newRows: 29)
            await coordinator.resize?.value
            // 从真实 PTY 读取尺寸，而不是仅观察本地模型里的行列数。
            try await Task.sleep(for: .milliseconds(150))
            client.sendInput(sessionID: session, "printf 'native-size:'; stty size\r")
            try await wait("接管后远端 PTY 收到尺寸变化") { self.text(terminal).contains("native-size:29 93") }
            for (size, marker) in [(NSSize(width: 1040, height: 700), "window-small"),
                                   (NSSize(width: 1360, height: 800), "window-restored")] {
                let previous = (terminal.columns, terminal.rows)
                window.setContentSize(size)
                try await wait("原生窗口缩放更新文字栅格") {
                    host.layoutSubtreeIfNeeded()
                    return terminal.columns != previous.0 || terminal.rows != previous.1
                }
                // 等待Coordinator合并尺寸更新，再从远端stty读回实际值。
                try await Task.sleep(for: .milliseconds(200))
                await coordinator.resize?.value
                let grid = terminal
                let expected = "\(marker):\(grid.rows) \(grid.columns)"
                client.sendInput(sessionID: session, "printf '%s:' \(marker); stty size\r")
                try await wait("窗口缩放后的真实PTY尺寸一致") { self.text(terminal).contains(expected) }
            }
            competitor.logout()

            // 已退出标签再次点击必须启动新 session，同时保留同一个 AppKit 视图。
            model.activate(second)
            try await wait("第二终端持有控制权") { client.hasSessionControl(sessionID: second.sessionID) }
            weak var restartView = autoreleasepool { terminals(in: host).first {
                ($0.sessionCoordinator as? NativeTerminal.Coordinator)?.taskID == second.id
            } }
            XCTAssertNotNil(restartView)
            client.sendInput(sessionID: second.sessionID, "printf '%s:%s\\n' before restart-marker\r")
            try await wait("重启前旧会话输出") { restartView.map { self.text($0).contains("before:restart-marker") } == true }
            client.sendInput(sessionID: second.sessionID, "exit\r")
            try await wait("第二终端退出") { client.tasks.contains { $0.id == second.id && $0.status == .exited } }
            let exited = try XCTUnwrap(client.tasks.first { $0.id == second.id })
            model.activate(exited)
            do {
                try await wait("点击退出标签启动新会话") {
                    client.tasks.contains { $0.id == second.id && $0.status == .running && $0.sessionID != second.sessionID }
                }
            } catch {
                let state = client.tasks.first { $0.id == second.id }
                let current = terminals(in: host).compactMap { $0.sessionCoordinator as? NativeTerminal.Coordinator }
                    .first { $0.taskID == second.id }
                print("RESTART_DIAGNOSTIC task=\(String(describing: state)) error=\(client.lastError?.message ?? "none") starting=\(current?.starting ?? false) activation=\(model.activationRequests[second.id] ?? 0)/\(current?.handledActivation ?? -1)")
                throw error
            }
            let restarted = try XCTUnwrap(client.tasks.first { $0.id == second.id })
            try await wait("新会话取得控制权") { client.hasSessionControl(sessionID: restarted.sessionID) }
            XCTAssertTrue(terminals(in: host).contains { $0 === restartView }, "重启应复用原生视图")
            XCTAssertFalse(restartView.map { self.text($0).contains("before:restart-marker") } ?? true, "新会话不能残留旧输出")
            client.sendInput(sessionID: restarted.sessionID, "printf '%s:%s\\n' after restart-marker\r")
            try await wait("重启后真实新会话输出") { restartView.map { self.text($0).contains("after:restart-marker") } == true }
            model.activate(first)
            model.requestClose(first)
            XCTAssertEqual(model.pendingClose?.id, first.id)
            model.pendingClose = nil
            XCTAssertTrue(client.tasks.contains { $0.id == first.id })
            // 先验证第二个任务关闭释放视图；其余本轮任务由统一清理处理。
            weak var closingView = autoreleasepool { terminals(in: host).first {
                ($0.sessionCoordinator as? NativeTerminal.Coordinator)?.taskID == second.id
            } }
            weak var closingCoordinator = closingView?.sessionCoordinator as? NativeTerminal.Coordinator
            XCTAssertNotNil(closingView)
            XCTAssertNotNil(closingCoordinator)
            await client.closeTask(restarted)
            try await wait("关闭任务归约") { !client.tasks.contains { $0.id == second.id } }
            try await wait("关闭标签释放原生视图和Coordinator", timeout: .seconds(5)) { [weak closingView, weak closingCoordinator] in
                autoreleasepool { host.layoutSubtreeIfNeeded() }
                return closingView == nil && closingCoordinator == nil
            }
            model.terminalTitles[session] = "仍存活的会话"
            model.terminalTitles["removed-session"] = "已删除会话的长标题"
            model.activeTasks["removed-workspace"] = second.id
            model.showingChanges.insert("removed-workspace")
            model.uploadingTasks.insert(second.id)
            model.draggingTasks.insert(second.id)
            model.reconcile()
            XCTAssertEqual(model.terminalTitles[session], "仍存活的会话")
            XCTAssertNil(model.terminalTitles["removed-session"])
            XCTAssertNil(model.activeTasks["removed-workspace"])
            XCTAssertFalse(model.showingChanges.contains("removed-workspace"))
            XCTAssertFalse(model.uploadingTasks.contains(second.id))
            XCTAssertFalse(model.draggingTasks.contains(second.id))
        } catch {
            await cleanCreatedTasks()
            throw error
        }
        await cleanCreatedTasks()
    }

    private func measureInputRoundtrip(terminal: GhosttyTerminalView, client: CofluxClient, sessionID: String, outputLoad: Bool, trace: InputTransportTrace? = nil) async throws {
        let ready = "RT-READY-" + UUID().uuidString
        let code = #"""
import os,tty,termios,select,time
load = OUTPUT_LOAD
load_bytes = 0
next_output = time.monotonic()
payload = ("\x1b[32m持续输出 中文 emoji 🚀 " + "x" * 64 + "\x1b[0m\r\n").encode() * 16
previous = termios.tcgetattr(0)
try:
    tty.setraw(0)
    os.write(1, b"READY\r\n")
    pending = b""
    while True:
        if load and time.monotonic() >= next_output:
            os.write(1, payload)
            load_bytes += len(payload)
            next_output = time.monotonic() + 0.005
        if not select.select([0], [], [], 0.001)[0]:
            continue
        value = os.read(0,1)
        if value == b"\x04":
            break
        if value in (b"\r",b"\n"):
            os.write(1,b"ACK:"+pending+b":loadBytes="+str(load_bytes).encode()+b"\r\n")
            pending = b""
        else:
            pending += value
finally:
    termios.tcsetattr(0,termios.TCSANOW,previous)
"""#.replacingOccurrences(of: "READY", with: ready)
            .replacingOccurrences(of: "OUTPUT_LOAD", with: outputLoad ? "True" : "False")
        let encoded = Data(code.utf8).base64EncodedString()
        // 编码后启动，避免 shell 回显中的 READY 字面量冒充程序已准备完成。
        client.sendInput(sessionID: sessionID, "python3 -u -c \"import base64;exec(base64.b64decode('\(encoded)'))\"\r")
        defer { client.sendInput(sessionID: sessionID, "\u{04}") }
        // 准备标记可能在等待期间滚出视口；仅准备阶段读一次历史，不参与采样。
        try await wait("PTY 测量程序进入无本地回显模式") { terminal.readText().contains(ready) }
        var samples: [Double] = []
        var observedLoadBytes = 0
        var transportSamples: [[String: Double]] = []
        let compareFrames = trace != nil && ProcessInfo.processInfo.environment["COFLUX_INPUT_TRACE"] == "frames"
        for index in 0..<(compareFrames ? 46 : 31) {
            // 各探针间让真实 PTY 持续输出，间隔不计入输入往返时间。
            if outputLoad { try await Task.sleep(for: .milliseconds(20)) }
            let marker = "probe-\(index)-" + UUID().uuidString
            let response = "ACK:" + marker
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: terminal.window?.windowNumber ?? 0,
                context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
            trace?.begin(sessionID: sessionID, marker: marker)
            let start = ContinuousClock.now
            let inputMode = compareFrames ? index % 3 : trace != nil ? index % 2 : 0
            let directClientInput = inputMode != 0
            if inputMode == 2 {
                client.sendInput(sessionID: sessionID, marker + "\r")
            } else if directClientInput {
                client.sendInput(sessionID: sessionID, marker)
                client.sendInput(sessionID: sessionID, "\r")
            } else {
                terminal.insertText(marker, replacementRange: NSRange(location: NSNotFound, length: 0))
                terminal.keyDown(with: event)
            }
            let deadline = start + .seconds(5)
            while !terminal.readText(viewport: true).contains(response) {
                guard ContinuousClock.now < deadline else {
                    if let trace { print("NATIVE_INPUT_TRACE_TIMEOUT \(trace.snapshot()) historyContainsACK=\(terminal.readText().contains(response))") }
                    XCTFail("原生输入没有收到 PTY 确认"); throw URLError(.timedOut)
                }
                try await Task.sleep(for: .milliseconds(1))
            }
            let duration = start.duration(to: .now)
            samples.append(Double(duration.components.seconds)*1000 + Double(duration.components.attoseconds)/1e15)
            if let trace {
                var sample = trace.snapshot(); sample["index"] = Double(index); sample["roundtripMS"] = samples.last!
                sample["directClientInput"] = directClientInput ? 1 : 0
                sample["inputMode"] = Double(inputMode)
                if directClientInput { XCTAssertEqual(sample["sentFrames"], inputMode == 2 ? 1 : 2) }
                XCTAssertNotNil(sample["firstSendMS"], "诊断必须观察到真实输入帧")
                XCTAssertNotNil(sample["ackReceivedMS"], "诊断必须观察到真实PTY确认帧")
                XCTAssertEqual(sample["sentBytes"], Double(marker.utf8.count + 1), "文本与回车字节应完整送入传输")
                transportSamples.append(sample)
            }
            if outputLoad {
                let content = terminal.readText(viewport: true)
                if let range = content.range(of: response + ":loadBytes=") {
                    let digits = content[range.upperBound...].prefix(while: { $0.isNumber })
                    let byteCount = try XCTUnwrap(Int(digits))
                    XCTAssertGreaterThan(byteCount, observedLoadBytes, "每次探针前应有新 PTY 输出")
                    observedLoadBytes = byteCount
                } else {
                    XCTFail("缺少负载计数")
                }
            }
        }
        let measured = Array(samples.dropFirst()), sorted = measured.sorted()
        let result: [String: Any] = [
            "samplesMS": measured, "warmupMS": samples[0],
            "outputLoad": outputLoad, "observedLoadBytes": observedLoadBytes,
            "cols": terminal.columns, "rows": terminal.rows, "windowWidth": 1280, "windowHeight": 684,
            "diagnosticOnly": trace != nil,
            "backingScaleFactor": terminal.window?.backingScaleFactor ?? 0,
            "medianMS": (sorted[(sorted.count-1)/2]+sorted[sorted.count/2])/2,
            "p95MS": sorted[Int(ceil(Double(sorted.count)*0.95))-1],
            "scope": "真实 RootView；原生文本提交+回车→本机隔离 relay→PTY 程序 ACK→终端缓冲区；1ms轮询，不含GPU呈现",
        ]
        try FileManager.default.createDirectory(at: artifactDirectory, withIntermediateDirectories: true)
        let resultName = trace != nil ? "native-input-transport-diagnostic.json"
            : outputLoad ? "native-input-roundtrip-loaded.json" : "native-input-roundtrip.json"
        try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            .write(to: artifactDirectory.appendingPathComponent(resultName))
        if trace != nil { print("NATIVE_INPUT_TRANSPORT_TRACE \(String(data: try JSONSerialization.data(withJSONObject: transportSamples, options: [.sortedKeys]), encoding: .utf8)!)") }
        print("NATIVE_INPUT_ROUNDTRIP \(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)")
    }

    private func wait(_ label: String, timeout: Duration = .seconds(20), until condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            if ContinuousClock.now >= deadline { XCTFail(label); throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(30))
        }
    }
    private func terminals(in view: NSView) -> [GhosttyTerminalView] {
        // NSView.subviews 的桥接临时数组会保留子视图；测量释放前排空这层引用。
        autoreleasepool {
            (view as? GhosttyTerminalView).map { [$0] } ?? view.subviews.flatMap { terminals(in: $0) }
        }
    }
    private func text(_ view: GhosttyTerminalView) -> String {
        view.readText()
    }
    private func capture(_ host: NSView, _ name: String) throws {
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try FileManager.default.createDirectory(at: artifactDirectory, withIntermediateDirectories: true)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: artifactDirectory.appendingPathComponent(name))
    }
}

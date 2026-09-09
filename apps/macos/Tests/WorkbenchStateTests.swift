import AppKit
import Observation
@testable import CofluxClientCore
import CofluxProtocol
import XCTest
@testable import Coflux

final class WorkbenchStateTests: XCTestCase {
    @MainActor func testVisitedTabSwitchDoesNotInvalidateUnchangedMembership() throws {
        let suite = "dev.coflux.tab-observation." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: preferences)
        defer { preferences.removePersistentDomain(forName: suite) }
        var first = Coflux_V1_Task(); first.id = "first"; first.workspaceID = "workspace"
        var second = first; second.id = "second"
        model.activate(first); model.activate(second)
        let activation = model.activationRequests[first.id, default: 0]
        withObservationTracking {
            _ = model.visitedTasks
            _ = model.showingChanges
        } onChange: {
            XCTFail("已访问标签之间切换不应通知没有变化的集合")
        }
        model.activate(first)
        XCTAssertEqual(model.activeTasks[first.workspaceID], first.id)
        XCTAssertEqual(model.activationRequests[first.id], activation + 1, "显式激活仍必须发出新的焦点/接管请求")
    }

    @MainActor func testEmptyRenameIsRejectedBeforeSendingButWorkspaceCanReset() throws {
        let suite = "dev.coflux.rename-validation." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: preferences)
        defer { model.logout(); preferences.removePersistentDomain(forName: suite) }
        for entity in [WorkbenchEntity.device, .project] {
            model.dialog = .rename(entity, "id", "original")
            model.rename(entity, id: "id", name: " \t\n ")
            XCTAssertNotNil(model.dialog)
            XCTAssertNil(client.lastError, "空名称应在发送入口前拒绝，不能触发离线命令错误")
        }
        model.dialog = .rename(.workspace, "id", "original")
        model.rename(.workspace, id: "id", name: " \t\n ")
        XCTAssertEqual(client.lastError?.message, "中心未连接，无法执行此操作", "工作区清空应进入发送路径，离线时保留对话框")
        XCTAssertNotNil(model.dialog)
    }

    @MainActor func testShortcutNavigationAcrossChangesPendingAndWorkspaces() throws {
        let suite = "dev.coflux.shortcut-navigation." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: preferences)
        defer { model.logout(); preferences.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "account"; client.apply(.authOk(auth))
        var a = Coflux_V1_Workspace(); a.id = "a"
        var b = a; b.id = "b"
        var first = Coflux_V1_Task(); first.id = "first"; first.workspaceID = a.id; first.createdAt = 1; first.status = .running
        var second = first; second.id = "second"; second.createdAt = 2
        var background = first; background.id = "background"; background.workspaceID = b.id
        var snapshot = Coflux_V1_StateSnapshot(); snapshot.workspaces = [a, b]; snapshot.tasks = [second, background, first]
        client.apply(.stateSnapshot(snapshot))
        model.select(.workspace(b.id)); model.activate(background)
        model.select(.workspace(a.id)); model.activate(first); model.openChanges(a.id)
        model.performShortcut(.next)
        XCTAssertEqual(model.activeTask?.id, second.id)
        XCTAssertFalse(model.showingChanges.contains(a.id), "切换终端快捷键必须离开变更页")
        model.performShortcut(.next)
        XCTAssertEqual(model.activeTask?.id, first.id, "最后一个标签向后循环到第一个")
        model.performShortcut(.previous)
        XCTAssertEqual(model.activeTask?.id, second.id)
        model.performShortcut(.tab(8))
        XCTAssertEqual(model.activeTask?.id, second.id, "不存在的数字标签不改变选择")
        model.performShortcut(.createTerminal)
        XCTAssertNotNil(model.selectedPendingTerminal)
        model.performShortcut(.closeTerminal)
        XCTAssertNil(model.pendingClose, "创建占位不能误关闭之前的真实终端")
        model.performShortcut(.previous)
        XCTAssertEqual(model.activeTask?.id, second.id, "与 Web 一样从占位按第一个真实标签为基准循环")
        XCTAssertTrue(model.creatingTerminal, "切离占位不能取消创建")
        model.performShortcut(.closeTerminal)
        XCTAssertEqual(model.pendingClose?.id, second.id)
        XCTAssertEqual(model.activeTasks[b.id], background.id, "快捷键不得修改后台工作区")
        model.performShortcut(.help); XCTAssertTrue(model.showHelp)
        model.performShortcut(.help); XCTAssertFalse(model.showHelp)
    }

    @MainActor func testPendingTerminalSelectionDoesNotActivateOrStealFromRealTab() throws {
        let suite = "dev.coflux.pending-tab." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: preferences)
        defer { model.logout(); preferences.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "account"
        client.apply(.authOk(auth))
        var workspace = Coflux_V1_Workspace(); workspace.id = "workspace"
        var first = Coflux_V1_Task(); first.id = "first"; first.workspaceID = workspace.id; first.createdAt = 1
        var second = first; second.id = "second"; second.createdAt = 2
        var snapshot = Coflux_V1_StateSnapshot(); snapshot.workspaces = [workspace]; snapshot.tasks = [first, second]
        client.apply(.stateSnapshot(snapshot))
        model.select(.workspace(workspace.id))
        model.openChanges(workspace.id)
        model.createTerminal()
        XCTAssertEqual(model.selectedPendingTerminal?.title, "终端 3")
        XCTAssertNil(model.activeTask, "占位条目不能回落成真实任务并触发终端激活")
        XCTAssertFalse(model.showingChanges.contains(workspace.id))
        XCTAssertTrue(model.activationRequests.isEmpty, "占位条目不能进入 attach 激活路径")
        // 用户主动返回已有 Tab，创建结果到来后保持这一选择。
        model.activate(second)
        XCTAssertNil(model.selectedPendingTerminal)
        XCTAssertTrue(model.creatingTerminal)
        var created = first; created.id = "created"; created.createdAt = 3
        snapshot.tasks.append(created)
        client.apply(.stateSnapshot(snapshot)); model.reconcile()
        XCTAssertEqual(model.activeTask?.id, second.id)
        XCTAssertFalse(model.creatingTerminal)
        // 再次创建并保持占位选择，应自动转成新增的真实 Tab。
        model.createTerminal()
        model.activate(first)
        model.selectPendingTerminal(workspaceID: workspace.id)
        XCTAssertNil(model.activeTask)
        var next = first; next.id = "next"; next.createdAt = 4
        snapshot.tasks.append(next)
        client.apply(.stateSnapshot(snapshot)); model.reconcile()
        XCTAssertEqual(model.activeTask?.id, next.id)
        XCTAssertNil(model.selectedPendingTerminal)
        // 超时撤占位时回落到第一个真实任务，而不是把临时 ID 当作真实任务。
        model.createTerminal()
        model.finishCreate(workspaceID: workspace.id)
        XCTAssertEqual(model.activeTask?.id, first.id)
    }

    @MainActor func testTerminalCreationIsScopedToWorkspaceAndSnapshot() throws {
        let suite = "dev.coflux.creation-scope." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: preferences)
        defer { model.logout(); preferences.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "account"
        client.apply(.authOk(auth))
        var a = Coflux_V1_Workspace(); a.id = "a"
        var b = Coflux_V1_Workspace(); b.id = "b"
        var snapshot = Coflux_V1_StateSnapshot(); snapshot.workspaces = [a, b]
        client.apply(.stateSnapshot(snapshot))
        model.select(.workspace(a.id))
        model.createTerminal()
        XCTAssertTrue(model.creatingTerminal)
        model.select(.workspace(b.id))
        XCTAssertFalse(model.creatingTerminal, "A 的创建不能禁用 B 的新建按钮")
        model.createTerminal()
        XCTAssertTrue(model.creatingTerminal)
        model.select(.workspace(a.id))
        XCTAssertTrue(model.creatingTerminal, "切换工作区不能丢掉 A 的等待状态")
        // B 先完成时，只收敛 B；不能结束 A 或抢走工作区选择。
        var task = Coflux_V1_Task(); task.id = "b-new"; task.workspaceID = b.id
        snapshot.tasks = [task]
        client.apply(.stateSnapshot(snapshot))
        model.reconcile()
        XCTAssertEqual(model.selection, .workspace(a.id))
        XCTAssertTrue(model.creatingTerminal)
        XCTAssertEqual(model.activeTasks[b.id], task.id)
        model.select(.workspace(b.id))
        XCTAssertFalse(model.creatingTerminal)
        // 清理/超时某一工作区也不能撤销另一工作区的请求。
        model.createTerminal()
        model.finishCreate(workspaceID: a.id)
        XCTAssertTrue(model.creatingTerminal)
        model.select(.workspace(a.id))
        XCTAssertFalse(model.creatingTerminal)
        model.finishCreate()
        model.select(.workspace(b.id))
        XCTAssertFalse(model.creatingTerminal)
    }

    @MainActor func testOldBranchSwitchCannotClearNewLoginBusyState() async throws {
        let suite = "dev.coflux.branch-logout." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: preferences)
        defer { model.logout(); preferences.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "same-account"
        client.apply(.authOk(auth))
        let request = try XCTUnwrap(model.switchBranch(workspaceID: "workspace", branch: "feature", createNew: true))
        // 不让旧任务先执行：验证已排队的操作不能越过退出/同账号重登边界。
        model.logout()
        client.apply(.authOk(auth))
        model.pendingBranches["workspace"] = "feature"
        await request.value
        XCTAssertEqual(model.pendingBranches["workspace"], "feature")
    }

    @MainActor func testDeviceCreateOfflineAndCancelledRequestCanRetry() async throws {
        let suite = "dev.coflux.device-retry." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: preferences)
        defer { model.logout(); preferences.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "account"; client.apply(.authOk(auth))
        var daemon = Coflux_V1_DaemonInfo(); daemon.daemonID = "device"; daemon.online = false
        var snapshot = Coflux_V1_StateSnapshot(); snapshot.daemons = [daemon]; client.apply(.stateSnapshot(snapshot))
        await model.createDeviceTerminal(daemon.daemonID)
        XCTAssertTrue(model.creatingDeviceTerminals.isEmpty)
        XCTAssertTrue(model.deviceTerminalErrors.isEmpty)
        daemon.online = true; snapshot.daemons = [daemon]; client.apply(.stateSnapshot(snapshot))
        // 两次请求各自停在 relay 授权等待；取消必须释放忙态，随后允许重新发起。
        for _ in 0..<2 {
            let request = Task { await model.createDeviceTerminal(daemon.daemonID) }
            let deadline = ContinuousClock.now + .seconds(2)
            while !model.creatingDeviceTerminals.contains(daemon.daemonID) {
                guard ContinuousClock.now < deadline else {
                    request.cancel(); await request.value
                    return XCTFail("在线设备请求未进入忙态")
                }
                try await Task.sleep(for: .milliseconds(10))
            }
            let cancelledAt = ContinuousClock.now
            request.cancel(); await request.value
            XCTAssertLessThan(cancelledAt.duration(to: .now), .seconds(1), "取消不应等待 RPC 超时")
            XCTAssertFalse(model.creatingDeviceTerminals.contains(daemon.daemonID))
            XCTAssertNil(model.deviceTerminalErrors[daemon.daemonID], "用户取消不能显示为设备故障")
        }
        XCTAssertTrue(client.tasks.isEmpty)
    }

    @MainActor func testOldDeviceRequestCannotOverwriteStateAfterSameAccountRelogin() async throws {
        let suite = "dev.coflux.logout-race." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: preferences)
        defer { model.logout(); preferences.removePersistentDomain(forName: suite) }
        var auth = Coflux_V1_AuthOk(); auth.accountID = "same-account"
        var daemon = Coflux_V1_DaemonInfo(); daemon.daemonID = "device"; daemon.online = true
        var snapshot = Coflux_V1_StateSnapshot(); snapshot.daemons = [daemon]
        // 只投递控制面事件，不建立网络连接；设备请求停在等待 relay 授权的阶段。
        client.apply(.authOk(auth))
        client.apply(.stateSnapshot(snapshot))
        let oldRequest = Task { await model.createDeviceTerminal(daemon.daemonID) }
        let deadline = ContinuousClock.now + .seconds(2)
        while !model.creatingDeviceTerminals.contains(daemon.daemonID) {
            guard ContinuousClock.now < deadline else {
                oldRequest.cancel()
                XCTFail("旧请求未进入等待状态")
                return
            }
            await Task.yield()
        }
        model.logout()
        // 同一账号重新登录也必须隔离代次，不能只比较 accountID。
        client.apply(.authOk(auth))
        client.apply(.stateSnapshot(snapshot))
        model.creatingDeviceTerminals.insert(daemon.daemonID)
        model.deviceTerminalErrors[daemon.daemonID] = "新请求的错误"
        await oldRequest.value
        XCTAssertTrue(model.creatingDeviceTerminals.contains(daemon.daemonID), "旧请求的 defer 不能清除新请求忙态")
        XCTAssertEqual(model.deviceTerminalErrors[daemon.daemonID], "新请求的错误", "旧请求的取消错误不能覆盖新状态")
    }

    @MainActor func testLogoutClearsAccountPresentationWithoutResettingWindowPreference() throws {
        let suite = "dev.coflux.logout-test." + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        preferences.set(320, forKey: "sidebarWidth")
        let client = CofluxClient(configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:1/client")!, buildID: "dev"),
                                  transport: SocketTransport(), tokenStore: EmptyTokenStore())
        let model = WorkbenchModel(client: client, preferences: preferences)
        model.terminalTitles["old-session"] = "旧账号标题"
        model.uploadingTasks.insert("old-task")
        model.draggingTasks.insert("old-task")
        model.pendingBranches["old-workspace"] = "branch"
        model.collapsedProjects.insert("old-project")
        model.creatingDeviceTerminals.insert("old-device")
        model.deviceTerminalErrors["old-device"] = "旧错误"
        model.pendingClose = Coflux_V1_Task()
        model.dialog = .enrollment
        model.showHelp = true
        model.logout()
        XCTAssertTrue(model.terminalTitles.isEmpty)
        XCTAssertTrue(model.uploadingTasks.isEmpty)
        XCTAssertTrue(model.draggingTasks.isEmpty)
        XCTAssertTrue(model.pendingBranches.isEmpty)
        XCTAssertTrue(model.collapsedProjects.isEmpty)
        XCTAssertTrue(model.creatingDeviceTerminals.isEmpty)
        XCTAssertTrue(model.deviceTerminalErrors.isEmpty)
        XCTAssertNil(model.pendingClose)
        XCTAssertNil(model.dialog)
        XCTAssertFalse(model.showHelp)
        XCTAssertEqual(preferences.integer(forKey: "sidebarWidth"), 320)
    }
    func testSelectionRecoversToOldestProjectMainWorkspace() {
        var project = Coflux_V1_Project(); project.id = "p"; project.createdAt = 1
        var main = Coflux_V1_Workspace(); main.id = "main"; main.projectID = "p"; main.isMain = true
        var branch = main; branch.id = "branch"; branch.isMain = false
        XCTAssertEqual(WorkbenchState.resolve(.workspace("removed"), projects: [project], workspaces: [branch, main], daemons: []), .workspace("main"))
        XCTAssertEqual(WorkbenchState.resolve(.workspace("branch"), projects: [project], workspaces: [branch, main], daemons: []), .workspace("branch"))
    }
    func testOfflineDeviceSelectionSurvivesSnapshot() {
        var daemon = Coflux_V1_DaemonInfo(); daemon.daemonID = "d"; daemon.online = false
        XCTAssertEqual(WorkbenchState.resolve(.device("d"), projects: [], workspaces: [], daemons: [daemon]), .device("d"))
    }
    func testClosingBackgroundTabDoesNotSwitchForeground() {
        var a = Coflux_V1_Task(); a.id = "a"
        var b = Coflux_V1_Task(); b.id = "b"
        XCTAssertEqual(WorkbenchState.taskID("b", tasks: [a, b]), "b")
        XCTAssertEqual(WorkbenchState.taskID("b", tasks: [b]), "b")
        XCTAssertEqual(WorkbenchState.taskID("b", tasks: [a]), "a")
    }
    func testPhysicalShortcutsAndModifierExclusions() {
        XCTAssertEqual(WorkbenchShortcut.resolve(keyCode: 45, modifiers: .command), .createWorkspace)
        XCTAssertEqual(WorkbenchShortcut.resolve(keyCode: 17, modifiers: [.command, .capsLock]), .createTerminal)
        XCTAssertEqual(WorkbenchShortcut.resolve(keyCode: 22, modifiers: .command), .tab(5))
        XCTAssertEqual(WorkbenchShortcut.resolve(keyCode: 25, modifiers: .command), .tab(8))
        for modifiers: NSEvent.ModifierFlags in [[], .control, [.command, .shift], [.command, .option], [.command, .control]] {
            XCTAssertNil(WorkbenchShortcut.resolve(keyCode: 17, modifiers: modifiers))
        }
        XCTAssertNil(WorkbenchShortcut.resolve(keyCode: 0, modifiers: .command))
    }
    func testWidthRejectsNonFiniteAndClampsToWebBounds() {
        XCTAssertEqual(WorkbenchState.sidebarWidth(.nan), 260)
        XCTAssertEqual(WorkbenchState.sidebarWidth(.infinity), 260)
        XCTAssertEqual(WorkbenchState.sidebarWidth(0), 200)
        XCTAssertEqual(WorkbenchState.sidebarWidth(900), 480)
    }
    func testPendingWorkspaceMatchesProjectDeviceBranchAndNewIdentity() {
        let pending = PendingWorkspace(id: "local", projectID: "p", daemonID: "d", branch: "feature", knownIDs: ["old"])
        var workspace = Coflux_V1_Workspace(); workspace.id = "old"; workspace.projectID = "p"; workspace.daemonID = "d"; workspace.branch = "feature"
        XCTAssertNil(pending.match(in: [workspace]))
        workspace.id = "new"; workspace.branch = "another-client"
        XCTAssertNil(pending.match(in: [workspace]))
        workspace.branch = "feature"; workspace.daemonID = "other-device"
        XCTAssertNil(pending.match(in: [workspace]))
        workspace.daemonID = "d"
        XCTAssertEqual(pending.match(in: [workspace])?.id, "new")
    }

}

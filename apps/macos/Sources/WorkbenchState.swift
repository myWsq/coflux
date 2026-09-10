import CofluxClientCore
import CofluxProtocol
import Foundation
import Observation

enum Selection: Codable, Equatable {
    case workspace(String)
    case device(String)
}

/// 纯决策对应当前 Web workbench-state.ts；UI 不自行猜测快照、选择与关闭语义。
enum WorkbenchState {
    static func sidebarWidth(_ width: Double) -> Double {
        width.isFinite ? min(480, max(200, width)) : 260
    }

    static func resolve(_ selection: Selection?, projects: [Coflux_V1_Project],
                        workspaces: [Coflux_V1_Workspace], daemons: [Coflux_V1_DaemonInfo]) -> Selection? {
        switch selection {
        case .workspace(let id) where workspaces.contains(where: { $0.id == id }): return selection
        case .device(let id) where daemons.contains(where: { $0.daemonID == id }): return selection
        default: break
        }
        let first = projects.min { $0.createdAt < $1.createdAt }
        let workspace = workspaces.first { $0.projectID == first?.id && $0.isMain } ?? workspaces.first
        return workspace.map { .workspace($0.id) }
    }

    static func taskID(_ selected: String?, tasks: [Coflux_V1_Task]) -> String? {
        if let selected, tasks.contains(where: { $0.id == selected }) { return selected }
        return tasks.first?.id
    }
}

struct PendingTerminal {
    let title: String
    let knownIDs: Set<String>
}

@MainActor @Observable
final class WorkbenchModel {
    let client: CofluxClient
    let preferences: UserDefaults
    var selection: Selection?
    var activeTasks: [String: String] = [:]
    var visitedTasks = Set<String>()
    var activationRequests: [String: Int] = [:]
    var collapsedProjects = Set<String>()
    var showHelp = false
    var dialog: WorkbenchDialog?
    var showingChanges = Set<String>()
    var visitedChanges = Set<String>()
    var pendingBranches: [String: String] = [:]
    var pendingWorkspaces: [PendingWorkspace] = []
    var pendingWorkspaceTimers: [String: Task<Void, Never>] = [:]
    var terminalTitles: [String: String] = [:]
    var uploadingTasks = Set<String>()
    var draggingTasks = Set<String>()
    var pendingClose: Coflux_V1_Task?
    var dismissedError: Int?
    private(set) var pendingTerminals: [String: PendingTerminal] = [:]
    private var selectedPendingTerminals = Set<String>()
    private var createTimeouts: [String: Task<Void, Never>] = [:]
    var creatingTerminal: Bool {
        guard let workspace else { return false }
        return pendingTerminals[workspace.id] != nil
    }
    var creatingDeviceTerminals = Set<String>()
    var deviceTerminalErrors: [String: String] = [:]
    private var loginGeneration = 0

    init(client: CofluxClient, preferences: UserDefaults) {
        self.client = client
        self.preferences = preferences
        if let data = preferences.data(forKey: "selection") {
            selection = try? JSONDecoder().decode(Selection.self, from: data)
        }
    }

    var workspace: Coflux_V1_Workspace? {
        switch selection {
        case .workspace(let id): return client.workspaces.first { $0.id == id }
        case .device(let id):
            return client.workspaces.filter { $0.daemonID == id && $0.projectID.isEmpty }
                .min { $0.createdAt < $1.createdAt }
        case nil: return nil
        }
    }
    var workspaceTasks: [Coflux_V1_Task] {
        guard let workspace else { return [] }
        return client.tasks.filter { $0.workspaceID == workspace.id }.sorted { $0.createdAt < $1.createdAt }
    }
    var selectedPendingTerminal: PendingTerminal? {
        guard let workspace, selectedPendingTerminals.contains(workspace.id) else { return nil }
        return pendingTerminals[workspace.id]
    }
    var activeTask: Coflux_V1_Task? {
        guard let workspace, selectedPendingTerminal == nil else { return nil }
        let id = WorkbenchState.taskID(activeTasks[workspace.id], tasks: workspaceTasks)
        return workspaceTasks.first { $0.id == id }
    }

    func select(_ next: Selection) {
        selection = next
        if pendingWorkspace == nil { preferences.set(try? JSONEncoder().encode(next), forKey: "selection") }
        activateCurrent()
    }

    func reconcile() {
        guard client.snapshotRevision > 0 else { return }
        reconcilePendingWorkspaces()
        let resolved = pendingWorkspace != nil ? selection : WorkbenchState.resolve(selection, projects: client.projects,
                                               workspaces: client.workspaces, daemons: client.daemons)
        if resolved != selection {
            selection = resolved
            preferences.set(try? JSONEncoder().encode(resolved), forKey: "selection")
        }
        let taskIDs = Set(client.tasks.map(\.id))
        let workspaceIDs = Set(client.workspaces.map(\.id))
        let sessionIDs = Set(client.tasks.filter(\.hasSessionID).map(\.sessionID))
        visitedTasks.formIntersection(taskIDs)
        visitedChanges.formIntersection(workspaceIDs)
        showingChanges.formIntersection(workspaceIDs)
        activeTasks = activeTasks.filter { workspaceIDs.contains($0.key) && taskIDs.contains($0.value) }
        terminalTitles = terminalTitles.filter { sessionIDs.contains($0.key) }
        uploadingTasks.formIntersection(taskIDs)
        draggingTasks.formIntersection(taskIDs)
        collapsedProjects.formIntersection(Set(client.projects.map(\.id)))
        deviceTerminalErrors = deviceTerminalErrors.filter { id, _ in client.daemons.contains { $0.daemonID == id } }
        activationRequests = activationRequests.filter { visitedTasks.contains($0.key) }
        for (id, branch) in pendingBranches {
            if !client.workspaces.contains(where: { $0.id == id }) || client.workspaces.contains(where: { $0.id == id && $0.branch == branch }) {
                pendingBranches[id] = nil
            }
        }
        for (workspaceID, pending) in pendingTerminals {
            guard workspaceIDs.contains(workspaceID) else {
                finishCreate(workspaceID: workspaceID)
                continue
            }
            if let task = client.tasks.first(where: { $0.workspaceID == workspaceID && !pending.knownIDs.contains($0.id) }) {
                let shouldSelect = selectedPendingTerminals.contains(workspaceID)
                finishCreate(workspaceID: workspaceID)
                if shouldSelect { activeTasks[workspaceID] = task.id }
                // 用户切走后不抢回焦点；待回到该工作区时再启动新任务。
            }
        }
        activateCurrent()
    }

    func openChanges(_ workspaceID: String) {
        visitedChanges.insert(workspaceID)
        showingChanges.insert(workspaceID)
    }

    func selectPendingTerminal(workspaceID: String) {
        guard pendingTerminals[workspaceID] != nil else { return }
        selectedPendingTerminals.insert(workspaceID)
        showingChanges.remove(workspaceID)
    }

    func activate(_ task: Coflux_V1_Task) {
        // Set 的原地修改即使没有改变成员也会通知 Observation；只在实际变化时写入。
        if selectedPendingTerminals.contains(task.workspaceID) { selectedPendingTerminals.remove(task.workspaceID) }
        activationRequests[task.id, default: 0] += 1
        if showingChanges.contains(task.workspaceID) { showingChanges.remove(task.workspaceID) }
        if activeTasks[task.workspaceID] != task.id { activeTasks[task.workspaceID] = task.id }
        if !visitedTasks.contains(task.id) { visitedTasks.insert(task.id) }
    }
    func activateCurrent() {
        if let task = activeTask {
            if activeTasks[task.workspaceID] != task.id { activeTasks[task.workspaceID] = task.id }
            if !visitedTasks.contains(task.id) { visitedTasks.insert(task.id) }
        }
    }
    func selectTab(_ index: Int) {
        guard workspaceTasks.indices.contains(index) else { return }
        activate(workspaceTasks[index])
    }
    func selectRelative(_ delta: Int) {
        let tasks = workspaceTasks
        guard !tasks.isEmpty else { return }
        let index = tasks.firstIndex { $0.id == activeTask?.id } ?? 0
        selectTab((index + delta + tasks.count) % tasks.count)
    }
    func createTerminal() {
        guard let workspace, !creatingTerminal else { return }
        let title = "终端 \(workspaceTasks.count + 1)"
        pendingTerminals[workspace.id] = PendingTerminal(title: title, knownIDs: Set(workspaceTasks.map(\.id)))
        selectPendingTerminal(workspaceID: workspace.id)
        client.createTask(workspaceID: workspace.id, title: title)
        createTimeouts[workspace.id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self else { return }
            // 与 Web 一样撤销该工作区的等待态，允许重试；不能发全局错误，
            // 否则 RootView 的错误清理会连带取消其他工作区仍有效的创建。
            self.finishCreate(workspaceID: workspace.id)
        }
    }
    func finishCreate(workspaceID: String) {
        createTimeouts.removeValue(forKey: workspaceID)?.cancel()
        pendingTerminals[workspaceID] = nil
        if selectedPendingTerminals.remove(workspaceID) != nil {
            // 占位条目失败/超时后回落到第一个真实任务；手动选择过其他 Tab 则保持。
            activeTasks[workspaceID] = nil
        }
    }
    func finishCreate() {
        for workspaceID in Array(pendingTerminals.keys) { finishCreate(workspaceID: workspaceID) }
    }
    func requestClose(_ task: Coflux_V1_Task) {
        if task.status == .running { pendingClose = task }
        else { Task { await client.closeTask(task) } }
    }
    func confirmClose() {
        guard let task = pendingClose else { return }
        pendingClose = nil
        Task { await client.closeTask(task) }
    }
    func logout() {
        loginGeneration += 1
        finishCreate()
        for pending in pendingWorkspaces { removePendingWorkspace(pending.id) }
        visitedChanges.removeAll()
        showingChanges.removeAll()
        activationRequests.removeAll()
        visitedTasks.removeAll()
        activeTasks.removeAll()
        terminalTitles.removeAll()
        uploadingTasks.removeAll()
        draggingTasks.removeAll()
        pendingBranches.removeAll()
        collapsedProjects.removeAll()
        creatingDeviceTerminals.removeAll()
        deviceTerminalErrors.removeAll()
        pendingClose = nil
        dismissedError = nil
        dialog = nil
        showHelp = false
        selection = nil
        preferences.removeObject(forKey: "selection")
        client.logout()
    }
}

enum WorkbenchEntity: String { case project, workspace, device }
enum WorkbenchDialog: Identifiable {
    case importProject
    case createWorkspace(Coflux_V1_Project)
    case switchBranch(Coflux_V1_Workspace)
    case rename(WorkbenchEntity, String, String)
    case remove(WorkbenchEntity, String, String)
    case enrollment
    var isBranchMenu: Bool {
        switch self {
        case .createWorkspace, .switchBranch: true
        default: false
        }
    }
    var id: String {
        switch self {
        case .importProject: "import"
        case .createWorkspace(let project): "create-" + project.id
        case .switchBranch(let workspace): "branch-" + workspace.id
        case .rename(let kind, let id, _): "rename-" + kind.rawValue + id
        case .remove(let kind, let id, _): "remove-" + kind.rawValue + id
        case .enrollment: "enrollment"
        }
    }
}

extension WorkbenchModel {
    @discardableResult
    func switchBranch(workspaceID: String, branch: String, createNew: Bool) -> Task<Void, Never>? {
        guard pendingBranches[workspaceID] == nil else { return nil }
        let generation = loginGeneration
        pendingBranches[workspaceID] = branch
        dialog = nil
        return Task {
            guard loginGeneration == generation else { return }
            do {
                let result = try await client.executeInWorkspace(workspaceID: workspaceID, command: "git", args: createNew ? ["checkout", "-b", branch] : ["checkout", branch])
                guard loginGeneration == generation else { return }
                guard result.ok, result.exitCode == 0 else {
                    pendingBranches[workspaceID] = nil
                    client.reportLocalError("切换分支失败：\(result.hasError ? result.error : result.stderr)")
                    return
                }
                // 分支标签由 daemon 真相广播收敛；20 秒只解除忙态，不伪造快照。
                try await Task.sleep(for: .seconds(20))
                if loginGeneration == generation, pendingBranches[workspaceID] == branch { pendingBranches[workspaceID] = nil }
            } catch {
                guard loginGeneration == generation else { return }
                pendingBranches[workspaceID] = nil
                client.reportLocalError(String(describing: error))
            }
        }
    }

    func rename(_ entity: WorkbenchEntity, id: String, name: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard entity == .workspace || !name.isEmpty else { return }
        let payload: Coflux_V1_ClientToServer.OneOf_Payload
        switch entity {
        case .project:
            var value = Coflux_V1_ProjectSetName(); value.projectID = id; value.name = name
            payload = .projectSetName(value)
        case .workspace:
            var value = Coflux_V1_WorkspaceSetName(); value.workspaceID = id; value.name = name
            payload = .workspaceSetName(value)
        case .device:
            var value = Coflux_V1_DeviceSetName(); value.daemonID = id; value.name = name
            payload = .deviceSetName(value)
        }
        if client.sendWorkbenchCommand(payload) { dialog = nil }
    }

    func remove(_ entity: WorkbenchEntity, id: String) {
        let payload: Coflux_V1_ClientToServer.OneOf_Payload
        switch entity {
        case .project:
            var value = Coflux_V1_ProjectRemove(); value.projectID = id; payload = .projectRemove(value)
        case .workspace:
            var value = Coflux_V1_WorkspaceRemove(); value.workspaceID = id; payload = .workspaceRemove(value)
        case .device:
            var value = Coflux_V1_ClientRemoveDevice(); value.daemonID = id; payload = .clientRemoveDevice(value)
        }
        if client.sendWorkbenchCommand(payload) { dialog = nil }
    }

    func createDeviceTerminal(_ id: String) async {
        guard !creatingDeviceTerminals.contains(id), client.daemons.contains(where: { $0.daemonID == id && $0.online }) else { return }
        creatingDeviceTerminals.insert(id)
        deviceTerminalErrors[id] = nil
        let account = client.accountID
        let generation = loginGeneration
        defer { if loginGeneration == generation { creatingDeviceTerminals.remove(id) } }
        do {
            let result = try await client.listDeviceDirectory(daemonID: id, path: "~")
            try Task.checkCancellation()
            guard loginGeneration == generation, client.authState == .authed, client.accountID == account else { return }
            guard result.ok, !result.path.isEmpty else {
                deviceTerminalErrors[id] = result.error.isEmpty ? "无法解析设备 HOME 目录" : result.error
                return
            }
            var value = Coflux_V1_TerminalCreate(); value.daemonID = id; value.path = result.path
            let errorBefore = client.lastError?.id
            guard client.sendWorkbenchCommand(.terminalCreate(value)) else {
                deviceTerminalErrors[id] = "连接不可用，请稍后重试"; return
            }
            let deadline = ContinuousClock.now + .seconds(15)
            while !client.workspaces.contains(where: { $0.daemonID == id && $0.projectID.isEmpty }) {
                guard loginGeneration == generation, client.authState == .authed, client.accountID == account else { return }
                if let error = client.lastError, error.id != errorBefore {
                    deviceTerminalErrors[id] = error.message; return
                }
                guard ContinuousClock.now < deadline else {
                    deviceTerminalErrors[id] = "新建终端超时，请检查设备状态后重试"; return
                }
                try await Task.sleep(for: .milliseconds(100))
            }
        } catch {
            if !Task.isCancelled, loginGeneration == generation { deviceTerminalErrors[id] = error.localizedDescription }
        }
    }
}

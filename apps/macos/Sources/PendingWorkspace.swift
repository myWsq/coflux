import CofluxProtocol
import Foundation

struct PendingWorkspace: Identifiable {
    let id: String
    let projectID: String
    let daemonID: String
    let branch: String
    let knownIDs: Set<String>

    func match(in workspaces: [Coflux_V1_Workspace]) -> Coflux_V1_Workspace? {
        workspaces.first { $0.projectID == projectID && $0.daemonID == daemonID && $0.branch == branch && !knownIDs.contains($0.id) }
    }
}

extension WorkbenchModel {
    var pendingWorkspace: PendingWorkspace? {
        guard case .workspace(let id) = selection else { return nil }
        return pendingWorkspaces.first { $0.id == id }
    }

    @discardableResult
    func createWorkspace(project: Coflux_V1_Project, branch: String, createNew: Bool) -> Bool {
        if let existing = pendingWorkspaces.first(where: { $0.projectID == project.id && $0.branch == branch }) {
            select(.workspace(existing.id)); return true
        }
        let pending = PendingWorkspace(id: "pending-workspace-" + UUID().uuidString,
                                       projectID: project.id, daemonID: project.daemonID, branch: branch,
                                       knownIDs: Set(client.workspaces.map(\.id)))
        var value = Coflux_V1_WorkspaceCreate()
        value.projectID = project.id; value.name = branch; value.branch = branch; value.createNew = createNew
        guard client.sendWorkbenchCommand(.workspaceCreate(value)) else { return false }
        pendingWorkspaces.append(pending)
        collapsedProjects.remove(project.id)
        select(.workspace(pending.id))
        pendingWorkspaceTimers[pending.id] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            guard let self else { return }
            self.removePendingWorkspace(pending.id)
            self.reconcile()
            self.client.reportLocalError("新建工作区超时，请检查设备状态后重试")
        }
        return true
    }

    func removePendingWorkspace(_ id: String) {
        pendingWorkspaceTimers.removeValue(forKey: id)?.cancel()
        pendingWorkspaces.removeAll { $0.id == id }
    }

    func finishWorkspaceCreates() {
        for pending in pendingWorkspaces { removePendingWorkspace(pending.id) }
        reconcile()
    }

    func reconcilePendingWorkspaces() {
        for pending in pendingWorkspaces {
            if let workspace = pending.match(in: client.workspaces) {
                let selected = selection == .workspace(pending.id)
                removePendingWorkspace(pending.id)
                if selected { select(.workspace(workspace.id)) }
            } else if !client.projects.contains(where: { $0.id == pending.projectID }) {
                removePendingWorkspace(pending.id)
            }
        }
    }
}

import CofluxClientCore
import CofluxProtocol

/// 对齐当前 Web 的工作区聚合：状态由 hook 决定，进度独立于状态。
struct WorkspaceActivity {
    var state: String?
    var agent = ""
    var message = ""
    var progress = ""

    init(workspaceID: String, online: Bool, tasks: [Coflux_V1_Task], agents: [String: CofluxClient.SessionAgentInfo]) {
        let entries = tasks.filter { $0.workspaceID == workspaceID && $0.status == .running && $0.hasSessionID }
            .compactMap { agents[$0.sessionID]?.session }
        progress = entries.first { !$0.progress.isEmpty }?.progress ?? ""
        guard online else { return }
        for candidate in ["approval", "question", "active", "done"] {
            if let entry = entries.first(where: { $0.state == candidate || (candidate == "done" && $0.state == "waiting") }) {
                state = candidate
                agent = entry.agent
                if candidate == "question" { message = entry.message }
                return
            }
        }
    }

    var label: String {
        let prefix = agent.isEmpty ? "" : agent + " "
        switch state {
        case "approval": return prefix + "等待批准"
        case "question": return prefix + "等待回答"
        case "active": return prefix + "正在执行"
        case "done": return prefix + "本轮完成"
        default: return ""
        }
    }

    func details(workspace: Coflux_V1_Workspace, project: Coflux_V1_Project?, daemon: Coflux_V1_DaemonInfo?) -> String {
        let name = workspace.name.isEmpty || workspace.name == workspace.branch ? "" : " · " + workspace.name
        var lines = [workspace.branch + name, label, message, progress, workspace.path]
        lines.append(daemon.map { "\($0.name)（\($0.online ? "在线" : "离线")）" } ?? "设备记录缺失")
        if workspace.additions > 0 || workspace.deletions > 0 {
            let branch = project?.defaultBranch ?? ""
            let basis = branch.isEmpty || branch == workspace.branch ? "未提交改动" : "相对 \(branch) 的变更"
            lines.append("\(basis) +\(workspace.additions) −\(workspace.deletions)")
        }
        return lines.filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

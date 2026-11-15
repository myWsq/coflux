import CofluxClientCore
import CofluxProtocol
import Foundation

/// One row of the home's 「当前」 section (plan 20261115-ios-current-section): a live agent
/// terminal, or a terminal an agent's secret request waits in.
struct CurrentTerminalRow: Identifiable, Equatable {
    enum State: Equatable {
        /// A pending secret request; it outranks whatever the agent reports.
        case secret
        case approval
        case question
        case error
        case active
        case done
    }

    let task: Coflux_V1_Task
    let workspace: Coflux_V1_Workspace
    /// Nil for a directory workspace (no repo).
    let project: Coflux_V1_Project?
    let daemon: Coflux_V1_DaemonInfo
    /// The agent as its presence entry names it (`claude`, `codex`, …); empty when the terminal
    /// is a member only for its secret request.
    let agent: String
    /// The program's title, else the task's own, else 「终端」.
    let title: String
    let state: State
    /// The presence entry's raw state, for Clawd's pose; empty without an entry.
    let agentState: String
    /// What the agent said it needs; empty when it left nothing.
    let message: String
    let progress: String
    /// The centre's account-wide seen mark on a finished turn.
    let seen: Bool
    /// The oldest pending secret request of the terminal.
    let secret: SecretRequestInfo?

    var id: String { task.id }

    /// The row waits for the user (待处理): it counts in the badges.
    var needsAttention: Bool {
        switch state {
        case .secret, .approval, .question, .error: true
        case .active, .done: false
        }
    }

    /// 「项目 · 分支」, or the device for a directory workspace.
    var location: String {
        guard let project else { return daemon.name.isEmpty ? daemon.host : daemon.name }
        let branch = workspace.branch.isEmpty ? workspace.name : workspace.branch
        return branch.isEmpty ? project.name : "\(project.name) · \(branch)"
    }
}

/// The 「当前」 section, derived — never curated. It mirrors the desktop's `current-terminals.ts`
/// and `workspace-order.ts` rule for rule: a terminal is a member while its device is online, its
/// task runs and its agent reports a known state. Rows come in tree order (project workspaces as
/// the tree lists them, then directory workspaces by device) and, within a workspace, by when the
/// terminal was created — never by state or time, so rows do not swap places as agents change
/// state. One addition: a running terminal with a pending secret request is a member even without
/// an agent state, or the request would not show on the home at all.
enum CurrentTerminals {
    /// A project's workspaces in tree order: the main workspace first, then by creation.
    static func ordered(_ workspaces: [Coflux_V1_Workspace], projectID: String) -> [Coflux_V1_Workspace] {
        workspaces
            .filter { $0.projectID == projectID }
            .sorted { lhs, rhs in
                if lhs.isMain != rhs.isMain { return lhs.isMain }
                return lhs.createdAt < rhs.createdAt
            }
    }

    static func derive(
        projects: [Coflux_V1_Project],
        workspaces: [Coflux_V1_Workspace],
        daemons: [Coflux_V1_DaemonInfo],
        tasks: [Coflux_V1_Task],
        sessionAgents: [String: CofluxClient.SessionAgentInfo],
        secretRequests: [String: SecretRequestInfo],
        title: (Coflux_V1_Task) -> String?
    ) -> [CurrentTerminalRow] {
        // Workspaces in list order, each with its project (nil for a directory workspace). An
        // archived project's workspaces are listed only under it, so they are left out with it.
        var listed: [(workspace: Coflux_V1_Workspace, project: Coflux_V1_Project?)] = []
        for project in projects where !project.hasArchivedAt {
            for workspace in ordered(workspaces, projectID: project.id) {
                listed.append((workspace, project))
            }
        }
        for daemon in daemons {
            let directories = workspaces
                .filter { isDirWorkspace($0) && $0.daemonID == daemon.daemonID }
                .sorted { byCreation($0.createdAt, $0.id, $1.createdAt, $1.id) }
            for workspace in directories {
                listed.append((workspace, nil))
            }
        }

        // The oldest pending request per terminal.
        var secrets: [String: SecretRequestInfo] = [:]
        for request in secretRequests.values {
            if let known = secrets[request.taskID],
               byCreation(known.createdAt, known.requestID, request.createdAt, request.requestID) { continue }
            secrets[request.taskID] = request
        }

        var rows: [CurrentTerminalRow] = []
        for (workspace, project) in listed {
            guard let daemon = daemons.first(where: { $0.daemonID == workspace.daemonID }), daemon.online else { continue }
            let running = tasks
                .filter { $0.workspaceID == workspace.id && $0.status == .running && $0.hasSessionID }
                .sorted { byCreation($0.createdAt, $0.id, $1.createdAt, $1.id) }
            for task in running {
                let ref = sessionAgents[task.sessionID]?.session
                let secret = secrets[task.id]
                let state: CurrentTerminalRow.State
                if secret != nil {
                    state = .secret
                } else {
                    switch ref?.state {
                    case "approval": state = .approval
                    case "question": state = .question
                    case "error": state = .error
                    case "active": state = .active
                    // An old worker's `waiting` is shown as done.
                    case "done", "waiting": state = .done
                    default: continue
                    }
                }
                let ownTitle = title(task) ?? task.title
                rows.append(CurrentTerminalRow(
                    task: task,
                    workspace: workspace,
                    project: project,
                    daemon: daemon,
                    agent: ref?.agent ?? "",
                    title: ownTitle.isEmpty ? "终端" : ownTitle,
                    state: state,
                    agentState: ref?.state ?? "",
                    message: ref?.message ?? "",
                    progress: ref?.progress ?? "",
                    seen: ref?.seen ?? false,
                    secret: secret
                ))
            }
        }
        return rows
    }

    private static func byCreation(_ lhsTime: Double, _ lhsID: String, _ rhsTime: Double, _ rhsID: String) -> Bool {
        lhsTime != rhsTime ? lhsTime < rhsTime : lhsID < rhsID
    }
}

extension CofluxClient {
    /// The home's 「当前」 rows. Empty before the first snapshot: data that has not arrived is not
    /// "nothing current".
    var currentTerminals: [CurrentTerminalRow] {
        guard snapshotRevision > 0 else { return [] }
        return CurrentTerminals.derive(
            projects: projects,
            workspaces: workspaces,
            daemons: daemons,
            tasks: tasks,
            sessionAgents: sessionAgents,
            secretRequests: secretRequests,
            title: { self.terminalTitle(forTask: $0) }
        )
    }

    /// The terminals that wait for the user, for the 首页 tab badge and the sidebar button.
    var waitingCount: Int {
        currentTerminals.count(where: \.needsAttention)
    }

    /// The agent detected in a terminal, if any.
    func agent(forTask task: Coflux_V1_Task) -> Coflux_V1_SessionAgentRef? {
        guard task.hasSessionID else { return nil }
        return sessionAgents[task.sessionID]?.session
    }

    /// What the terminal is doing, as the desktop tab says it: the title the program running in
    /// it set (OSC 0/2 — Claude Code writes a summary of its task there). It reaches this client
    /// with the session's checkpoints. The leading status mark (Claude's ✳ or spinner) is dropped:
    /// Clawd shows the state. Nil when no title is known.
    func terminalTitle(forTask task: Coflux_V1_Task) -> String? {
        guard task.hasSessionID,
              let checkpoint = sessionCheckpoints[task.sessionID],
              checkpoint.taskID == task.id
        else { return nil }
        let title = checkpoint.title
            .drop { !$0.isLetter && !$0.isNumber }
            .trimmingCharacters(in: .whitespaces)
        return title.isEmpty ? nil : title
    }

    /// A device's display name: its name, else its host.
    func deviceName(_ daemonID: String) -> String {
        guard let daemon = daemons.first(where: { $0.daemonID == daemonID }) else { return "" }
        return daemon.name.isEmpty ? daemon.host : daemon.name
    }
}

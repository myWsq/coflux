import CofluxClientCore
import CofluxProtocol
import Foundation

/// Something that waits for the user (plan D5): an agent that asks a question or wants a
/// permission, or a pending secret request. Derived only from what the client already has —
/// the agent's hook-reported turn state and the secret request set — never from terminal text.
struct WaitingItem: Identifiable, Equatable {
    enum Kind: Equatable {
        /// `state` is "approval" or "question"; `message` is the agent's note, possibly empty.
        case agent(name: String, state: AgentWaitState, message: String)
        case secret(SecretRequestInfo)
    }

    enum AgentWaitState: Equatable {
        case approval
        case question
    }

    let kind: Kind
    let taskID: String
    let workspaceID: String
    let projectID: String
    let daemonID: String
    /// ms epoch on one clock for both kinds: the task's `updatedAt` / the request's `createdAt`.
    let time: Double

    var id: String {
        switch kind {
        case .agent: "agent:\(taskID)"
        case .secret(let request): "secret:\(request.requestID)"
        }
    }

    /// Secondary sort key: agent items have no request id.
    fileprivate var requestID: String {
        if case .secret(let request) = kind { return request.requestID }
        return ""
    }
}

enum WaitingItems {
    /// The ordered waiting items, newest first; ties break by task id, then request id.
    /// An agent item needs its task (to order it and to open it); a session whose task is not in
    /// the snapshot yet is left out until it is.
    static func derive(
        sessionAgents: [String: CofluxClient.SessionAgentInfo],
        tasks: [Coflux_V1_Task],
        secretRequests: [String: SecretRequestInfo]
    ) -> [WaitingItem] {
        let tasksByID = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var items: [WaitingItem] = []
        for info in sessionAgents.values {
            let session = info.session
            let state: WaitingItem.AgentWaitState
            switch session.state {
            case "approval": state = .approval
            case "question": state = .question
            default: continue
            }
            let task = tasksByID[session.taskID]
                ?? tasks.first { $0.hasSessionID && $0.sessionID == session.sessionID }
            guard let task else { continue }
            items.append(WaitingItem(
                kind: .agent(name: session.agent, state: state, message: session.message),
                taskID: task.id,
                workspaceID: task.workspaceID,
                projectID: task.projectID,
                daemonID: info.daemonID,
                time: task.updatedAt
            ))
        }
        for request in secretRequests.values {
            let task = tasksByID[request.taskID]
            items.append(WaitingItem(
                kind: .secret(request),
                taskID: request.taskID,
                workspaceID: task?.workspaceID ?? "",
                projectID: task?.projectID ?? "",
                daemonID: request.daemonID,
                time: request.createdAt
            ))
        }
        return items.sorted { lhs, rhs in
            if lhs.time != rhs.time { return lhs.time > rhs.time }
            if lhs.taskID != rhs.taskID { return lhs.taskID < rhs.taskID }
            return lhs.requestID < rhs.requestID
        }
    }
}

extension CofluxClient {
    /// Everything that waits for the user right now, newest first.
    var waitingItems: [WaitingItem] {
        WaitingItems.derive(sessionAgents: sessionAgents, tasks: tasks, secretRequests: secretRequests)
    }

    /// The waiting count for the 首页 tab badge.
    var waitingCount: Int {
        waitingItems.count
    }

    /// The agent detected in a terminal, if any.
    func agent(forTask task: Coflux_V1_Task) -> Coflux_V1_SessionAgentRef? {
        guard task.hasSessionID else { return nil }
        return sessionAgents[task.sessionID]?.session
    }

    /// A device's display name: its name, else its host.
    func deviceName(_ daemonID: String) -> String {
        guard let daemon = daemons.first(where: { $0.daemonID == daemonID }) else { return "" }
        return daemon.name.isEmpty ? daemon.host : daemon.name
    }
}

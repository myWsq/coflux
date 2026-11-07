import CofluxClientCore
import CofluxProtocol
import Foundation
import Testing

@testable import Coflux

/// The home's "需要你" source (plan D5): agent sessions waiting on approval or a question, plus
/// pending secret requests, newest first on one millisecond clock.
@MainActor
struct WaitingItemsTests {
    private func task(_ id: String, session: String, updatedAt: Double) -> Coflux_V1_Task {
        var task = Coflux_V1_Task()
        task.id = id
        task.workspaceID = "ws-\(id)"
        task.projectID = "p-\(id)"
        task.daemonID = "d1"
        task.status = .running
        task.sessionID = session
        task.updatedAt = updatedAt
        return task
    }

    private func agent(session: String, task: String, state: String, message: String = "") -> CofluxClient.SessionAgentInfo {
        var ref = Coflux_V1_SessionAgentRef()
        ref.sessionID = session
        ref.taskID = task
        ref.agent = "claude"
        ref.state = state
        ref.message = message
        return CofluxClient.SessionAgentInfo(daemonID: "d1", session: ref)
    }

    private func secret(_ id: String, task: String, createdAt: Double) -> SecretRequestInfo {
        var ref = Coflux_V1_SecretRequestRef()
        ref.requestID = id
        ref.sessionID = "s-\(task)"
        ref.taskID = task
        ref.name = "OPENAI_API_KEY"
        ref.createdAt = createdAt
        ref.expiresAt = createdAt + 300_000
        return SecretRequestInfo(daemonID: "d1", request: ref)
    }

    @Test func questionAndSecretAreOrderedNewestFirst() {
        let items = WaitingItems.derive(
            sessionAgents: ["s1": agent(session: "s1", task: "t1", state: "question", message: "首页按哪个方案做？")],
            tasks: [task("t1", session: "s1", updatedAt: 2000), task("t2", session: "s2", updatedAt: 1000)],
            secretRequests: ["r1": secret("r1", task: "t2", createdAt: 3000)]
        )
        #expect(items.count == 2)
        #expect(items.first?.id == "secret:r1")
        #expect(items.last?.kind == .agent(name: "claude", state: .question, message: "首页按哪个方案做？"))
        #expect(items.last?.workspaceID == "ws-t1")
    }

    @Test func onlyApprovalAndQuestionWait() {
        for state in ["active", "done", ""] {
            let items = WaitingItems.derive(
                sessionAgents: ["s1": agent(session: "s1", task: "t1", state: state)],
                tasks: [task("t1", session: "s1", updatedAt: 2000)],
                secretRequests: [:]
            )
            #expect(items.isEmpty, "state \(state) must not wait")
        }
        let approval = WaitingItems.derive(
            sessionAgents: ["s1": agent(session: "s1", task: "t1", state: "approval")],
            tasks: [task("t1", session: "s1", updatedAt: 2000)],
            secretRequests: [:]
        )
        #expect(approval.count == 1)
    }

    @Test func aSessionLeavingTheSetTakesItsItem() {
        let tasks = [task("t1", session: "s1", updatedAt: 2000)]
        let before = WaitingItems.derive(
            sessionAgents: ["s1": agent(session: "s1", task: "t1", state: "question")],
            tasks: tasks,
            secretRequests: [:]
        )
        let after = WaitingItems.derive(sessionAgents: [:], tasks: tasks, secretRequests: [:])
        #expect(before.count == 1)
        #expect(after.isEmpty)
    }

    @Test func tiesBreakByTaskThenRequest() {
        let items = WaitingItems.derive(
            sessionAgents: [:],
            tasks: [],
            secretRequests: [
                "r2": secret("r2", task: "t1", createdAt: 5000),
                "r1": secret("r1", task: "t1", createdAt: 5000),
                "r0": secret("r0", task: "t0", createdAt: 5000),
            ]
        )
        #expect(items.map(\.id) == ["secret:r0", "secret:r1", "secret:r2"])
    }
}

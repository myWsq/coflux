import CofluxClientCore
import CofluxProtocol
import XCTest
@testable import Coflux

final class WorkspaceActivityTests: XCTestCase {
    func testPriorityMessageProgressAndOfflineAreIndependent() {
        var tasks: [Coflux_V1_Task] = []
        var agents: [String: CofluxClient.SessionAgentInfo] = [:]
        for (index, state) in ["waiting", "active", "question", "approval"].enumerated() {
            let id = "s\(index)"
            var task = Coflux_V1_Task(); task.id = id; task.workspaceID = "w"; task.sessionID = id; task.status = .running
            tasks.append(task)
            var entry = Coflux_V1_SessionAgentRef(); entry.sessionID = id; entry.agent = "codex"; entry.state = state
            if state == "question" { entry.message = "请选择路径\n保留中文和换行" }
            if state == "active" { entry.progress = "正在验证构建" }
            agents[id] = .init(daemonID: "d", session: entry)
        }
        var activity = WorkspaceActivity(workspaceID: "w", online: true, tasks: tasks, agents: agents)
        XCTAssertEqual(activity.state, "approval")
        XCTAssertEqual(activity.progress, "正在验证构建")
        XCTAssertEqual(activity.message, "")
        tasks.removeLast()
        activity = WorkspaceActivity(workspaceID: "w", online: true, tasks: tasks, agents: agents)
        XCTAssertEqual(activity.label, "codex 等待回答")
        XCTAssertEqual(activity.message, "请选择路径\n保留中文和换行")
        let offline = WorkspaceActivity(workspaceID: "w", online: false, tasks: tasks, agents: agents)
        XCTAssertNil(offline.state)
        XCTAssertEqual(offline.progress, "正在验证构建")
        tasks = [tasks[0]]
        XCTAssertEqual(WorkspaceActivity(workspaceID: "w", online: true, tasks: tasks, agents: agents).state, "done")
        tasks[0].status = .exited
        XCTAssertNil(WorkspaceActivity(workspaceID: "w", online: true, tasks: tasks, agents: agents).state)
    }

    func testDetailsDescribeCorrectDiffBaseAndPreserveMessages() {
        var workspace = Coflux_V1_Workspace(); workspace.id = "w"; workspace.branch = "feature"; workspace.path = "/work/中文"
        workspace.additions = 3; workspace.deletions = 2
        var project = Coflux_V1_Project(); project.defaultBranch = "main"
        let activity = WorkspaceActivity(workspaceID: "w", online: true, tasks: [], agents: [:])
        let details = activity.details(workspace: workspace, project: project, daemon: nil)
        XCTAssertTrue(details.contains("相对 main 的变更 +3 −2"))
        XCTAssertTrue(details.contains("/work/中文\n设备记录缺失"))
        workspace.branch = "main"
        XCTAssertTrue(activity.details(workspace: workspace, project: project, daemon: nil).contains("未提交改动"))
    }
}

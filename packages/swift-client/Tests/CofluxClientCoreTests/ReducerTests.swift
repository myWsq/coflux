import CofluxProtocol
import Foundation
import Testing
@testable import CofluxClientCore

@MainActor
struct ReducerTests {
    private func makeClient(store: InMemoryTokenStore = InMemoryTokenStore()) -> CofluxClient {
        CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: FakeTransport(),
            tokenStore: store
        )
    }

    private func snapshot() -> Coflux_V1_StateSnapshot {
        var daemon = Coflux_V1_DaemonInfo()
        daemon.daemonID = "d1"
        daemon.name = "mac"
        daemon.online = true
        var project = Coflux_V1_Project()
        project.id = "p1"
        project.daemonID = "d1"
        project.name = "coflux"
        var workspace = Coflux_V1_Workspace()
        workspace.id = "w1"
        workspace.daemonID = "d1"
        workspace.projectID = "p1"
        workspace.branch = "main"
        var task = Coflux_V1_Task()
        task.id = "t1"
        task.daemonID = "d1"
        task.projectID = "p1"
        task.workspaceID = "w1"
        task.status = .running
        var value = Coflux_V1_StateSnapshot()
        value.daemons = [daemon]
        value.projects = [project]
        value.workspaces = [workspace]
        value.tasks = [task]
        return value
    }

    @Test func stateSnapshotReplacesEntitiesAndBumpsRevision() {
        let client = makeClient()
        #expect(client.syncState == .notSubscribed)
        client.apply(.stateSnapshot(snapshot()))
        #expect(client.daemons.map(\.daemonID) == ["d1"])
        #expect(client.projects.map(\.id) == ["p1"])
        #expect(client.workspaces.map(\.id) == ["w1"])
        #expect(client.tasks.map(\.id) == ["t1"])
        #expect(client.snapshotRevision == 1)
        #expect(client.syncState == .synced)
        client.apply(.stateSnapshot(Coflux_V1_StateSnapshot()))
        #expect(client.snapshotRevision == 2)
        #expect(client.daemons.isEmpty)
        #expect(client.projects.isEmpty)
        #expect(client.workspaces.isEmpty)
        #expect(client.tasks.isEmpty)
    }

    @Test func duplicateSnapshotKeysDoNotCrashAndLatestDerivedValueWins() {
        let client = makeClient()
        var initial = snapshot()
        initial.tasks.append(initial.tasks[0])
        var first = Coflux_V1_TaskPorts()
        first.taskID = "t1"
        var firstPort = Coflux_V1_PortPreview()
        firstPort.port = 3000
        first.ports = [firstPort]
        var latest = first
        latest.ports[0].port = 4000
        initial.ports = [first, latest]

        client.apply(.stateSnapshot(initial))

        #expect(client.ports["t1"]?.map(\.port) == [4000])
    }

    @Test func authOkWaitsForSnapshotInsteadOfRenderingEmptyAccount() {
        let client = makeClient()
        client.apply(.authOk(Coflux_V1_AuthOk()))
        #expect(client.authState == .authed)
        #expect(client.syncState == .awaitingSnapshot)
        #expect(client.snapshotRevision == 0)
    }

    @Test func portsAndAgentsFollowSnapshotIncrementAndTaskRemoval() {
        let client = makeClient()
        var initial = snapshot()
        var preview = Coflux_V1_PortPreview()
        preview.port = 8787
        preview.url = "https://preview.test"
        var taskPorts = Coflux_V1_TaskPorts()
        taskPorts.taskID = "t1"
        taskPorts.ports = [preview]
        initial.ports = [taskPorts]
        client.apply(.stateSnapshot(initial))
        #expect(client.ports["t1"]?.map(\.port) == [8787])

        var agent = Coflux_V1_SessionAgentRef()
        agent.sessionID = "s1"
        agent.taskID = "t1"
        agent.agent = "codex"
        var agents = Coflux_V1_SessionAgentsUpdated()
        agents.daemonID = "d1"
        agents.sessions = [agent]
        client.apply(.sessionAgentsUpdated(agents))
        #expect(client.sessionAgents["s1"]?.session.agent == "codex")

        var updatedPorts = Coflux_V1_PortsUpdated()
        updatedPorts.taskID = "t1"
        updatedPorts.ports = []
        client.apply(.portsUpdated(updatedPorts))
        #expect(client.ports["t1"]?.isEmpty == true)

        var task = client.tasks[0]
        task.sessionID = "s1"
        var taskUpdated = Coflux_V1_TaskUpdated()
        taskUpdated.task = task
        client.apply(.taskUpdated(taskUpdated))
        var removed = Coflux_V1_TaskRemoved()
        removed.taskID = "t1"
        client.apply(.taskRemoved(removed))
        #expect(client.ports["t1"] == nil)
        #expect(client.sessionAgents["s1"] == nil)
    }

    @Test func workspaceProgressReadsPresenceAndFollowsOverwrite() {
        let client = makeClient()
        var initial = snapshot()
        initial.tasks[0].sessionID = "s1"
        client.apply(.stateSnapshot(initial))
        #expect(client.workspaceProgress(workspaceID: "w1") == nil)

        var agent = Coflux_V1_SessionAgentRef()
        agent.sessionID = "s1"
        agent.taskID = "t1"
        agent.agent = "claude"
        agent.progress = "复现了，正在定位 relay 重连"
        var agents = Coflux_V1_SessionAgentsUpdated()
        agents.daemonID = "d1"
        agents.sessions = [agent]
        client.apply(.sessionAgentsUpdated(agents))
        #expect(client.workspaceProgress(workspaceID: "w1") == "复现了，正在定位 relay 重连")

        // 覆盖式：下一条替换上一条；空 progress = 没播报，回到无短评
        agent.progress = "修好了，在跑回归"
        agents.sessions = [agent]
        client.apply(.sessionAgentsUpdated(agents))
        #expect(client.workspaceProgress(workspaceID: "w1") == "修好了，在跑回归")

        agent.progress = ""
        agents.sessions = [agent]
        client.apply(.sessionAgentsUpdated(agents))
        #expect(client.workspaceProgress(workspaceID: "w1") == nil)
    }

    @Test func localSessionExitImmediatelyClearsAgentPresence() {
        let client = makeClient()
        var initial = snapshot()
        initial.tasks[0].sessionID = "s1"
        client.apply(.stateSnapshot(initial))

        var agent = Coflux_V1_SessionAgentRef()
        agent.sessionID = "s1"
        agent.taskID = "t1"
        agent.agent = "codex"
        var agents = Coflux_V1_SessionAgentsUpdated()
        agents.daemonID = "d1"
        agents.sessions = [agent]
        client.apply(.sessionAgentsUpdated(agents))
        #expect(client.sessionAgents["s1"] != nil)

        client.markSessionExited(taskID: "t1", sessionID: "s1", exitCode: 0)

        #expect(client.tasks[0].status == .exited)
        #expect(!client.tasks[0].hasSessionID)
        #expect(client.sessionAgents["s1"] == nil)
    }

    @Test func projectRemovalPreservesDirectoryWorkspace() {
        let client = makeClient()
        var initial = snapshot()
        var directory = Coflux_V1_Workspace()
        directory.id = "w-dir"
        directory.daemonID = "d1"
        directory.projectID = ""
        directory.path = "/tmp"
        initial.workspaces.append(directory)
        var task = Coflux_V1_Task()
        task.id = "t-dir"
        task.daemonID = "d1"
        task.projectID = ""
        task.workspaceID = "w-dir"
        initial.tasks.append(task)
        client.apply(.stateSnapshot(initial))

        var removed = Coflux_V1_ProjectRemoved()
        removed.projectID = "p1"
        client.apply(.projectRemoved(removed))

        #expect(client.workspaces.map(\.id) == ["w-dir"])
        #expect(client.tasks.map(\.id) == ["t-dir"])
    }

    @Test func projectAndWorkspaceCreatedMessagesAreUpserts() {
        let client = makeClient()
        client.apply(.stateSnapshot(snapshot()))

        var project = client.projects[0]
        project.name = "renamed"
        var projectCreated = Coflux_V1_ProjectCreated()
        projectCreated.project = project
        client.apply(.projectCreated(projectCreated))

        var workspace = client.workspaces[0]
        workspace.branch = "feature/native"
        var workspaceCreated = Coflux_V1_WorkspaceCreated()
        workspaceCreated.workspace = workspace
        client.apply(.workspaceCreated(workspaceCreated))

        #expect(client.projects.count == 1)
        #expect(client.projects[0].name == "renamed")
        #expect(client.workspaces.count == 1)
        #expect(client.workspaces[0].branch == "feature/native")
    }

    @Test func workspaceRemovalCascadesTaskDerivedState() {
        let client = makeClient()
        var initial = snapshot()
        initial.tasks[0].sessionID = "s1"
        var taskPorts = Coflux_V1_TaskPorts()
        taskPorts.taskID = "t1"
        initial.ports = [taskPorts]
        client.apply(.stateSnapshot(initial))

        var agent = Coflux_V1_SessionAgentRef()
        agent.sessionID = "s1"
        agent.taskID = "t1"
        var agents = Coflux_V1_SessionAgentsUpdated()
        agents.daemonID = "d1"
        agents.sessions = [agent]
        client.apply(.sessionAgentsUpdated(agents))

        var removed = Coflux_V1_WorkspaceRemoved()
        removed.workspaceID = "w1"
        client.apply(.workspaceRemoved(removed))

        #expect(client.workspaces.isEmpty)
        #expect(client.tasks.isEmpty)
        #expect(client.ports["t1"] == nil)
        #expect(client.sessionAgents["s1"] == nil)
    }

    @Test func daemonRemovedCascades() {
        let client = makeClient()
        client.apply(.stateSnapshot(snapshot()))
        var removed = Coflux_V1_DaemonRemoved()
        removed.daemonID = "d1"
        client.apply(.daemonRemoved(removed))
        #expect(client.daemons.isEmpty)
        #expect(client.projects.isEmpty)
        #expect(client.workspaces.isEmpty)
        #expect(client.tasks.isEmpty)
    }

    @Test func missingEmbeddedMessageIsDroppedNotCrashed() {
        let client = makeClient()
        client.apply(.stateSnapshot(snapshot()))
        // daemon 字段缺失的 DaemonUpdated = 畸形消息：丢弃该条，状态不变（store.ts:399 防御）
        client.apply(.daemonUpdated(Coflux_V1_DaemonUpdated()))
        #expect(client.daemons.map(\.daemonID) == ["d1"])
        client.apply(.taskUpdated(Coflux_V1_TaskUpdated()))
        #expect(client.tasks.map(\.id) == ["t1"])
    }

    @Test func taskUpdatedUpserts() {
        let client = makeClient()
        client.apply(.stateSnapshot(snapshot()))
        var task = Coflux_V1_Task()
        task.id = "t1"
        task.daemonID = "d1"
        task.projectID = "p1"
        task.workspaceID = "w1"
        task.status = .exited
        var updated = Coflux_V1_TaskUpdated()
        updated.task = task
        client.apply(.taskUpdated(updated))
        #expect(client.tasks.count == 1)
        #expect(client.tasks[0].status == .exited)
    }

    @Test func serverErrorSurfacesWithIncreasingID() {
        let client = makeClient()
        var error = Coflux_V1_ServerError()
        error.message = "boom"
        client.apply(.error(error))
        #expect(client.lastError == ClientError(id: 1, message: "boom"))
        client.apply(.error(error))
        #expect(client.lastError?.id == 2)
    }

    @Test func authErrorClearsTokenAndFails() {
        let store = InMemoryTokenStore(value: "stale")
        let client = makeClient(store: store)
        var error = Coflux_V1_AuthError()
        error.message = "认证失败"
        client.apply(.authError(error))
        #expect(store.value == nil)
        #expect(client.authState == .authFailed)
        #expect(!client.loginError.isEmpty)
    }

    @Test func clientOutdatedKeepsTokenAndStops() {
        let store = InMemoryTokenStore(value: "keep")
        let client = makeClient(store: store)
        client.apply(.clientOutdated(Coflux_V1_ClientOutdated()))
        #expect(store.value == "keep") // 版本失配不清 token（plan 044 决策）
        #expect(client.authState == .outdated)
    }

    @Test func reconnectCeilingStartsAtOneSecondAndCapsAt15() {
        #expect(CofluxClient.reconnectCeiling(attempt: 0) == 1)
        #expect(CofluxClient.reconnectCeiling(attempt: 2) == 4)
        #expect(CofluxClient.reconnectCeiling(attempt: 4) == 15)
        #expect(CofluxClient.reconnectCeiling(attempt: 40) == 15)
        for attempt in [0, 3, 9] {
            let ceiling = CofluxClient.reconnectCeiling(attempt: attempt)
            let delay = CofluxClient.reconnectDelay(attempt: attempt)
            #expect(delay >= ceiling / 2 && delay <= ceiling)
        }
    }
}

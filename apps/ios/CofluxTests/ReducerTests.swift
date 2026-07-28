import Foundation
import Testing
@testable import Coflux

@MainActor
struct ReducerTests {
    private func makeClient(store: InMemoryTokenStore = InMemoryTokenStore()) -> CofluxClient {
        CofluxClient(
            transport: FakeTransport(),
            tokenStore: store,
            serverURL: URL(string: "ws://fake.test/client")!
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
        client.apply(.stateSnapshot(snapshot()))
        #expect(client.daemons.map(\.daemonID) == ["d1"])
        #expect(client.projects.map(\.id) == ["p1"])
        #expect(client.workspaces.map(\.id) == ["w1"])
        #expect(client.tasks.map(\.id) == ["t1"])
        #expect(client.snapshotRevision == 1)
        client.apply(.stateSnapshot(snapshot()))
        #expect(client.snapshotRevision == 2)
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

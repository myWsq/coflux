import CofluxProtocol
import Foundation
import Testing
@testable import CofluxClientCore

/// Agent secret requests on the Swift client (plan 20260926-ios-secret-input): the pending set
/// mirrors packages/client/src/store.ts, and an answer resolves on the worker's matching ack.
@MainActor
struct SecretRequestTests {
    @Test func answerTravelsOnSessionLaneAndResolvesOnMatchingAck() async throws {
        let h = DeviceHarness()
        defer { h.router.reset() }
        h.router.setControlOnline(true)
        // No attach: a pending session-lane request is lane demand on its own.
        let answer = Task { try await h.router.answerSecret(daemonID: "d1", requestID: "req-1", kind: .decline, value: "ignored") }
        defer { answer.cancel() }
        let connection = try await h.openNextLocal()
        let channelID = try #require(h.lastLocalChannelID)
        func sentAnswers() -> [Coflux_V1_DeviceSecretAnswer] {
            h.deviceFrames(connection).compactMap {
                if case .secretAnswer(let value) = $0.payload { return value }; return nil
            }
        }
        #expect(await waitUntil { sentAnswers().count == 1 })
        let sent = try #require(sentAnswers().first)
        #expect(sent.requestID == "req-1")
        #expect(sent.kind == .decline)
        #expect(sent.value.isEmpty, "only PROVIDE carries a value")
        var ack = Coflux_V1_DeviceSecretAnswerAck()
        ack.requestID = "req-1"
        ack.status = .alreadyAnswered
        h.push(connection, channelID: channelID, .secretAnswerAck(ack))
        #expect(try await answer.value == .alreadyAnswered)
    }

    @Test func pendingSetReplacesPerDeviceAndClearsLikeTheTypeScriptStore() {
        let client = makeClient()
        var state = snapshot()
        state.tasks[0].sessionID = "s1"
        client.apply(.stateSnapshot(state))

        client.apply(.secretRequestsUpdated(update("d1", [request("r2", createdAt: 20), request("r1", createdAt: 10)])))
        client.apply(.secretRequestsUpdated(update("d2", [request("other", taskID: "t9", sessionID: "s9", createdAt: 5)])))
        #expect(client.pendingSecretRequests(taskID: "t1").map(\.requestID) == ["r1", "r2"])
        #expect(client.pendingSecretRequest(workspaceID: "w1")?.name == "API_KEY_r1")

        // Full replacement for one device leaves the other device's requests alone.
        client.apply(.secretRequestsUpdated(update("d1", [])))
        #expect(client.pendingSecretRequests(taskID: "t1").isEmpty)
        #expect(client.secretRequests["other"] != nil)

        var removed = Coflux_V1_DaemonRemoved()
        removed.daemonID = "d2"
        client.apply(.daemonRemoved(removed))
        #expect(client.secretRequests.isEmpty)

        client.apply(.secretRequestsUpdated(update("d1", [request("r1", createdAt: 10)])))
        client.markSessionExited(taskID: "t1", sessionID: "s1", exitCode: 0)
        #expect(client.secretRequests.isEmpty, "a terminal's requests end with its session")

        client.apply(.secretRequestsUpdated(update("d1", [request("r3", sessionID: "s2", createdAt: 30)])))
        client.apply(.stateSnapshot(state))
        #expect(client.secretRequests.isEmpty, "re-sent per device right after the snapshot")

        client.apply(.secretRequestsUpdated(update("d1", [request("r4", sessionID: "s2", createdAt: 40)])))
        client.logout()
        #expect(client.secretRequests.isEmpty)
    }

    @Test func answeringARequestNoLongerPendingShortCircuits() async {
        let client = makeClient()
        defer { client.logout() }
        #expect(await client.answerSecretRequest(requestID: "gone", answer: .cancel) == .alreadyAnswered)
    }

    @Test func phaseAfterAnswerMirrorsDesktop() {
        #expect(SecretCardPhase.after(.provide, result: .accepted) == .closed(.provided))
        #expect(SecretCardPhase.after(.decline, result: .accepted) == .closed(.declined))
        #expect(SecretCardPhase.after(.cancel, result: .accepted) == .closed(.cancelled))
        #expect(SecretCardPhase.after(.provide, result: .alreadyAnswered) == .closed(.answeredElsewhere))
        #expect(SecretCardPhase.after(.provide, result: .expired) == .closed(.expired))
        #expect(SecretCardPhase.after(.provide, result: .unknownRequest) == .closed(.expired))
        guard case .failed = SecretCardPhase.after(.provide, result: .invalid) else {
            Issue.record("INVALID keeps the card open for a retry")
            return
        }
        #expect(SecretCardPhase.after(.provide, result: .failed("超时")) == .failed("没能送达设备：超时"))
        #expect(SecretAnswerResult(status: .unspecified) == .invalid)
    }

    @Test func answerNeverRendersItsValue() {
        let answer = SecretAnswer.provide("not-a-real-value")
        #expect(!String(describing: answer).contains("not-a-real-value"))
        #expect(!String(reflecting: answer).contains("not-a-real-value"))
        var dumped = ""
        dump(answer, to: &dumped)
        #expect(!dumped.contains("not-a-real-value"))
    }

    private func makeClient() -> CofluxClient {
        CofluxClient(
            configuration: ClientConfiguration(serverURL: URL(string: "ws://fake.test/client")!, buildID: "dev"),
            transport: FakeTransport(),
            tokenStore: InMemoryTokenStore()
        )
    }

    private func snapshot() -> Coflux_V1_StateSnapshot {
        var daemon = Coflux_V1_DaemonInfo()
        daemon.daemonID = "d1"
        daemon.online = true
        var workspace = Coflux_V1_Workspace()
        workspace.id = "w1"
        workspace.daemonID = "d1"
        workspace.projectID = "p1"
        var task = Coflux_V1_Task()
        task.id = "t1"
        task.daemonID = "d1"
        task.projectID = "p1"
        task.workspaceID = "w1"
        task.status = .running
        var value = Coflux_V1_StateSnapshot()
        value.daemons = [daemon]
        value.workspaces = [workspace]
        value.tasks = [task]
        return value
    }

    private func update(_ daemonID: String, _ requests: [Coflux_V1_SecretRequestRef]) -> Coflux_V1_SecretRequestsUpdated {
        var value = Coflux_V1_SecretRequestsUpdated()
        value.daemonID = daemonID
        value.requests = requests
        return value
    }

    private func request(_ id: String, taskID: String = "t1", sessionID: String = "s1",
                         createdAt: Double) -> Coflux_V1_SecretRequestRef {
        var value = Coflux_V1_SecretRequestRef()
        value.requestID = id
        value.taskID = taskID
        value.sessionID = sessionID
        value.name = "API_KEY_\(id)"
        value.reason = "needed for the test"
        value.createdAt = createdAt
        value.expiresAt = createdAt + 300_000
        return value
    }
}

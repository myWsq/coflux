import Foundation
import Testing
@testable import Coflux

/// Device 数据面状态机（plan 046）：fake transport 注入，覆盖 attach 三重匹配、
/// resume 拒绝转 snapshot、输出 gap recovery、输入台账 ACK/重投、detach/接管、
/// prepared operation、控制面离线关通道。语义基准 packages/client/src/device-router.ts。
@MainActor
final class DeviceHarness {
    let transport = FakeTransport()
    var controlSent: [Coflux_V1_ClientToServer.OneOf_Payload] = []
    var snapshots: [(sessionID: String, data: Data)] = []
    var outputs: [(sessionID: String, data: Data)] = []
    var attached: [String] = []
    var detached: [(taskID: String, reason: String)] = []
    var exited: [(sessionID: String, exitCode: Int32)] = []
    var errors: [String] = []
    var blocked: [(sessionID: String, blocked: Bool)] = []
    var transportEvents: [(daemonID: String, relayHost: String?, rttMs: Double?)] = []
    var nowMS: Double = 1_000_000
    private(set) var router: DeviceRouter!

    init() {
        router = DeviceRouter(
            transport: transport,
            callbacks: DeviceRouterCallbacks(
                sendControl: { [weak self] payload in self?.controlSent.append(payload) },
                onSessionSnapshot: { [weak self] _, _, sessionID, data in self?.snapshots.append((sessionID, data)) },
                onSessionOutput: { [weak self] _, _, sessionID, data in self?.outputs.append((sessionID, data)) },
                onSessionAttached: { [weak self] _, taskID, _ in self?.attached.append(taskID) },
                onSessionDetached: { [weak self] _, taskID, _, reason in self?.detached.append((taskID, reason)) },
                onSessionExited: { [weak self] _, _, sessionID, exitCode in self?.exited.append((sessionID, exitCode)) },
                onCatalog: { _, _ in },
                onError: { [weak self] message in self?.errors.append(message) },
                onInputBlocked: { [weak self] sessionID, isBlocked in self?.blocked.append((sessionID, isBlocked)) },
                onDeviceTransport: { [weak self] daemonID, relayHost, rttMs in self?.transportEvents.append((daemonID, relayHost, rttMs)) }
            ),
            now: { [weak self] in self?.nowMS ?? 0 }
        )
    }

    /// 最近一次 rendezvous 请求的 channelId。
    var lastRelayChannelID: String? {
        for payload in controlSent.reversed() {
            if case .deviceRelayConnect(let connect) = payload { return connect.channelID }
        }
        return nil
    }

    var relayConnectCount: Int {
        controlSent.count { if case .deviceRelayConnect = $0 { return true } else { return false } }
    }

    /// 等下一个 rendezvous 请求出现 → 签发 grant → 返回随之建立的 fake 连接。
    /// 须在触发动作（attach/executePrepared/setControlOnline）之后同步调用：
    /// seen 基线在任何挂起点之前读取。
    func grantNextRelay() async throws -> FakeConnection {
        let seen = relayConnectCount
        guard await waitUntil({ self.relayConnectCount > seen }) else {
            throw DeviceRouteError("rendezvous 请求未出现")
        }
        guard let channelID = lastRelayChannelID else { throw DeviceRouteError("无 channelId") }
        var grant = Coflux_V1_DeviceRelayGrant()
        grant.channelID = channelID
        grant.ok = true
        grant.relayURL = "wss://relay.test/pipe?token=once"
        _ = router.handleControlPayload(.deviceRelayGrant(grant))
        return await transport.nextConnection()
    }

    func deviceFrames(_ connection: FakeConnection) -> [Coflux_V1_DeviceEnvelope] {
        connection.sent.compactMap { try? Coflux_V1_DeviceEnvelope(serializedBytes: $0) }
    }

    func attachFrames(_ connection: FakeConnection) -> [Coflux_V1_DeviceSessionAttach] {
        deviceFrames(connection).compactMap {
            if case .sessionAttach(let attach) = $0.payload { return attach } else { return nil }
        }
    }

    func inputFrames(_ connection: FakeConnection) -> [Coflux_V1_DevicePtyInput] {
        deviceFrames(connection).compactMap {
            if case .ptyInput(let input) = $0.payload { return input } else { return nil }
        }
    }

    func push(_ connection: FakeConnection, channelID: String, _ payload: Coflux_V1_DeviceEnvelope.OneOf_Payload) {
        var envelope = Coflux_V1_DeviceEnvelope()
        envelope.protocolVersion = DeviceProtocol.version
        envelope.channelID = channelID
        envelope.payload = payload
        connection.pushRaw(try! envelope.serializedBytes())
    }

    /// 建 session lane 并完成 attach（带 snapshot），返回 (连接, channelId)。
    func attachAndSnapshot(
        sessionID: String = "s1", taskID: String = "t1", snapshotSeq: UInt64 = 10
    ) async throws -> (FakeConnection, String) {
        router.setControlOnline(true)
        router.attachSession(daemonID: "d1", taskID: taskID, sessionID: sessionID, cols: 80, rows: 24)
        let connection = try await grantNextRelay()
        let channelID = lastRelayChannelID!
        guard await waitUntil({ !self.attachFrames(connection).isEmpty }) else {
            throw DeviceRouteError("attach 帧未发出")
        }
        let attach = attachFrames(connection).last!
        var response = Coflux_V1_DeviceSessionAttached()
        response.requestID = attach.requestID
        response.sessionID = sessionID
        response.holderEpoch = 1
        response.snapshotSeq = snapshotSeq
        response.ansiSnapshot = Data("SNAPSHOT".utf8)
        response.cols = 80
        response.rows = 24
        push(connection, channelID: channelID, .sessionAttached(response))
        guard await waitUntil({ !self.snapshots.isEmpty }) else {
            throw DeviceRouteError("snapshot 未投递")
        }
        return (connection, channelID)
    }
}

@MainActor
struct DeviceRouterTests {
    @Test func attachDeliversSnapshotAndHolder() async throws {
        let harness = DeviceHarness()
        let (connection, channelID) = try await harness.attachAndSnapshot()
        #expect(harness.snapshots.first?.data == Data("SNAPSHOT".utf8))
        #expect(harness.attached == ["t1"])
        // 首次 attach 不应带 resume_from_seq（无 live 快照可续）
        #expect(harness.attachFrames(connection).first?.hasResumeFromSeq == false)
        // holder 已裁决：输入立即发出且带 holder_epoch
        harness.router.sendInput(daemonID: "d1", sessionID: "s1", data: Data("ls\n".utf8))
        #expect(await waitUntil { harness.inputFrames(connection).count == 1 })
        let input = harness.inputFrames(connection).first!
        #expect(input.holderEpoch == 1)
        #expect(input.inputSeq == 1)
        _ = channelID
    }

    @Test func continuousOutputAdvancesAndGapForcesSnapshotRecovery() async throws {
        let harness = DeviceHarness()
        let (connection, channelID) = try await harness.attachAndSnapshot(snapshotSeq: 10)
        // 连续段（11..13）被接受
        var output = Coflux_V1_DevicePtyOutput()
        output.sessionID = "s1"
        output.fromSeq = 11
        output.toSeq = 13
        output.data = Data("abc".utf8)
        harness.push(connection, channelID: channelID, .ptyOutput(output))
        #expect(await waitUntil { harness.outputs.count == 1 })
        // 跳号段（20..）整段丢弃并触发 requireSnapshot 重 attach
        var gap = Coflux_V1_DevicePtyOutput()
        gap.sessionID = "s1"
        gap.fromSeq = 20
        gap.toSeq = 20
        gap.data = Data("x".utf8)
        harness.push(connection, channelID: channelID, .ptyOutput(gap))
        #expect(await waitUntil { harness.attachFrames(connection).count == 2 })
        #expect(harness.outputs.count == 1)
        let recovery = harness.attachFrames(connection).last!
        #expect(recovery.hasResumeFromSeq == false)
    }

    @Test func rejectedResumeFallsBackToSnapshotAttach() async throws {
        let harness = DeviceHarness()
        let (connection, _) = try await harness.attachAndSnapshot(snapshotSeq: 10)
        // 通道断开 → 有界恢复 → 新 rendezvous；重挂应请求 resume_from_seq=10
        connection.finish()
        let second = try await harness.grantNextRelay()
        let secondChannelID = harness.lastRelayChannelID!
        #expect(await waitUntil { !harness.attachFrames(second).isEmpty })
        let resume = harness.attachFrames(second).first!
        #expect(resume.hasResumeFromSeq && resume.resumeFromSeq == 10)
        // authority 拒绝续传：回包无 snapshot 且 snapshot_seq 不等于请求值 → 必须转全量 snapshot attach
        var response = Coflux_V1_DeviceSessionAttached()
        response.requestID = resume.requestID
        response.sessionID = "s1"
        response.holderEpoch = 2
        response.snapshotSeq = 999
        harness.push(second, channelID: secondChannelID, .sessionAttached(response))
        #expect(await waitUntil { harness.attachFrames(second).count == 2 })
        #expect(harness.attachFrames(second).last!.hasResumeFromSeq == false)
    }

    @Test func inputAckTrimsLedgerAndReplayResendsUnacked() async throws {
        let harness = DeviceHarness()
        let (connection, channelID) = try await harness.attachAndSnapshot(snapshotSeq: 10)
        harness.router.sendInput(daemonID: "d1", sessionID: "s1", data: Data("a".utf8))
        harness.router.sendInput(daemonID: "d1", sessionID: "s1", data: Data("b".utf8))
        #expect(await waitUntil { harness.inputFrames(connection).count == 2 })
        // 累计 ACK 到 seq=1：seq1 出账
        var ack = Coflux_V1_DevicePtyInputAck()
        ack.sessionID = "s1"
        ack.appliedThroughSeq = 1
        harness.push(connection, channelID: channelID, .ptyInputAck(ack))
        #expect(await waitUntil { harness.blocked.contains { $0.blocked == false } })
        // 换通道重挂后 replay：只重投未确认前缀（seq=2），且序号不重排
        connection.finish()
        let second = try await harness.grantNextRelay()
        let secondChannelID = harness.lastRelayChannelID!
        #expect(await waitUntil { !harness.attachFrames(second).isEmpty })
        let attach = harness.attachFrames(second).last!
        var response = Coflux_V1_DeviceSessionAttached()
        response.requestID = attach.requestID
        response.sessionID = "s1"
        response.holderEpoch = 5
        response.snapshotSeq = attach.resumeFromSeq
        harness.push(second, channelID: secondChannelID, .sessionAttached(response))
        #expect(await waitUntil { harness.inputFrames(second).count == 1 })
        let replayed = harness.inputFrames(second).first!
        #expect(replayed.inputSeq == 2)
        #expect(replayed.data == Data("b".utf8))
        #expect(replayed.holderEpoch == 5)
    }

    @Test func detachedStopsAttachUntilForceTakeover() async throws {
        let harness = DeviceHarness()
        let (connection, channelID) = try await harness.attachAndSnapshot(snapshotSeq: 10)
        var payload = Coflux_V1_DeviceSessionDetached()
        payload.sessionID = "s1"
        payload.holderEpoch = 1
        payload.reason = "taken over"
        harness.push(connection, channelID: channelID, .sessionDetached(payload))
        #expect(await waitUntil { harness.detached.count == 1 })
        #expect(harness.detached.first?.reason == "taken over")
        // 被接管期间输入被拒、普通 attach 静默不动作（plan 026 旁观语义）
        #expect(harness.router.sendInput(daemonID: "d1", sessionID: "s1", data: Data("x".utf8)) == false)
        let framesBefore = harness.relayConnectCount
        harness.router.attachSession(daemonID: "d1", taskID: "t1", sessionID: "s1", cols: 80, rows: 24)
        try? await Task.sleep(for: .milliseconds(50))
        #expect(harness.relayConnectCount == framesBefore)
        // force 接管：holder 清零重新 attach（session lane 已因 detach 释放，重新 rendezvous）
        harness.router.attachSession(daemonID: "d1", taskID: "t1", sessionID: "s1", cols: 80, rows: 24, force: true)
        let second = try await harness.grantNextRelay()
        #expect(await waitUntil { !harness.attachFrames(second).isEmpty })
    }

    @Test func preparedOperationFlushesOnElevatedLaneAndExpiredIsRejected() async throws {
        let harness = DeviceHarness()
        harness.router.setControlOnline(true)
        // 过期模板：入口即拒
        var stale = Coflux_V1_PreparedDeviceOperation()
        stale.operationID = "op-stale"
        stale.daemonID = "d1"
        stale.expiresAt = harness.nowMS - 1
        stale.frame = Data([1])
        harness.router.executePrepared(stale)
        #expect(harness.errors.count == 1)
        // 有效模板：填 channel_id 后经 elevated lane 原样发出
        var create = Coflux_V1_DeviceSessionCreate()
        create.requestID = "req-1"
        create.operationID = "op-1"
        create.sessionID = "s-new"
        create.taskID = "t1"
        create.cwd = "/tmp"
        create.cols = 80
        create.rows = 24
        var template = Coflux_V1_DeviceEnvelope()
        template.protocolVersion = DeviceProtocol.version
        template.channelID = ""
        template.payload = .sessionCreate(create)
        var operation = Coflux_V1_PreparedDeviceOperation()
        operation.operationID = "op-1"
        operation.daemonID = "d1"
        operation.expiresAt = harness.nowMS + 60_000
        operation.frame = try template.serializedBytes()
        harness.router.executePrepared(operation)
        let connection = try await harness.grantNextRelay()
        let channelID = harness.lastRelayChannelID!
        #expect(await waitUntil { !harness.deviceFrames(connection).isEmpty })
        let frame = harness.deviceFrames(connection).first!
        #expect(frame.channelID == channelID)
        guard case .sessionCreate(let sent) = frame.payload else {
            Issue.record("期望 sessionCreate 帧")
            return
        }
        #expect(sent.operationID == "op-1")
        #expect(sent.cwd == "/tmp")
        // operationAck 清账 → elevated lane 空闲释放
        var ack = Coflux_V1_DeviceOperationAck()
        ack.requestID = "req-1"
        ack.operationID = "op-1"
        ack.ok = true
        harness.push(connection, channelID: channelID, .operationAck(ack))
        #expect(await waitUntil { harness.errors.count == 1 })  // 无新增错误
    }

    @Test func controlOfflineClosesChannelsAndOnlineRekicksDemand() async throws {
        let harness = DeviceHarness()
        let (_, _) = try await harness.attachAndSnapshot(snapshotSeq: 10)
        let rendezvousBefore = harness.relayConnectCount
        harness.router.setControlOnline(false)
        try? await Task.sleep(for: .milliseconds(50))
        // 离线期间不空转重连
        #expect(harness.relayConnectCount == rendezvousBefore)
        // 回线：session 仍 desired → 自动重新 rendezvous 并重挂（带 resume）
        harness.router.setControlOnline(true)
        let second = try await harness.grantNextRelay()
        #expect(await waitUntil { !harness.attachFrames(second).isEmpty })
        #expect(harness.attachFrames(second).first!.resumeFromSeq == 10)
    }

    @Test func fsWriteSendsFrameAndResolvesResult() async throws {
        let harness = DeviceHarness()
        harness.router.setControlOnline(true)
        let resultTask = Task {
            try await harness.router.fsWrite(
                daemonID: "d1", workspaceID: "w1", path: "paste-1.png", data: Data([1, 2, 3]), temp: true
            )
        }
        let connection = try await harness.grantNextRelay()
        let channelID = harness.lastRelayChannelID!
        guard await waitUntil({ !harness.deviceFrames(connection).isEmpty }) else {
            Issue.record("fsWrite 帧未发出")
            return
        }
        let frame = harness.deviceFrames(connection).first!
        #expect(frame.channelID == channelID)
        guard case .fsWrite(let sent) = frame.payload else {
            Issue.record("期望 fsWrite 帧")
            return
        }
        #expect(sent.workspaceID == "w1")
        #expect(sent.path == "paste-1.png")
        #expect(sent.temp == true)
        #expect(sent.data == Data([1, 2, 3]))
        #expect(!sent.operationID.isEmpty)

        var response = Coflux_V1_FsWriteResult()
        response.requestID = sent.requestID
        response.ok = true
        response.path = "/tmp/coflux-uploads/paste-1.png"
        harness.push(connection, channelID: channelID, .fsWriteResult(response))

        let result = try await resultTask.value
        #expect(result.ok)
        #expect(result.path == "/tmp/coflux-uploads/paste-1.png")
    }

    @Test func fsWriteErrorResponseRejectsPendingRequest() async throws {
        let harness = DeviceHarness()
        harness.router.setControlOnline(true)
        let resultTask = Task {
            try await harness.router.fsWrite(
                daemonID: "d1", workspaceID: "w1", path: "paste-1.png", data: Data([1]), temp: true
            )
        }
        let connection = try await harness.grantNextRelay()
        let channelID = harness.lastRelayChannelID!
        guard await waitUntil({ !harness.deviceFrames(connection).isEmpty }) else {
            Issue.record("fsWrite 帧未发出")
            return
        }
        guard case .fsWrite(let sent) = harness.deviceFrames(connection).first!.payload else {
            Issue.record("期望 fsWrite 帧")
            return
        }
        var error = Coflux_V1_DeviceError()
        error.requestID = sent.requestID
        error.code = "workspace_unknown"
        error.message = "workspaceId 不属于本 daemon 当前清单"
        harness.push(connection, channelID: channelID, .error(error))

        do {
            _ = try await resultTask.value
            Issue.record("期望抛出错误")
        } catch let routeError as DeviceRouteError {
            #expect(routeError.code == "workspace_unknown")
        }
    }

    @Test func fsWriteRejectsOversizedPayloadBeforeSending() async throws {
        let harness = DeviceHarness()
        harness.router.setControlOnline(true)
        let oversized = Data(count: DeviceProtocol.maxUploadBytes + 1)
        do {
            _ = try await harness.router.fsWrite(
                daemonID: "d1", workspaceID: "w1", path: "huge.bin", data: oversized, temp: true
            )
            Issue.record("期望抛出上限错误")
        } catch let routeError as DeviceRouteError {
            #expect(routeError.code == "upload_too_large")
        }
        // 前置拒绝：不该建任何 relay 通道
        #expect(harness.relayConnectCount == 0)
    }

    @Test func suspendReleasesLaneWhenNoDemand() async throws {
        let harness = DeviceHarness()
        let (connection, channelID) = try await harness.attachAndSnapshot(snapshotSeq: 10)
        harness.router.suspendSession(daemonID: "d1", sessionID: "s1")
        // 无需求后通道关闭：后续输出不再投递
        var output = Coflux_V1_DevicePtyOutput()
        output.sessionID = "s1"
        output.fromSeq = 11
        output.toSeq = 11
        output.data = Data("x".utf8)
        harness.push(connection, channelID: channelID, .ptyOutput(output))
        try? await Task.sleep(for: .milliseconds(50))
        #expect(harness.outputs.isEmpty)
    }
}

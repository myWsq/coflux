import CofluxProtocol
import Foundation
import Testing
@testable import CofluxClientCore

private struct SharedRouterTraceFixture: Decodable {
    let schemaVersion: Int
    let traces: [SharedRouterTrace]
}

private struct SharedRouterTrace: Decodable {
    let id: String
    let description: String
    let daemonID: String
    let taskID: String
    let sessionID: String
    let initialSnapshotSeq: String
    let initialHolderEpoch: String
    let steps: [SharedRouterTraceStep]

    enum CodingKeys: String, CodingKey {
        case id, description, initialSnapshotSeq, initialHolderEpoch, steps
        case daemonID = "daemonId"
        case taskID = "taskId"
        case sessionID = "sessionId"
    }
}

private struct SharedRouterTraceStep: Decodable {
    let event: String
    let utf8: String?
    let expectSeq: String?
    let throughSeq: String?
    let online: Bool?
    let expectChannelClosed: Bool?
    let holderEpoch: String?
    let expectResumeFromSeq: String?
    let expectUniqueSeqs: [String]?
    let expectUtf8BySeq: [String: String]?
    let expectHolderEpoch: String?
    let requestID: String?
    let snapshotOwnerID: String?
    let snapshotEpoch: String?
    let eventIDs: [String]?
    let expectEventIDs: [String]?
    let expectRequestID: String?
    let expectSnapshotOwnerID: String?
    let expectSnapshotEpoch: String?

    enum CodingKeys: String, CodingKey {
        case event, utf8, expectSeq, throughSeq, online, expectChannelClosed
        case holderEpoch, expectResumeFromSeq, expectUniqueSeqs, expectUtf8BySeq, expectHolderEpoch
        case snapshotEpoch, expectSnapshotEpoch
        case requestID = "requestId"
        case snapshotOwnerID = "snapshotOwnerId"
        case eventIDs = "eventIds"
        case expectEventIDs = "expectEventIds"
        case expectRequestID = "expectRequestId"
        case expectSnapshotOwnerID = "expectSnapshotOwnerId"
    }
}

private func loadSharedRouterTraceFixture() throws -> SharedRouterTraceFixture {
    // fixture 位于仓库级 tests/fixtures，供 TS 与 Swift 共读。由当前源码位置向上找仓库根，
    // 不依赖 swift test 的 cwd，也不把同一份 JSON 复制进 SwiftPM resources。
    var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while directory.path != "/" {
        let candidate = directory
            .appendingPathComponent("tests/fixtures/device-router/behavior-traces.json")
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try JSONDecoder().decode(SharedRouterTraceFixture.self, from: Data(contentsOf: candidate))
        }
        directory.deleteLastPathComponent()
    }
    throw DeviceRouteError("找不到 DeviceRouter 共享 trace fixture")
}

private func traceUInt64(_ value: String?, traceID: String, field: String) throws -> UInt64 {
    guard let value, let parsed = UInt64(value) else {
        throw DeviceRouteError("\(traceID): trace 字段 \(field) 不是 UInt64 十进制字符串")
    }
    return parsed
}

/// 与 TypeScript 测试解释同一份语义 trace。Swift 保持 relay-only 产品边界；fixture 因而只描述
/// 两端共有的 session/relay 行为，不把 Web 独有的 direct/P2P promotion 反向扩散到 iOS。
@MainActor
struct DeviceRouterParityTests {
    @Test func sharedBehaviorTraces() async throws {
        let fixture = try loadSharedRouterTraceFixture()
        #expect(fixture.schemaVersion == 1)
        #expect(!fixture.traces.isEmpty)
        for trace in fixture.traces {
            try await run(trace)
        }
    }

    private func run(_ trace: SharedRouterTrace) async throws {
        let harness = DeviceHarness()
        harness.router.setControlOnline(true)
        harness.router.attachSession(
            daemonID: trace.daemonID,
            taskID: trace.taskID,
            sessionID: trace.sessionID,
            cols: 80,
            rows: 24
        )

        var activeConnection = try await harness.grantNextRelay()
        guard let firstChannelID = harness.lastRelayChannelID else {
            throw DeviceRouteError("\(trace.id): 初始 relay 缺少 channelId")
        }
        var activeChannelID = firstChannelID
        guard await waitUntil({ !harness.attachFrames(activeConnection).isEmpty }) else {
            throw DeviceRouteError("\(trace.id): 初始 attach 帧未发出")
        }
        let initialAttach = harness.attachFrames(activeConnection).last!
        #expect(!initialAttach.hasResumeFromSeq, "\(trace.id): 首次 attach 不得猜测 resume cursor")

        var initialResponse = Coflux_V1_DeviceSessionAttached()
        initialResponse.requestID = initialAttach.requestID
        initialResponse.sessionID = trace.sessionID
        initialResponse.holderEpoch = try traceUInt64(
            trace.initialHolderEpoch, traceID: trace.id, field: "initialHolderEpoch"
        )
        initialResponse.snapshotSeq = try traceUInt64(
            trace.initialSnapshotSeq, traceID: trace.id, field: "initialSnapshotSeq"
        )
        initialResponse.ansiSnapshot = Data("SNAPSHOT".utf8)
        initialResponse.cols = 80
        initialResponse.rows = 24
        harness.push(activeConnection, channelID: activeChannelID, .sessionAttached(initialResponse))
        guard await waitUntil({ harness.snapshots.count == 1 }) else {
            throw DeviceRouteError("\(trace.id): 初始 snapshot 未投递")
        }

        for step in trace.steps {
            switch step.event {
            case "sendInput":
                guard let text = step.utf8 else {
                    throw DeviceRouteError("\(trace.id): sendInput 缺少 utf8")
                }
                let expectedSeq = try traceUInt64(step.expectSeq, traceID: trace.id, field: "expectSeq")
                #expect(
                    harness.router.sendInput(
                        daemonID: trace.daemonID,
                        sessionID: trace.sessionID,
                        data: Data(text.utf8)
                    ),
                    "\(trace.id): input 应进入台账"
                )
                guard await waitUntil({
                    harness.inputFrames(activeConnection).contains { $0.inputSeq == expectedSeq }
                }) else {
                    throw DeviceRouteError("\(trace.id): 缺少 input_seq=\(expectedSeq)")
                }
                let sent = harness.inputFrames(activeConnection).last { $0.inputSeq == expectedSeq }!
                #expect(sent.data == Data(text.utf8), "\(trace.id): input 数据漂移")

            case "inputAck":
                let inputStateUpdatesBeforeAck = harness.blocked.count
                var ack = Coflux_V1_DevicePtyInputAck()
                ack.sessionID = trace.sessionID
                ack.appliedThroughSeq = try traceUInt64(
                    step.throughSeq, traceID: trace.id, field: "throughSeq"
                )
                harness.push(activeConnection, channelID: activeChannelID, .ptyInputAck(ack))
                guard await waitUntil({ harness.blocked.count > inputStateUpdatesBeforeAck }) else {
                    throw DeviceRouteError("\(trace.id): input ACK 未被状态机消费")
                }

            case "setControlOnline":
                guard let online = step.online else {
                    throw DeviceRouteError("\(trace.id): setControlOnline 缺少 online")
                }
                harness.router.setControlOnline(online)
                if let expectedClosed = step.expectChannelClosed {
                    if expectedClosed {
                        #expect(
                            await waitUntil { activeConnection.closed },
                            "\(trace.id): control 断线后 relay 未关闭"
                        )
                    } else {
                        try? await Task.sleep(for: .milliseconds(20))
                        #expect(!activeConnection.closed, "\(trace.id): control 状态切换误关 relay")
                    }
                }

            case "reopenSession":
                let reopened = try await harness.grantNextRelay()
                guard let reopenedChannelID = harness.lastRelayChannelID else {
                    throw DeviceRouteError("\(trace.id): 重连 relay 缺少 channelId")
                }
                #expect(reopened !== activeConnection, "\(trace.id): control 恢复后必须建立新 relay")
                guard await waitUntil({ !harness.attachFrames(reopened).isEmpty }) else {
                    throw DeviceRouteError("\(trace.id): 重连 attach 帧未发出")
                }
                let resumed = harness.attachFrames(reopened).last!
                let expectedResume = try traceUInt64(
                    step.expectResumeFromSeq, traceID: trace.id, field: "expectResumeFromSeq"
                )
                #expect(resumed.hasResumeFromSeq, "\(trace.id): 重连 attach 缺少 resume cursor")
                #expect(
                    resumed.resumeFromSeq == expectedResume,
                    "\(trace.id): 重连 attach 未沿用已应用输出游标"
                )

                let attachedBefore = harness.attached.count
                var response = Coflux_V1_DeviceSessionAttached()
                response.requestID = resumed.requestID
                response.sessionID = trace.sessionID
                response.holderEpoch = try traceUInt64(
                    step.holderEpoch, traceID: trace.id, field: "holderEpoch"
                )
                response.snapshotSeq = expectedResume
                harness.push(reopened, channelID: reopenedChannelID, .sessionAttached(response))
                guard await waitUntil({ harness.attached.count > attachedBefore }) else {
                    throw DeviceRouteError("\(trace.id): resume attach 未完成")
                }
                activeConnection = reopened
                activeChannelID = reopenedChannelID

            case "sessionCatalog":
                guard let requestID = step.requestID,
                      let snapshotOwnerID = step.snapshotOwnerID,
                      let eventIDs = step.eventIDs else {
                    throw DeviceRouteError("\(trace.id): sessionCatalog 缺少绑定字段")
                }
                var catalog = Coflux_V1_DeviceSessionCatalog()
                catalog.requestID = requestID
                catalog.snapshotOwnerID = snapshotOwnerID
                catalog.snapshotEpoch = try traceUInt64(
                    step.snapshotEpoch, traceID: trace.id, field: "snapshotEpoch"
                )
                catalog.exits = eventIDs.enumerated().map { index, eventID in
                    var exit = Coflux_V1_DeviceSessionExitTombstone()
                    exit.eventID = eventID
                    exit.sessionID = "exited-session-\(index)"
                    exit.taskID = "exited-task-\(index)"
                    exit.exitCode = Int32(index)
                    exit.finalOutputSeq = UInt64(index)
                    exit.exitedAt = Double(index + 1)
                    return exit
                }
                harness.push(activeConnection, channelID: activeChannelID, .sessionCatalog(catalog))

            case "expectExitAck":
                guard let expectedEventIDs = step.expectEventIDs,
                      let expectedRequestID = step.expectRequestID,
                      let expectedSnapshotOwnerID = step.expectSnapshotOwnerID else {
                    throw DeviceRouteError("\(trace.id): expectExitAck 缺少期望绑定字段")
                }
                let expectedSnapshotEpoch = try traceUInt64(
                    step.expectSnapshotEpoch, traceID: trace.id, field: "expectSnapshotEpoch"
                )
                guard await waitUntil({
                    harness.deviceFrames(activeConnection).contains {
                        if case .exitAck = $0.payload { return true }
                        return false
                    }
                }) else {
                    throw DeviceRouteError("\(trace.id): catalog exits 未产生 ACK")
                }
                let acks = harness.deviceFrames(activeConnection).compactMap {
                    if case .exitAck(let ack) = $0.payload { return ack }
                    return nil
                }
                let ack = acks.last!
                #expect(ack.eventIds == expectedEventIDs, "\(trace.id): exitAck 未过滤空 eventId")
                #expect(ack.requestID == expectedRequestID, "\(trace.id): exitAck requestId 未绑定 catalog")
                #expect(
                    ack.snapshotOwnerID == expectedSnapshotOwnerID,
                    "\(trace.id): exitAck snapshotOwnerId 未绑定 catalog"
                )
                #expect(
                    ack.snapshotEpoch == expectedSnapshotEpoch,
                    "\(trace.id): exitAck snapshotEpoch 未绑定 catalog"
                )

            case "expectInputReplay":
                guard await waitUntil({ !harness.inputFrames(activeConnection).isEmpty }) else {
                    throw DeviceRouteError("\(trace.id): 重连后未重投输入")
                }
                let frames = harness.inputFrames(activeConnection)
                let expectedSeqs = try (step.expectUniqueSeqs ?? []).map {
                    try traceUInt64($0, traceID: trace.id, field: "expectUniqueSeqs")
                }
                #expect(
                    Array(Set(frames.map(\.inputSeq))).sorted() == expectedSeqs,
                    "\(trace.id): ACK 前缀被重复投递或未确认后缀丢失"
                )
                let expectedHolder = try traceUInt64(
                    step.expectHolderEpoch, traceID: trace.id, field: "expectHolderEpoch"
                )
                #expect(
                    frames.allSatisfy { $0.holderEpoch == expectedHolder },
                    "\(trace.id): replay 未采用新 holder epoch"
                )
                var utf8BySeq: [String: String] = [:]
                for frame in frames {
                    utf8BySeq[String(frame.inputSeq)] = String(decoding: frame.data, as: UTF8.self)
                }
                #expect(
                    utf8BySeq == step.expectUtf8BySeq,
                    "\(trace.id): replay 数据与 seq 映射漂移"
                )

            default:
                throw DeviceRouteError("\(trace.id): 未实现的共享 trace 事件 \(step.event)")
            }
        }
        #expect(harness.errors.isEmpty, "\(trace.id): trace 不应产生 Router 错误")
    }
}

import CofluxApplePlatform
import CofluxClientCore
import Foundation
import Testing
@testable import Coflux

private struct IntegrationTokenStore: TokenStore {
    func read() throws -> String? { nil }
    func write(_: String) throws {}
    func clear() throws {}
}

@MainActor
private func integrationWaitUntil(
    timeout: Duration,
    _ condition: () -> Bool
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while clock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
}

/// 真环境终端闭环验收（plan 046 acceptance）：连本机 dev 拓扑（server 8787 + relay 8790 +
/// 真 daemon），不经 UI 直接驱动 CofluxClient/DeviceRouter 完成
/// 启动任务 → attach → 输入回显 → 停止删除。
///
/// 默认不跑；前置（手动）：
/// 1. `pnpm dev:server`（DATABASE_URL 指 54322 直连口）+ `pnpm dev:relay` + `pnpm dev:daemon`
/// 2. 控制面创建名为 ios-acceptance 的任务（TaskCreate；任务会在测试结束被删除）
/// 3. `xcodebuild ... test TEST_RUNNER_COFLUX_INTEGRATION=1`
@MainActor
@Suite(.enabled(if: ProcessInfo.processInfo.environment["COFLUX_INTEGRATION"] == "1"))
struct DeviceIntegrationTests {
    @Test(.timeLimit(.minutes(2)))
    func terminalRoundTripAgainstDevTopology() async throws {
        let client = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://127.0.0.1:8787/client")!,
                buildID: "dev"
            ),
            transport: NetworkFrameworkTransport(),
            tokenStore: IntegrationTokenStore()
        )
        client.login(username: "admin", password: "admin")
        #expect(await integrationWaitUntil(timeout: .seconds(10)) { client.authState == .authed })

        // 前置脚本创建的验收任务
        #expect(await integrationWaitUntil(timeout: .seconds(10)) {
            client.tasks.contains { $0.title == "ios-acceptance" }
        })
        let taskID = client.tasks.first { $0.title == "ios-acceptance" }!.id

        // 启动：taskStart → preparedDeviceOperation → LIFECYCLE relay lane → daemon 建 PTY
        client.startTask(taskID: taskID, cols: 80, rows: 24)
        #expect(await integrationWaitUntil(timeout: .seconds(20)) {
            client.tasks.first { $0.id == taskID }?.hasSessionID == true
        })
        let sessionID = client.tasks.first { $0.id == taskID }!.sessionID

        // attach 现场：先注册 consumer 再 attach，snapshot(replace) 必须先于增量到达
        var received = Data()
        var sawReplace = false
        let release = client.registerSessionConsumer(sessionID: sessionID) { data, replace in
            if replace {
                sawReplace = true
                received = data
            } else {
                received.append(data)
            }
        }
        defer { release() }
        client.startTask(taskID: taskID, cols: 80, rows: 24)
        #expect(await integrationWaitUntil(timeout: .seconds(20)) { sawReplace })

        // 输入回显闭环（exactly-once 台账走真 relay）
        client.sendInput(sessionID: sessionID, "echo coflux-ios-e2e\n")
        #expect(await integrationWaitUntil(timeout: .seconds(20)) {
            String(data: received, encoding: .utf8)?.contains("coflux-ios-e2e") == true
        })

        // 停止并删除：sessionStop（holder 前置）+ taskRemove → 任务从控制面消失
        await client.closeTask(client.tasks.first { $0.id == taskID }!)
        #expect(await integrationWaitUntil(timeout: .seconds(15)) {
            client.tasks.contains { $0.id == taskID } == false
        })
    }
}

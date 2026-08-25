import CofluxProtocol
import Foundation
import Testing
@testable import CofluxClientCore

@MainActor
struct AuthFlowTests {
    private func makeClient(
        transport: FakeTransport,
        store: InMemoryTokenStore = InMemoryTokenStore()
    ) -> CofluxClient {
        CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: transport,
            tokenStore: store
        )
    }

    @Test func loginSendsAuthThenPersistsTokenAndSubscribes() async throws {
        let transport = FakeTransport()
        let store = InMemoryTokenStore()
        let client = makeClient(transport: transport, store: store)

        client.login(username: "dev", password: "secret")
        #expect(client.authState == .authenticating)
        let connection = await transport.nextConnection()

        // 第一帧必须是 clientAuth：用户名密码直发 + clientVersion "dev"
        #expect(await waitUntil { connection.sent.count >= 1 })
        guard case .clientAuth(let auth)? = decodeClientFrame(connection.sent[0]) else {
            Issue.record("首帧不是 clientAuth")
            return
        }
        #expect(auth.username == "dev")
        #expect(auth.password == "secret")
        #expect(auth.clientVersion == "dev")

        var authOk = Coflux_V1_AuthOk()
        authOk.accountID = "a1"
        authOk.clientToken = "ck_sess_test"
        connection.push(.authOk(authOk))

        #expect(await waitUntil { client.authState == .authed })
        #expect(store.value == "ck_sess_test") // authOk 回带 token 即持久化（store.ts:333-336）

        // authOk 后立即 clientSubscribe（store.ts:337）
        #expect(await waitUntil { connection.sent.count >= 2 })
        guard case .clientSubscribe? = decodeClientFrame(connection.sent[1]) else {
            Issue.record("authOk 后第二帧不是 clientSubscribe")
            return
        }
    }

    @Test func authErrorStopsReconnect() async throws {
        let transport = FakeTransport()
        let store = InMemoryTokenStore(value: "bad-token")
        // 构造时有本地 token：自动以 token 重连（store.ts:666 语义）
        let client = makeClient(transport: transport, store: store)
        #expect(client.authState == .authenticating)
        let connection = await transport.nextConnection()

        var error = Coflux_V1_AuthError()
        error.message = "认证失败"
        connection.push(.authError(error))
        connection.finish()

        #expect(await waitUntil { client.authState == .authFailed })
        #expect(store.value == nil)
        // 凭证已失效：连接结束后不得再自动重连（否则退避循环打服务器，store.ts:341-351）
        try await Task.sleep(for: .milliseconds(80))
        #expect(await transport.connectCount == 1)
    }

    @Test func terminalAuthFailureRejectsAlreadyBufferedFrames() async throws {
        let transport = FakeTransport()
        let store = InMemoryTokenStore(value: "bad-token")
        let client = makeClient(transport: transport, store: store)
        let connection = await transport.nextConnection()

        var error = Coflux_V1_AuthError()
        error.message = "认证失败"
        var staleSnapshot = Coflux_V1_StateSnapshot()
        var daemon = Coflux_V1_DaemonInfo()
        daemon.daemonID = "must-not-apply"
        staleSnapshot.daemons = [daemon]
        connection.push(.authError(error))
        connection.push(.stateSnapshot(staleSnapshot))

        #expect(await waitUntil { client.authState == .authFailed && connection.closed })
        try await Task.sleep(for: .milliseconds(20))
        #expect(client.status == .disconnected)
        #expect(client.syncState == .notSubscribed)
        #expect(client.daemons.isEmpty)
    }

    @Test func clientOutdatedKeepsTokenAndStopsReconnect() async throws {
        let transport = FakeTransport()
        let store = InMemoryTokenStore(value: "keep-token")
        let client = makeClient(transport: transport, store: store)
        let connection = await transport.nextConnection()

        connection.push(.clientOutdated(Coflux_V1_ClientOutdated()))

        #expect(await waitUntil { client.authState == .outdated && connection.closed })
        #expect(store.value == "keep-token")
        try await Task.sleep(for: .milliseconds(80))
        #expect(await transport.connectCount == 1)
    }

    @Test func droppedConnectionReconnectsAfterAuthed() async throws {
        let transport = FakeTransport()
        let store = InMemoryTokenStore()
        let client = makeClient(transport: transport, store: store)

        client.login(username: "dev", password: "secret")
        let first = await transport.nextConnection()
        var authOk = Coflux_V1_AuthOk()
        authOk.accountID = "a1"
        authOk.clientToken = "ck_sess_test"
        first.push(.authOk(authOk))
        #expect(await waitUntil { client.authState == .authed })

        // 服务端断开：应按退避自动重连，且重连凭证是会话 token
        first.finish()
        let second = await transport.nextConnection()
        #expect(await transport.connectCount == 2)
        #expect(await waitUntil { second.sent.count >= 1 })
        guard case .clientAuth(let auth)? = decodeClientFrame(second.sent[0]) else {
            Issue.record("重连首帧不是 clientAuth")
            return
        }
        #expect(auth.clientToken == "ck_sess_test")
        // 断线期间保持 authed（保留快照渲染，由横幅提示，store.ts:517-519）
        #expect(client.authState == .authed)
    }

    @Test func storedTokenReconnectsWhenFirstHandshakeDrops() async throws {
        let transport = FakeTransport()
        let store = InMemoryTokenStore(value: "stored-token")
        let client = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "injected-build"
            ),
            transport: transport,
            tokenStore: store,
            jitter: FixedJitter(value: 0)
        )

        let first = await transport.nextConnection()
        #expect(await waitUntil { first.sent.count == 1 })
        guard case .clientAuth(let firstAuth)? = decodeClientFrame(first.sent[0]) else {
            Issue.record("首连没有认证帧")
            return
        }
        #expect(firstAuth.clientToken == "stored-token")
        #expect(firstAuth.clientVersion == "injected-build")

        first.finish()
        let second = await transport.nextConnection()
        #expect(await waitUntil { second.sent.count == 1 })
        guard case .clientAuth(let secondAuth)? = decodeClientFrame(second.sent[0]) else {
            Issue.record("重连没有认证帧")
            return
        }
        #expect(secondAuth.clientToken == "stored-token")
        #expect(await transport.connectCount == 2)
        client.logout()
    }

    @Test func staleConnectionCannotApplyFramesToNewGeneration() async throws {
        let stale = StickyReceiveConnection()
        let current = FakeConnection()
        let transport = SequenceTransport([stale, current])
        let store = InMemoryTokenStore()
        let client = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: transport,
            tokenStore: store
        )

        client.login(username: "first", password: "secret-1")
        #expect(await waitUntil { stale.sent.count == 1 })
        client.login(username: "second", password: "secret-2")
        #expect(await waitUntil { current.sent.count == 1 })

        var staleAuth = Coflux_V1_AuthOk()
        staleAuth.accountID = "stale-account"
        staleAuth.clientToken = "stale-token"
        stale.push(.authOk(staleAuth))
        try await Task.sleep(for: .milliseconds(20))
        #expect(client.authState == .authenticating)
        #expect(store.value == nil)
        #expect(current.sent.count == 1)

        var currentAuth = Coflux_V1_AuthOk()
        currentAuth.accountID = "current-account"
        currentAuth.clientToken = "current-token"
        current.push(.authOk(currentAuth))
        #expect(await waitUntil { client.authState == .authed })
        #expect(store.value == "current-token")
        client.logout()
    }

    @Test func tokenAuthOkWithoutReplacementKeepsStoredToken() async throws {
        let transport = FakeTransport()
        let store = InMemoryTokenStore(value: "keep-token")
        let client = makeClient(transport: transport, store: store)
        let connection = await transport.nextConnection()

        var authOk = Coflux_V1_AuthOk()
        authOk.accountID = "a1"
        connection.push(.authOk(authOk))

        #expect(await waitUntil { client.authState == .authed })
        #expect(store.value == "keep-token")
        client.logout()
    }

    @Test func controlSendsAreSerializedAndKeepCausalOrder() async throws {
        let connection = SendConcurrencyProbeConnection()
        let transport = SingleConnectionTransport(connection: connection)
        let client = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: transport,
            tokenStore: InMemoryTokenStore()
        )

        client.login(username: "dev", password: "secret")
        #expect(await waitUntil { connection.sentFrames.count == 1 })
        var authOk = Coflux_V1_AuthOk()
        authOk.accountID = "a1"
        connection.push(.authOk(authOk))
        #expect(await waitUntil { client.authState == .authed })
        client.createTask(workspaceID: "w1", title: "terminal")

        #expect(await waitUntil { connection.sentFrames.count == 3 })
        let frames = connection.sentFrames
        #expect(connection.maximumConcurrentSends == 1)
        guard case .clientSubscribe? = decodeClientFrame(frames[1]),
              case .taskCreate? = decodeClientFrame(frames[2])
        else {
            Issue.record("subscribe 与 taskCreate 因果顺序漂移")
            return
        }
        client.logout()
    }

    @Test func outboundSilenceClosesSocket() async throws {
        let transport = FakeTransport()
        let clock = ManualClock()
        let client = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: transport,
            tokenStore: InMemoryTokenStore(),
            clock: clock,
            jitter: FixedJitter(value: 0)
        )

        client.login(username: "dev", password: "secret")
        let connection = await transport.nextConnection()
        #expect(await waitUntil { connection.sent.count == 1 && clock.waiterCount == 1 })
        clock.wakeAll()
        #expect(await waitUntil { connection.closed && client.status == .disconnected })
    }

    @Test func laterOutboundDoesNotExtendFirstUnansweredDeadline() async throws {
        let transport = FakeTransport()
        let clock = ManualClock()
        let client = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: transport,
            tokenStore: InMemoryTokenStore(),
            clock: clock
        )

        client.login(username: "dev", password: "secret")
        let connection = await transport.nextConnection()
        #expect(await waitUntil { connection.sent.count == 1 && clock.waiterCount == 1 && clock.sleepStartCount == 1 })

        // AuthOk 是入站证明：解除认证帧的 watchdog；subscribe 成为新的第一条未回应 outbound。
        var authOk = Coflux_V1_AuthOk()
        authOk.accountID = "a1"
        authOk.clientToken = "ck_sess_test"
        connection.push(.authOk(authOk))
        #expect(await waitUntil { connection.sent.count == 2 && clock.waiterCount == 1 && clock.sleepStartCount == 2 })

        // 两个后续 operation 仍未收到任何 inbound。等第四帧进入 send，能确定第三帧对应的
        // sendTail 已完整结束（包含 armWatchdog），避免只看 sent.count 的调度竞态。
        client.createTask(workspaceID: "w1", title: "terminal")
        client.createTask(workspaceID: "w1", title: "terminal-2")
        #expect(await waitUntil { connection.sent.count == 4 })
        #expect(clock.waiterCount == 1)
        #expect(clock.sleepStartCount == 2)

        client.logout()
        clock.wakeAll()
    }

    @Test func watchdogStartsBeforeSuspendedSendAndClosesSilentConnection() async throws {
        let connection = ControlledSendConnection(blockedIndices: [1])
        let transport = SequenceTransport([connection])
        let clock = ManualClock()
        let client = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: transport,
            tokenStore: InMemoryTokenStore(),
            clock: clock
        )

        client.login(username: "dev", password: "secret")
        #expect(await waitUntil { connection.sent.count == 1 && clock.waiterCount == 1 })
        connection.push(.authOk(Coflux_V1_AuthOk()))

        // subscribe send 已经挂起，但本次 outbound 的 watchdog 必须先处于 active。
        #expect(await waitUntil {
            connection.blockedSendCount == 1 && clock.waiterCount == 1 && clock.sleepStartCount == 2
        })
        clock.wakeAll()
        #expect(await waitUntil { connection.closed && client.status == .disconnected })
    }

    @Test func inboundDuringSuspendedSendDoesNotLeaveFalseWatchdog() async throws {
        let connection = ControlledSendConnection(blockedIndices: [1])
        let transport = SequenceTransport([connection])
        let clock = ManualClock()
        let client = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: transport,
            tokenStore: InMemoryTokenStore(),
            clock: clock
        )

        client.login(username: "dev", password: "secret")
        #expect(await waitUntil { connection.sent.count == 1 && clock.waiterCount == 1 })
        connection.push(.authOk(Coflux_V1_AuthOk()))
        #expect(await waitUntil {
            connection.blockedSendCount == 1 && clock.waiterCount == 1 && clock.sleepStartCount == 2
        })

        // send 的 continuation 尚未恢复时，任意 inbound 已足以证明链路存活并解除 watchdog。
        connection.push(.stateSnapshot(Coflux_V1_StateSnapshot()))
        #expect(await waitUntil { client.syncState == .synced && clock.waiterCount == 0 })
        connection.releaseSend(1)
        await client.waitForPendingControlSends()
        #expect(await waitUntil { clock.sleepStartCount == 2 })
        #expect(clock.waiterCount == 0)
        #expect(!connection.closed)
        client.logout()
    }

    @Test func tokenStoreFailuresAreObservableWithoutLeakingCredential() async throws {
        let readClient = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: FakeTransport(),
            tokenStore: FailingTokenStore(.read)
        )
        #expect(readClient.authState == .needLogin)
        #expect(readClient.lastError?.message.contains("无法读取本机会话") == true)

        let writeTransport = FakeTransport()
        let writeClient = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: writeTransport,
            tokenStore: FailingTokenStore(.write)
        )
        writeClient.login(username: "dev", password: "secret")
        let connection = await writeTransport.nextConnection()
        var authOk = Coflux_V1_AuthOk()
        authOk.clientToken = "must-not-appear-in-error"
        connection.push(.authOk(authOk))
        #expect(await waitUntil { writeClient.lastError?.message.contains("无法保存本机会话") == true })
        #expect(writeClient.lastError?.message.contains("must-not-appear-in-error") == false)
        writeClient.logout()

        let clearClient = CofluxClient(
            configuration: ClientConfiguration(
                serverURL: URL(string: "ws://fake.test/client")!,
                buildID: "dev"
            ),
            transport: FakeTransport(),
            tokenStore: FailingTokenStore(.clear)
        )
        clearClient.logout()
        #expect(clearClient.lastError?.message.contains("无法清除本机会话") == true)
    }

    @Test func logoutClearsStateAndToken() async throws {
        let transport = FakeTransport()
        let store = InMemoryTokenStore()
        let client = makeClient(transport: transport, store: store)

        client.login(username: "dev", password: "secret")
        let connection = await transport.nextConnection()
        var authOk = Coflux_V1_AuthOk()
        authOk.accountID = "a1"
        authOk.clientToken = "ck_sess_test"
        connection.push(.authOk(authOk))
        #expect(await waitUntil { client.authState == .authed })

        client.logout()
        #expect(client.authState == .needLogin)
        #expect(store.value == nil)
        #expect(client.daemons.isEmpty && client.projects.isEmpty && client.workspaces.isEmpty && client.tasks.isEmpty)
        // 登出先投递服务端撤销（ClientLogout）再关连接
        #expect(await waitUntil { connection.sent.contains { if case .clientLogout? = decodeClientFrame($0) { true } else { false } } })
        try await Task.sleep(for: .milliseconds(80))
        #expect(await transport.connectCount == 1)
    }
}

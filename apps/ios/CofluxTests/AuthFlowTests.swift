import Foundation
import Testing
@testable import Coflux

@MainActor
struct AuthFlowTests {
    private func makeClient(
        transport: FakeTransport,
        store: InMemoryTokenStore = InMemoryTokenStore()
    ) -> CofluxClient {
        CofluxClient(
            transport: transport,
            tokenStore: store,
            serverURL: URL(string: "ws://fake.test/client")!,
            usesExternalLogin: false
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

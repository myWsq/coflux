import CofluxApplePlatform
import CofluxClientCore
import Foundation
import SwiftUI

/// hosted XCTest 会先初始化 App；此 store 保证测试宿主不读取、写入或清理正式会话 token。
struct TestHostTokenStore: TokenStore {
    func read() throws -> String? { nil }
    func write(_: String) throws {}
    func clear() throws {}
}

enum CofluxAppComposition {
    static func makeTokenStore(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> any TokenStore {
        if environment["COFLUX_IOS_TEST_HOST"] == "1" {
            return TestHostTokenStore()
        }
        // 与迁移前 Bundle ID namespace 完全一致，保留用户既有会话。
        return KeychainTokenStore(service: "dev.coflux.Coflux")
    }
}

@main
@MainActor
struct CofluxApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var client: CofluxClient
    /// Which window owns each terminal: one registry for all scenes, like the client itself.
    @State private var terminalOwnership = TerminalOwnership()

    init() {
        _client = State(initialValue: CofluxClient(
            configuration: ClientConfiguration(
                serverURL: Config.serverURL,
                // iOS 正式 native 准入留 Phase 6；当前兼容既有发布策略，显式而非 core 默认。
                buildID: "dev"
            ),
            transport: NetworkFrameworkTransport(),
            tokenStore: CofluxAppComposition.makeTokenStore(),
            // iOS 只做连接方：进程内跑 Tailcat 用户态网络栈，既不服务也不抓系统流量，
            // 因此不需要 NetworkExtension，也永远不会弹 VPN 授权。
            remoteDeviceProvider: TailcatDeviceTransportProvider(bridge: CofluxTailcatBridge())
        ))
    }

    var body: some Scene {
        // One WindowGroup, any number of windows (Split View, two Coflux windows side by side):
        // each window gets its own RootView and navigation; client and ownership are shared.
        WindowGroup {
            RootView(client: client)
                .environment(terminalOwnership)
        }
        .onChange(of: scenePhase) { _, phase in
            // 进后台主动断连、回前台无条件重建（plan 044 后台生命周期决策）。
            // The App-level phase aggregates every scene: background only when all windows are.
            switch phase {
            case .background:
                client.suspend()
            case .active:
                client.resume()
            default:
                break
            }
        }
    }
}

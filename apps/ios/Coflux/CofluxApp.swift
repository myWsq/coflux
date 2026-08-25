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

    init() {
        _client = State(initialValue: CofluxClient(
            configuration: ClientConfiguration(
                serverURL: Config.serverURL,
                // iOS 正式 native 准入留 Phase 6；当前兼容既有发布策略，显式而非 core 默认。
                buildID: "dev"
            ),
            transport: NetworkFrameworkTransport(),
            tokenStore: CofluxAppComposition.makeTokenStore()
        ))
    }

    var body: some Scene {
        WindowGroup {
            // 视觉对标 Cursor iOS；主题跟随系统自动切换（深色=真黑，浅色=系统白）
            RootView(client: client)
        }
        .onChange(of: scenePhase) { _, phase in
            // 进后台主动断连、回前台无条件重建（plan 044 后台生命周期决策）
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

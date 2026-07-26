import SwiftUI

@main
struct CofluxApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var client = CofluxClient()

    var body: some Scene {
        WindowGroup {
            // 视觉对标 Cursor iOS；主题跟随系统自动切换（深色=真黑，浅色=系统白）
            RootView(client: client)
        }
        .onChange(of: scenePhase) { _, phase in
            // 进后台主动断连、回前台无条件重建（plan 044 后台生命周期决策）
            switch phase {
            case .background:
                client.sceneDidEnterBackground()
            case .active:
                client.sceneDidBecomeActive()
            default:
                break
            }
        }
    }
}

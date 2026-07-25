import SwiftUI

@main
struct CofluxApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var client = CofluxClient()

    var body: some Scene {
        WindowGroup {
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

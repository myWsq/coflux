import SwiftUI

/// 验证 UI（plan 044：最终视觉设计不在本片）：按认证状态分发页面。
struct RootView: View {
    let client: CofluxClient

    var body: some View {
        switch client.authState {
        case .needLogin, .authFailed:
            LoginView(client: client)
        case .authenticating:
            ProgressView("登录中…")
        case .authed:
            WorkspaceListView(client: client)
        case .outdated:
            ContentUnavailableView(
                "客户端版本不兼容",
                systemImage: "exclamationmark.triangle",
                description: Text("请更新 app 后重试")
            )
        }
    }
}

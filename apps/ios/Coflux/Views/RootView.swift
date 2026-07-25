import SwiftUI

/// 按认证状态分发页面。authenticating 停留在登录页（按钮内联转圈），避免整页闪换。
struct RootView: View {
    let client: CofluxClient

    var body: some View {
        switch client.authState {
        case .needLogin, .authFailed, .authenticating:
            LoginView(client: client)
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

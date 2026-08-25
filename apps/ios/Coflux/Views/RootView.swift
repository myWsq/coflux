import CofluxClientCore
import SwiftUI

/// 按认证状态分发页面。authenticating 停留在登录页（按钮内联转圈），避免整页闪换。
struct RootView: View {
    let client: CofluxClient

    var body: some View {
        Group {
            switch client.authState {
            case .needLogin, .authFailed, .authenticating:
                LoginView(client: client)
            case .authed:
                if client.snapshotRevision == 0, client.syncState != .synced {
                    ProgressView("正在同步…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.background)
                } else {
                    // 重连重新订阅期间保留上一版快照，只在首次冷启动显示 loading。
                    WorkspaceListView(client: client)
                }
            case .outdated:
                ContentUnavailableView(
                    "客户端版本不兼容",
                    systemImage: "exclamationmark.triangle",
                    description: Text("请更新 app 后重试")
                )
            }
        }
        // 主文字默认色级联：未显式着色的 Text 用 web --foreground（plan 051）
        .foregroundStyle(Theme.foreground)
    }
}

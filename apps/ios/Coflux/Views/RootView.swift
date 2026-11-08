import CofluxClientCore
import SwiftUI

/// 按认证状态分发页面。authenticating 停留在登录页（按钮内联转圈），避免整页闪换。
/// One RootView per window (scene): it owns that window's navigation model.
struct RootView: View {
    let client: CofluxClient
    @State private var navigation = SceneNavigation()

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
                    AppShell(client: client)
                }
            case .outdated:
                ContentUnavailableView(
                    "客户端版本不兼容",
                    systemImage: "exclamationmark.triangle",
                    description: Text("请更新 App 后重试")
                )
            }
        }
        .environment(navigation)
        // 主文字默认色级联：未显式着色的 Text 用 web --foreground（plan 051）
        .foregroundStyle(Theme.foreground)
        // 认证一通过就把「本地网络」授权问掉：等 Tailcat 拨号时系统才问，框会插在连接中途。
        // 登录页不问——那时还不知道有没有设备要连，太突兀。
        .task(id: client.authState == .authed) {
            guard client.authState == .authed else { return }
            LocalNetworkPermission.prime()
        }
        // A new login starts from home, not from the previous account's selection.
        .onChange(of: client.authState) { _, state in
            if state == .needLogin { navigation.reset() }
        }
    }
}

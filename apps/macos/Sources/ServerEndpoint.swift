import Foundation
import SwiftUI

enum ServerEndpoint {
    /// 只有未配置时使用默认值；显式配置无效时不能改连其他环境。
    static func resolve(override: String?, defaultServer: String) throws -> URL {
        let raw = override ?? defaultServer
        guard !raw.isEmpty, !raw.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }),
              let parts = URLComponents(string: raw), ["ws", "wss"].contains(parts.scheme),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.port.map({ (1...65535).contains($0) }) ?? true,
              let url = parts.url else { throw URLError(.badURL) }
        return url
    }
}

struct InvalidServerView: View {
    var body: some View {
        VStack(spacing: 14) {
            Text("服务器地址无效").font(.system(size: 20, weight: .semibold))
            Text("请修正服务器地址后重新打开 coflux。")
                .foregroundStyle(Design.muted)
            Text("地址应以 ws:// 或 wss:// 开头，并包含有效的服务器名称。")
                .font(.system(size: 12)).foregroundStyle(Design.muted)
            Button("退出 coflux") { NSApplication.shared.terminate(nil) }.keyboardShortcut(.cancelAction)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(Design.foreground).background(Design.background)
        .accessibilityIdentifier("startup.invalidServer")
    }
}

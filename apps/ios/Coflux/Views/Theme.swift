import SwiftUI
import UIKit

/// 配色 token —— 真相源是 web 的 `apps/web/src/index.css` :root（plan 051）。
/// Cursor 式暖调近黑、低对比分层、无彩强调；十六进制与 web 逐字对齐，
/// web 换色时此处手工同步（同 lucide 图标策略，见 plan 048/051）。
/// 三层地面（由深至浅）：terminal(#0a0a0a) < background(#0f0f0f) < surface(#151514)。
enum Theme {
    // 地面
    static let terminal = Color(rgb: 0x0A0A0A)        // --terminal 终端纸面
    static let background = Color(rgb: 0x0F0F0F)      // --background 应用底
    static let surface = Color(rgb: 0x151514)         // --card/--sidebar 面板
    static let secondarySurface = Color(rgb: 0x1F1F1E) // --secondary
    static let accentSurface = Color(rgb: 0x262624)   // --accent
    static let input = Color(rgb: 0x2A2A28)           // --input 输入类填充
    static let border = Color(rgb: 0x242422)          // --border 分隔线

    // 文字
    static let foreground = Color(rgb: 0xE6E6E3)      // --foreground 主文字
    static let mutedForeground = Color(rgb: 0x75756D) // --muted-foreground 次级
    /// web 无 tertiary 层，对应 iOS tertiaryLabel 位：muted 降透明度
    static let subtleForeground = Color(rgb: 0x75756D).opacity(0.55)

    // 反色主按钮（web --primary：前景色当背景）
    static let primary = Color(rgb: 0xECECEA)
    static let primaryForeground = Color(rgb: 0x0F0F0F)

    // 状态
    static let success = Color(rgb: 0x4FAE6E)         // --success
    static let warning = Color(rgb: 0xC9A227)         // --warning（web 侧 main 分支同色）
    static let destructive = Color(rgb: 0xE05C6A)     // --destructive

    // 终端（SwiftTerm 用 UIColor；真相源 = web terminal-pane.tsx 的 xterm theme）
    static let terminalUIColor = UIColor(red: 0x0A / 255, green: 0x0A / 255, blue: 0x0A / 255, alpha: 1)
    static let terminalForegroundUIColor = UIColor(red: 0xE4 / 255, green: 0xE4 / 255, blue: 0xE4 / 255, alpha: 1)
}

private extension Color {
    init(rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}

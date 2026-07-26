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

    /// 字阶 —— 移动端规范（plan 052）：语义角色制，全部锚定 Apple 文本样式
    /// （随 Dynamic Type 缩放）。字号真相源是平台而非 web（web base 13px 是
    /// 桌面 IDE 密度，色彩/图形对齐 web、尺寸跟平台）。weight/monospaced 等
    /// 强调修饰在调用点叠加：角色管"是什么"，修饰管"怎么强调"。
    /// 新增文字先选角色；没有合适角色时加角色，不写裸 .font。
    enum Fonts {
        /// 登录页品牌字标——图形而非正文，唯一的固定尺寸豁免
        static let brand = Font.system(size: 40, weight: .bold, design: .monospaced)
        /// 正文级：列表主行标题、分组标题、主按钮（行标题不单设放大档，2026-07-26 用户定）
        static let body = Font.body
        /// 说明文字：横幅、tab chip、副标题行、错误提示
        static let label = Font.footnote
        /// 元数据小字：diff 数字、运行计数
        static let meta = Font.caption
        /// 页面副标题（登录页 slogan）
        static let subtitle = Font.subheadline
    }
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

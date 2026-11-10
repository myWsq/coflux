import SwiftUI
import UIKit

/// 配色 token —— 真相源是桌面渲染层的 `apps/desktop/src/renderer/index.css` :root（plan 051；plan 106 起 web 已并入桌面）。
/// Cursor 式暖调近黑、低对比分层、无彩强调；十六进制与桌面逐字对齐，
/// 桌面换色时此处手工同步（同 lucide 图标策略，见 plan 048/051）。
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
    /// Raised card surface of the Duo redesign (home cards, project groups, composer, sheets):
    /// one step above `surface`, the desktop's popover/muted layer.
    static let card = Color(rgb: 0x1B1B1A)            // --popover / --muted

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
    /// Agent turn finished ("说完了"): the blue of the desktop terminal theme (ANSI blue in
    /// terminal-pane.tsx, the same value as `webAnsiPalette[4]` in TerminalHostView).
    static let info = Color(rgb: 0x6B9BD1)
    /// The microphone is listening: the system's orange recording dot (the full keyboard's space
    /// key while talking, mockup `--mic`).
    static let microphone = Color(rgb: 0xFF9F0A)

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
        /// Section title on home and devices (需要你 / 项目), mockup 19 pt
        static let sectionTitle = Font.title3.weight(.bold)
        /// Card and row title, mockup 15 pt
        static let rowTitle = Font.subheadline.weight(.semibold)
        /// Card body text (an agent's message), mockup 15 pt
        static let cardBody = Font.subheadline
        /// Terminal key caps, mockup 14 pt mono
        static let key = Font.system(.subheadline, design: .monospaced).weight(.semibold)
        /// Dictation transcript, mockup 18 pt
        static let transcript = Font.title3

        /// The full keyboard's caps, drawn in UIKit (`FullKeyBlockView`). Fixed sizes, like the
        /// brand mark: the keys sit on a fixed-height grid and, like the system keyboard's, do not
        /// follow Dynamic Type. Sizes from the mockup `20261110-ios-inner-tall-keyboard-mockup`.
        @MainActor
        enum FullKeyboard {
            /// A letter, mockup 19 pt
            static let letter = UIFont.systemFont(ofSize: 19, weight: .medium)
            /// The large character of a number or symbol key, mockup 17 pt
            static let character = UIFont.systemFont(ofSize: 17, weight: .medium)
            /// The small character above it, mockup 11.5 pt
            static let alternate = UIFont.systemFont(ofSize: 11.5, weight: .regular)
            /// A worded function key (tab, ctrl), mockup 13.5 pt mono
            static let function = UIFont.monospacedSystemFont(ofSize: 13.5, weight: .semibold)
            /// A one-glyph function key (⌫ ⏎ ⇧ ⇪ ⌥ and the arrows), mockup 19 pt
            static let symbol = UIFont.systemFont(ofSize: 19, weight: .medium)
            /// The space key's 按住说话, mockup 13 pt
            static let hint = UIFont.systemFont(ofSize: 13, weight: .medium)
        }
    }

    /// Shapes and sizes of the Duo redesign (mockup "布局规格").
    enum Metrics {
        /// Cards: home cards, project groups, device cards
        static let cardRadius: CGFloat = 24
        /// Key caps: 40 pt high
        static let keyRadius: CGFloat = 13
        static let keyHeight: CGFloat = 40
        /// The one-line composer card; it expands to a multi-line card while typing
        static let composerHeight: CGFloat = 56
        static let composerRadius: CGFloat = 28
        static let expandedComposerRadius: CGFloat = 26
        /// Round buttons inside cards (microphone, send, close)
        static let roundButton: CGFloat = 38
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

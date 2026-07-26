import SwiftUI
import UIKit

/// 终端输入区（plan 053）——移动端两层输入模型：
/// - 成文层：原生输入框 + 系统输入法（中文可用），整段编辑一次发送；
///   发送 = 文本+回车，长按发送 = 仅插入不回车。
/// - 控制层：精简键盘（数字/Esc//、Tab/⇧Tab/⌫、^C/方向/回车），单键直发。
///   无字母（字母走成文层），故不设粘滞 Ctrl——组合键以专用键给出（^C）。
/// 终端本体是纯显示（DisplayOnlyTerminalView），软键盘输入全部从这里走
/// client.sendInput，路由到激活任务的 session；无 RUNNING session 时禁用。
struct TerminalInputArea: View {
    let client: CofluxClient
    let task: Coflux_V1_Task?
    @Binding var collapsed: Bool
    /// 草稿宿主持有：占位条只做预览，点击进与系统键盘同层的成文层
    let draft: String
    let onCompose: () -> Void
    @State private var repeatTimer: Timer?

    private var sessionID: String? {
        guard let task, task.status == .running, task.hasSessionID else { return nil }
        return task.sessionID
    }

    var body: some View {
        VStack(spacing: 8) {
            composerRow
            padRows
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(Theme.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.border).frame(height: 0.5)
        }
        .disabled(sessionID == nil)
        .opacity(sessionID == nil ? 0.45 : 1)
    }

    // MARK: - 成文入口（占位条：预览草稿，点击进成文层——基座冻结，
    // 输入框与系统键盘在独立呈现层同层升降）

    private var composerRow: some View {
        HStack(spacing: 8) {
            Button(action: onCompose) {
                HStack {
                    Text(draft.isEmpty ? "输入后发送到终端" : draft)
                        .font(Theme.Fonts.label)
                        .foregroundStyle(draft.isEmpty ? Theme.mutedForeground : Theme.foreground)
                        .lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .frame(height: 38)
                .background(Theme.input, in: RoundedRectangle(cornerRadius: 10))
            }
            Button {
                collapsed = true // 布局刻意不动画：见 WorkspaceDetailView 气泡注释
            } label: {
                Image(systemName: "keyboard.chevron.compact.down")
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(width: 34, height: 34)
            }
            .accessibilityLabel("收起输入区")
        }
    }

    // MARK: - 控制层

    /// 频率分区布局（2026-07-26 用户定案，第一性推导）：
    /// - 回车 = 最高频 → 竖跨两行大键钉右下角（右拇指落点），primary 高亮；
    /// - 方向簇紧贴回车左侧（菜单流 ↓↓⏎ 零位移），按住连发；
    /// - esc = 打断 agent，高频 → 宽键钉左下角（左拇指落点）；
    /// - 数字 = 快选，中频 → 降为顶部矮行；
    /// - ^C 破坏性大 → 缩小、与回车对角隔离。
    private var padRows: some View {
        VStack(spacing: 6) {
            // 顶排：esc + 数字快选 1-5 + 右上角小⌫（六个等宽键与下块六列大致对齐）
            HStack(spacing: 6) {
                key("esc", bytes: "\u{1b}")
                ForEach(["1", "2", "3", "4", "5"], id: \.self) { digit in
                    key(digit, bytes: digit)
                }
                repeatKey(systemImage: "delete.left", bytes: "\u{7f}")
                    .frame(width: 52)
            }
            // 下块：左区 3 列扩充键（^C 守左下角）+ 收窄方向簇（tab、/ 夹 ↑）+ 竖跨大⏎
            HStack(spacing: 6) {
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        key("tab", bytes: "\t")
                        key("q", bytes: "q")
                        key("^D", bytes: "\u{04}")
                    }
                    HStack(spacing: 6) {
                        key("^C", tint: Theme.destructive, bytes: "\u{03}")
                        key("^U", bytes: "\u{15}")
                        key("^L", bytes: "\u{0c}")
                    }
                }
                .frame(maxWidth: .infinity)
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        pasteKey
                        repeatKey(systemImage: "arrowtriangle.up.fill", bytes: arrowBytes("A"))
                        key("/", bytes: "/")
                    }
                    HStack(spacing: 6) {
                        repeatKey(systemImage: "arrowtriangle.left.fill", bytes: arrowBytes("D"))
                        repeatKey(systemImage: "arrowtriangle.down.fill", bytes: arrowBytes("B"))
                        repeatKey(systemImage: "arrowtriangle.right.fill", bytes: arrowBytes("C"))
                    }
                }
                .frame(width: 150)
                enterKey
            }
        }
    }

    /// 粘贴：系统剪贴板直发终端（移动端独有高频缺口，替代低频 ⇧tab）；
    /// 与成文层多行发送同理，包 bracketed paste 防换行被当提交
    private var pasteKey: some View {
        Button {
            guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
            press("\u{1b}[200~" + text + "\u{1b}[201~")
        } label: {
            keyCap(label: nil, systemImage: "doc.on.clipboard", tint: Theme.foreground, height: 38)
        }
        .accessibilityLabel("粘贴到终端")
    }

    /// 回车：最高频主键，竖跨两行大键、primary 高亮、钉右下角；
    /// 顶上是同宽的小退格（右缘列 = 小⌫ + 大⏎）
    private var enterKey: some View {
        Button {
            press("\r")
        } label: {
            Image(systemName: "return")
                .font(Theme.Fonts.label.weight(.semibold))
                .foregroundStyle(Theme.primaryForeground)
                .frame(width: 52, height: 82)
                .background(Theme.primary, in: RoundedRectangle(cornerRadius: 8))
        }
        .accessibilityLabel("回车")
    }

    /// 方向键按下时查激活终端的 DECCKM：应用模式发 SS3（ESC O），否则 CSI（ESC [）
    private func arrowBytes(_ letter: String) -> String {
        let application = task.map { TerminalModeRegistry.shared.applicationCursor(taskID: $0.id) } ?? false
        return (application ? "\u{1b}O" : "\u{1b}[") + letter
    }

    private func press(_ bytes: String) {
        guard let sessionID else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        client.sendInput(sessionID: sessionID, bytes)
    }

    private func key(
        _ label: String?,
        systemImage: String? = nil,
        tint: Color = Theme.foreground,
        height: CGFloat = 38,
        bytes: @autoclosure @escaping () -> String
    ) -> some View {
        Button {
            press(bytes())
        } label: {
            keyCap(label: label, systemImage: systemImage, tint: tint, height: height)
        }
    }

    /// 可连发键（方向/退格）：按下即发一次（实体键盘语义），按住 0.35s 后
    /// 以 80ms 间隔连发，松手停。
    private func repeatKey(
        systemImage: String,
        height: CGFloat = 38,
        bytes: @autoclosure @escaping () -> String
    ) -> some View {
        keyCap(label: nil, systemImage: systemImage, tint: Theme.foreground, height: height)
            .contentShape(RoundedRectangle(cornerRadius: 8))
            .onLongPressGesture(minimumDuration: 0.35, maximumDistance: 40) {
                guard let sessionID else { return }
                // 连发期间序列求值一次即可（按住途中 DECCKM 不会切换）；
                // 只捕获 Sendable 值跨进 Timer 闭包
                let payload = bytes()
                let client = self.client
                repeatTimer?.invalidate()
                repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { _ in
                    Task { @MainActor in client.sendInput(sessionID: sessionID, payload) }
                }
            } onPressingChanged: { pressing in
                if pressing {
                    press(bytes())
                } else {
                    repeatTimer?.invalidate()
                    repeatTimer = nil
                }
            }
    }

    private func keyCap(label: String?, systemImage: String?, tint: Color, height: CGFloat) -> some View {
        Group {
            if let systemImage {
                Image(systemName: systemImage)
            } else {
                Text(label ?? "")
            }
        }
        .font(Theme.Fonts.label.weight(.medium))
        .foregroundStyle(tint)
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(Theme.secondarySurface, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// 成文层（plan 053 最终形态）：与系统键盘同层的输入条（fullScreenCover
/// 透明底、无暗色蒙层——底下的终端与控制板完全冻结可见）。
/// 点输入条外任意处取消（草稿保留）；发送 = 文本+回车，长按 = 仅插入。
struct TerminalComposeOverlay: View {
    @Binding var draft: String
    let onSend: (_ newline: Bool) -> Void
    let onDismiss: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .bottom) {
            // 透明点击区：不压暗底层，点空白即收
            Color.clear
                .contentShape(Rectangle())
                .ignoresSafeArea()
                .onTapGesture { onDismiss() }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("输入后发送到终端", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .font(Theme.Fonts.body)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 8)
                Image(systemName: "arrow.up")
                    .font(Theme.Fonts.label.weight(.bold))
                    .foregroundStyle(draft.isEmpty ? Theme.mutedForeground : Theme.primaryForeground)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(draft.isEmpty ? Theme.secondarySurface : Theme.primary))
                    .onTapGesture { onSend(true) }
                    .onLongPressGesture { onSend(false) }
                    .accessibilityLabel("发送")
            }
            .padding(10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.border, lineWidth: 0.5))
            .padding(.horizontal, 8)
            .padding(.bottom, 6)
        }
        .onAppear { focused = true }
    }
}

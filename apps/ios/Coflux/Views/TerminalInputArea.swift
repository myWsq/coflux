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
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

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

    // MARK: - 成文层

    private var composerRow: some View {
        HStack(spacing: 8) {
            TextField("输入后发送到终端", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($composerFocused)
                .font(Theme.Fonts.label)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Theme.input, in: RoundedRectangle(cornerRadius: 10))
            Image(systemName: "arrow.up")
                .font(Theme.Fonts.label.weight(.bold))
                .foregroundStyle(draft.isEmpty ? Theme.mutedForeground : Theme.primaryForeground)
                .frame(width: 34, height: 34)
                .background(Circle().fill(draft.isEmpty ? Theme.secondarySurface : Theme.primary))
                .onTapGesture { send(newline: true) }
                .onLongPressGesture { send(newline: false) }
                .accessibilityLabel("发送")
            Button {
                composerFocused = false
                withAnimation(.smooth(duration: 0.25)) { collapsed = true }
            } label: {
                Image(systemName: "keyboard.chevron.compact.down")
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(width: 34, height: 34)
            }
            .accessibilityLabel("收起输入区")
        }
    }

    /// 发送整段草稿。多行文本包 bracketed paste 标记，避免中间换行被
    /// 行编辑器当作提交（Claude Code/zsh 均开 2004 模式，2026-07-26 实测）。
    private func send(newline: Bool) {
        guard let sessionID, !draft.isEmpty else { return }
        var payload = draft
        if payload.contains("\n") {
            payload = "\u{1b}[200~" + payload + "\u{1b}[201~"
        }
        client.sendInput(sessionID: sessionID, newline ? payload + "\r" : payload)
        draft = ""
        // 保持焦点：连续对话场景不反复唤键盘
    }

    // MARK: - 控制层

    private var padRows: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                ForEach(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], id: \.self) { digit in
                    key(digit, bytes: digit)
                }
            }
            // 左 = 控制键两行；右 = 实体键盘式倒 T 方向簇（↑ 居中，← ↓ → 在下）
            HStack(spacing: 6) {
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        key("esc", bytes: "\u{1b}")
                        key("/", bytes: "/")
                        key("tab", bytes: "\t")
                        key("⇧tab", bytes: "\u{1b}[Z")
                    }
                    HStack(spacing: 6) {
                        key("^C", tint: Theme.destructive, bytes: "\u{03}")
                        key(nil, systemImage: "delete.left", bytes: "\u{7f}")
                        key(nil, systemImage: "return", bytes: "\r")
                    }
                }
                .frame(maxWidth: .infinity)
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        keyPlaceholder
                        key(nil, systemImage: "arrowtriangle.up.fill", bytes: arrowBytes("A"))
                        keyPlaceholder
                    }
                    HStack(spacing: 6) {
                        key(nil, systemImage: "arrowtriangle.left.fill", bytes: arrowBytes("D"))
                        key(nil, systemImage: "arrowtriangle.down.fill", bytes: arrowBytes("B"))
                        key(nil, systemImage: "arrowtriangle.right.fill", bytes: arrowBytes("C"))
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var keyPlaceholder: some View {
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: 38)
    }

    /// 方向键按下时查激活终端的 DECCKM：应用模式发 SS3（ESC O），否则 CSI（ESC [）
    private func arrowBytes(_ letter: String) -> String {
        let application = task.map { TerminalModeRegistry.shared.applicationCursor(taskID: $0.id) } ?? false
        return (application ? "\u{1b}O" : "\u{1b}[") + letter
    }

    private func key(
        _ label: String?,
        systemImage: String? = nil,
        tint: Color = Theme.foreground,
        bytes: @autoclosure @escaping () -> String
    ) -> some View {
        Button {
            guard let sessionID else { return }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            client.sendInput(sessionID: sessionID, bytes())
        } label: {
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
            .frame(height: 38)
            .background(Theme.secondarySurface, in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

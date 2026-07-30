import SwiftUI
import UIKit

/// 对讲态浮层（plan 064；成稿态见 plan 066）：占位条长按后铺满屏幕。三个 UI
/// 相位——进行中（实时转写 + 取消/完成提示）、成稿（松手后留驻，草稿定格
/// 居中，发送/点文字编辑/弃掉）、错误留驻（权限被拒 / 无字可看的失败，点
/// 任意处关闭）。不走 TerminalComposeOverlay 那套 fullScreenCover + 320ms
/// 拆除时序——那是为了与系统键盘共存；对讲全程不出现键盘，纯 .overlay() 已
/// 经够用，不必照搬。
struct DictationOverlay: View {
    @ObservedObject var session: DictationSession
    let pendingCancel: Bool
    /// 松手已触发（WorkspaceDetailView.endDictation 同步置位，不等
    /// session.finish() 落定）：成稿态 UI 立即切入，草稿先显示当前已转写
    /// 文本，终稿到达后 session.displayText 原位更新（@Published 自动重渲染）。
    let released: Bool
    /// session.finish() 尚未返回：发送按钮禁用期，防终稿落定前误触发送半截话。
    let finalizing: Bool
    /// 弃掉 / 权限被拒 / 无字可看的失败态点任意处关闭——统一动作：拆浮层。
    let onDismiss: () -> Void
    /// 发送草稿：调用方负责把 session.displayText 走 sendDraft 等价路径落终端。
    let onSend: () -> Void
    /// 点草稿文字：调用方负责把文字落 draft 并打开成文层编辑。
    let onEdit: () -> Void

    /// 失败态且已有转写文字（如豆包中途断连）：不当普通错误留驻处理，并入
    /// 成稿态——文字可发送/编辑，只多一条错误标注（decided 2026-07-30）。
    private var failedMessage: String? {
        if case .failed(let message) = session.phase { return message }
        return nil
    }

    private var failedWithText: Bool {
        failedMessage != nil && !session.displayText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isDraftReview: Bool { released || failedWithText }

    /// 权限被拒 / 无字可看的失败态才留背景点任意处关闭（plan 064 语义不变）；
    /// 成稿态改用显式按钮，背景误触不该丢弃已转写文字。
    private var isDismissableByBackgroundTap: Bool {
        switch session.phase {
        case .permissionDenied: return true
        case .failed: return !failedWithText
        default: return false
        }
    }

    private var sendDisabled: Bool { finalizing && !failedWithText }

    var body: some View {
        ZStack {
            VariableBlurView(intensity: 0.7)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { if isDismissableByBackgroundTap { onDismiss() } }
            VStack(spacing: 20) {
                Spacer()
                engineBadge
                textArea
                if let failedMessage, isDraftReview {
                    Text(failedMessage)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.destructive)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                Spacer()
                footer
                    .padding(.bottom, 48)
            }
        }
        .transition(.opacity)
    }

    /// 成稿态下文字可点（进成文层编辑）；进行中态维持纯展示——不额外接管
    /// 触摸（手指还在占位条上跟着 DragGesture 走）。
    @ViewBuilder
    private var textArea: some View {
        let text = session.displayText.isEmpty ? "聆听中…" : session.displayText
        let styledText = Text(text)
            .font(Theme.Fonts.subtitle)
            .foregroundStyle(session.isVolatile ? Theme.mutedForeground : Theme.foreground)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
        if isDraftReview {
            Button(action: onEdit) { styledText }
                .buttonStyle(.plain)
        } else {
            styledText
        }
    }

    @ViewBuilder
    private var engineBadge: some View {
        switch session.phase {
        case .active(.doubao):
            badge("云端识别", tint: Theme.success)
        case .active(.apple):
            badge("本机识别", tint: Theme.primary)
        case .connecting:
            badge("连接中…", tint: Theme.mutedForeground)
        case .modelDownloading:
            badge("准备本机语音模型…", tint: Theme.mutedForeground)
        case .permissionDenied, .failed:
            EmptyView()
        }
    }

    private func badge(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(Theme.Fonts.meta.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(tint.opacity(0.15)))
    }

    @ViewBuilder
    private var footer: some View {
        if isDraftReview {
            draftFooter
        } else {
            switch session.phase {
            case .modelDownloading(let progress):
                VStack(spacing: 8) {
                    ProgressView(value: progress)
                        .frame(width: 160)
                    Text("首次使用本机语音需下载模型")
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.mutedForeground)
                }
            case .permissionDenied:
                VStack(spacing: 8) {
                    Text("需要麦克风与语音识别权限")
                        .font(Theme.Fonts.label)
                        .foregroundStyle(Theme.foreground)
                    Button("前往设置") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                    .font(Theme.Fonts.label.weight(.semibold))
                    .foregroundStyle(Theme.primary)
                }
            case .failed(let message):
                Text(message)
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.destructive)
            default:
                Text(pendingCancel ? "松开取消" : "上滑取消・松开完成")
                    .font(Theme.Fonts.label.weight(.medium))
                    .foregroundStyle(pendingCancel ? Theme.destructive : Theme.mutedForeground)
            }
        }
    }

    /// 成稿态操作：弃掉（次操作，拆浮层丢弃）／发送（主操作，落终端，终稿
    /// 落定前禁用防半截话误发）。
    private var draftFooter: some View {
        HStack(spacing: 20) {
            Button("弃掉", role: .destructive) { onDismiss() }
                .font(Theme.Fonts.label.weight(.medium))
                .foregroundStyle(Theme.destructive)
            Button("发送") { onSend() }
                .disabled(sendDisabled)
                .font(Theme.Fonts.label.weight(.semibold))
                .foregroundStyle(Theme.primaryForeground)
                .padding(.horizontal, 24)
                .padding(.vertical, 10)
                .background(Capsule().fill(Theme.primary))
                .opacity(sendDisabled ? 0.5 : 1)
        }
    }
}

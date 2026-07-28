import SwiftUI
import UIKit

/// 对讲态浮层（plan 064）：占位条长按后铺满屏幕，展示实时转写与取消/完成提示。
/// 不走 TerminalComposeOverlay 那套 fullScreenCover + 320ms 拆除时序——那是为了
/// 与系统键盘共存；对讲全程不出现键盘，纯 .overlay() 已经够用，不必照搬。
struct DictationOverlay: View {
    @ObservedObject var session: DictationSession
    let pendingCancel: Bool
    /// 权限被拒/失败态下点任意处关闭——用户手指已经离开占位条（endDictation
    /// 已触发），这两态浮层刻意留驻等一次主动点击，否则「前往设置」按钮
    /// 永远点不到（松手瞬间浮层就随手势收尾一起拆了）
    let onDismiss: () -> Void

    private var isDismissable: Bool {
        switch session.phase {
        case .permissionDenied, .failed: return true
        default: return false
        }
    }

    var body: some View {
        ZStack {
            VariableBlurView(intensity: 0.7)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { if isDismissable { onDismiss() } }
            VStack(spacing: 20) {
                Spacer()
                engineBadge
                Text(session.displayText.isEmpty ? "聆听中…" : session.displayText)
                    .font(Theme.Fonts.subtitle)
                    .foregroundStyle(session.isVolatile ? Theme.mutedForeground : Theme.foreground)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Spacer()
                footer
                    .padding(.bottom, 48)
            }
        }
        .transition(.opacity)
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

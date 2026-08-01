import SwiftUI
import UIKit

/// 对讲蒙层底部的滑入扇区（plan 067）：圆心钉在蒙层的两个底角、半径固定，
/// 手指全局坐标落进哪个圆就是哪个扇区。绘制与命中判定共用这一套几何——
/// 判定在 WorkspaceDetailView 做（那里拿得到蒙层在全局坐标系里的框），
/// 绘制在 DictationOverlay 对齐自身底角，改半径两边同时变。
enum DictationZone: Equatable {
    /// 扇区外：松手 = 转写文字落终端输入行（不回车）
    case none
    case cancel
    case edit

    /// 半径 130pt：占位条中心距蒙层底边约 160pt，半径必须小于它——否则手指
    /// 按在占位条最左/最右边缘、一动不动时就已落在扇区里（静止误判取消）。
    static let radius: CGFloat = 130

    /// bounds = 蒙层在全局坐标系里的框（扇区圆心 = 它的两个底角）
    static func hit(_ point: CGPoint, in bounds: CGRect) -> DictationZone {
        guard bounds.width > 0, bounds.height > 0 else { return .none }
        if hypot(point.x - bounds.minX, point.y - bounds.maxY) <= radius { return .cancel }
        if hypot(point.x - bounds.maxX, point.y - bounds.maxY) <= radius { return .edit }
        return .none
    }
}

/// 对讲态浮层（plan 064；plan 067 的微信式操作台推翻 066 的成稿确认态）：
/// 占位条长按后铺满屏幕，两个 UI 相位——
/// - 进行中：转写气泡居中 + 底部左右扇区（左取消 / 右编辑），提示语随命中
///   区切换；松手后 finalizing 短暂留驻等终稿落定，随后由宿主分发并拆层；
/// - 错误/权限留驻：权限被拒 / 无字可看的失败，点任意处关闭（064 语义）。
/// 不走 TerminalComposeOverlay 那套 fullScreenCover + 320ms 拆除时序——那是
/// 为了与系统键盘共存；对讲全程不出现键盘，纯 .overlay() 已经够用。
struct DictationOverlay: View {
    @ObservedObject var session: DictationSession
    /// 手指当前命中的扇区：驱动扇区高亮与提示语（松手分发用同一个值，
    /// 用户看到高亮的那个扇区就是会执行的那个）
    let zone: DictationZone
    /// 松手后等 session.finish() 落定的窗口：扇区隐去，此期间不接收交互。
    let finalizing: Bool
    /// 权限被拒 / 无字可看的失败态点任意处关闭——唯一动作：拆浮层。
    let onDismiss: () -> Void

    /// 引导/错误留驻态：手指已离屏，扇区无意义，背景可点关闭。
    private var resting: Bool {
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
                .onTapGesture { if resting { onDismiss() } }
            VStack(spacing: 20) {
                Spacer()
                engineBadge
                bubble
                Spacer()
                footer
                    .padding(.bottom, 48)
            }
            if !resting, !finalizing {
                sectors
            }
        }
        // 手指压在扇区上会挡住高亮，进出扇区给一记轻触觉（系统原生，
        // 触发值就是命中区本身）
        .sensoryFeedback(.selection, trigger: zone)
        .transition(.opacity)
    }

    /// 转写气泡：居中定格，纯展示——进行中手指还按在占位条上跟着
    /// DragGesture 走，蒙层不接管触摸。
    private var bubble: some View {
        Text(session.displayText.isEmpty ? "聆听中…" : session.displayText)
            .font(Theme.Fonts.subtitle)
            .foregroundStyle(session.isVolatile ? Theme.mutedForeground : Theme.foreground)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .glassEffect(.regular, in: .rect(cornerRadius: 20))
            .padding(.horizontal, 32)
    }

    // MARK: - 底部扇区（纯视觉目标 + 命中反馈，不接收触摸）

    private var sectors: some View {
        Color.clear
            .overlay(alignment: .bottomLeading) {
                sector(.cancel, icon: "xmark", label: "取消", tint: Theme.destructive)
                    .offset(x: -DictationZone.radius, y: DictationZone.radius)
            }
            .overlay(alignment: .bottomTrailing) {
                sector(.edit, icon: "pencil", label: "编辑", tint: Theme.primary)
                    .offset(x: DictationZone.radius, y: DictationZone.radius)
            }
            .allowsHitTesting(false)
    }

    /// 整圆按半径钉在屏角上，只有朝屏内的那一瓣可见（屏幕自然裁掉另一半，
    /// 不额外 clip——clip 会连命中时的隆起一起削掉）。
    private func sector(_ target: DictationZone, icon: String, label: String, tint: Color) -> some View {
        let active = zone == target
        let inset = DictationZone.radius * 0.45
        return ZStack {
            Circle().fill(tint.opacity(active ? 0.28 : 0))
            VStack(spacing: 6) {
                Image(systemName: icon)
                    .font(Theme.Fonts.body.weight(.semibold))
                Text(label)
                    .font(Theme.Fonts.meta.weight(.medium))
            }
            .foregroundStyle(active ? tint : Theme.mutedForeground)
            .offset(x: target == .cancel ? inset : -inset, y: -inset)
        }
        .frame(width: DictationZone.radius * 2, height: DictationZone.radius * 2)
        .glassEffect(.regular, in: .circle)
        .scaleEffect(active ? 1.08 : 1)
        .animation(.smooth(duration: 0.15), value: active)
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
            // 失败但已转写出文字时，宿主照样把文字落输入行，这条标注只留一拍
            Text(message)
                .font(Theme.Fonts.label)
                .foregroundStyle(Theme.destructive)
        default:
            Text(hint)
                .font(Theme.Fonts.label.weight(.medium))
                .foregroundStyle(zone == .cancel ? Theme.destructive : Theme.mutedForeground)
        }
    }

    private var hint: String {
        if finalizing { return "整理中…" }
        switch zone {
        case .cancel: return "松手取消"
        case .edit: return "松手编辑"
        case .none: return "松手落到输入行"
        }
    }
}

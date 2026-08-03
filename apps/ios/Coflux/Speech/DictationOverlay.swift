import SwiftUI
import UIKit

/// 对讲操作台的三件套（plan 070 补全 068 留白的"要不要画弧"）：屏幕底部全宽
/// 的半圆底座（纯视觉锚点，微信"按住说话"的观感）+ 贴底座弧肩的两颗圆按钮
/// （左取消 / 右发送，不再贴屏幕边缘）。松手语义完全不变——原地松手仍进
/// 068 的确认态，底座只是把既有的 `.none` 区画出来，不参与命中。
/// 绘制（蒙层对齐自身底边）与命中判定（宿主拿蒙层的全局框）共用这组常量，
/// 改一处两边同时变。
enum DictationZone: Equatable {
    /// 没命中按钮：松手 = 进确认态（plan 068 推翻 067 的松手直落终端）
    case none
    case cancel
    case send

    /// 圆按钮直径（微信参考量级 56-64pt，取中值；plan 070 胶囊→圆）
    static let diameter: CGFloat = 60
    /// 圆心距蒙层底边的高度。占位条（高 38）中心在底边上方约 159pt、顶边约
    /// 178pt；命中区下沿 = lift - diameter/2 - tolerance = 200pt，留 22pt
    /// 余量——手指静止按在占位条上（含最左/最右边缘）必判 none。
    static let lift: CGFloat = 252
    /// 圆心距蒙层左右边的内缩：绘制的圆钉在这个位置，贴底座弧肩，比 068
    /// 贴屏幕边缘（旧胶囊外沿仅 24pt）更内移一截。命中区不受这次内移影响
    /// ——见 box()，外侧照样吃到蒙层边缘。
    static let edgeInset: CGFloat = 88
    /// 命中容差：内侧（靠中间那侧）外扩的量；外侧直接吃到蒙层边缘，见 box()
    static let tolerance: CGFloat = 22
    /// 绘制用：圆底边贴容器底时，要抬多少让圆心落在 lift 上
    static var drawLift: CGFloat { lift - diameter / 2 }

    /// 底座拱顶距蒙层底边的高度——纯视觉，不进 hit()。微信参考是舒缓的扁弧
    /// 带、不是圆丘：拱顶矮 + 宽度远超屏宽（见 baseWidthMultiplier），屏幕
    /// 边缘处弧仍有可观高度，不会像"椭圆宽度=屏宽"那样在边缘正好落到
    /// 0——首轮真机反馈的"灰色大饼"就是那个诱因。
    static let baseApex: CGFloat = 140
    /// 底座椭圆宽度相对蒙层宽度的倍数：椭圆用 scaleEffect(x:) 水平拉伸做出
    /// 超宽扁弧，两侧沉出屏外只露中段——微信参考量级 1.5-1.8 倍，取中值。
    static let baseWidthMultiplier: CGFloat = 1.7

    /// bounds = 蒙层的框。判定传全局框（手势坐标空间也是 .global），
    /// 绘制时同一组常量对齐蒙层自身底边——两边同源。
    static func hit(_ point: CGPoint, in bounds: CGRect) -> DictationZone {
        guard bounds.width > 0, bounds.height > 0 else { return .none }
        for zone in [DictationZone.cancel, .send] where box(zone, in: bounds).contains(point) {
            return zone
        }
        return .none
    }

    /// 命中框故意跟绘制的圆不对称：内侧（靠中间）只外扩 tolerance，外侧
    /// （贴屏边那侧）直接吃到蒙层边缘。圆内移到 edgeInset 后，若命中区也
    /// 跟着整体内移，"按住往屏幕边缘滑"（068 时代的肌肉记忆）会在圆外侧
    /// 落空、判成 .none——真机验收出的坑，圆的绘制位置不用跟着改，只把
    /// 命中的外侧边界钉回屏边。上下沿（含 200pt 硬约束）不受影响。
    private static func box(_ zone: DictationZone, in bounds: CGRect) -> CGRect {
        let centerX = zone == .cancel ? bounds.minX + edgeInset : bounds.maxX - edgeInset
        let y = bounds.maxY - lift - diameter / 2 - tolerance
        let height = diameter + tolerance * 2
        if zone == .cancel {
            let innerEdge = centerX + diameter / 2 + tolerance
            return CGRect(x: bounds.minX, y: y, width: innerEdge - bounds.minX, height: height)
        } else {
            let innerEdge = centerX - diameter / 2 - tolerance
            return CGRect(x: innerEdge, y: y, width: bounds.maxX - innerEdge, height: height)
        }
    }
}

/// 蒙层交互相位（plan 068）
enum DictationStage: Equatable {
    /// 手指还按在占位条上：按钮是轻量角标，蒙层一概不拦触摸
    case listening
    /// 松手后等 session.finish() 落定的窗口：不出按钮，杜绝终稿到手前的误触
    case finalizing
    /// 终稿落定、手指已离屏：有字 = 确认态（实体按钮 + 可点草稿），
    /// 无字 = 权限被拒 / 失败的留驻示错态（点任意处关闭，064 语义）
    case settled
}

/// 对讲态浮层（plan 064；plan 068 恢复 066 的确认关卡并换掉 067 的扇区几何；
/// plan 070 把凭空悬浮的两颗胶囊换成微信式三件套）：占位条长按后铺满屏幕——
/// - 进行中：转写气泡居中 + 底部半圆底座（原地=底座高亮、提示语悬拱顶上方）
///   + 贴底座弧肩的两颗圆角标（左取消 / 右发送），滑进哪颗哪颗变大高亮，
///   松手即执行该操作；不接触摸（手指还在占位条上跟 DragGesture 走）；
/// - 确认态：原地松手且有字，草稿定格居中且可点（进成文层编辑），两颗圆
///   原位变实体按钮可点、底座保留作锚——转写文字落终端前必经这一关
///   （coflux 是纯转文字，识别错误没有兜底，2026-08-01 用户复议推翻 067
///   的松手直发；本次三件套换皮不换这条语义）；
/// - 错误/权限留驻：权限被拒 / 无字可看的失败，点任意处关闭（064 语义）。
/// 不走 TerminalComposeOverlay 那套 fullScreenCover + 320ms 拆除时序——那是
/// 为了与系统键盘共存；对讲全程不出现键盘，纯 .overlay() 已经够用。
struct DictationOverlay: View {
    @ObservedObject var session: DictationSession
    /// 手指当前命中的按钮：驱动圆的高亮与提示语（松手分发用同一个值，
    /// 用户看到高亮的那个就是会执行的那个）
    let zone: DictationZone
    let stage: DictationStage
    /// 确认态点「取消」/ 留驻示错点任意处：同一个动作——弃稿拆层。
    let onDiscard: () -> Void
    /// 确认态点「发送」：调用方把终稿落终端输入行（不回车）。
    let onSend: () -> Void
    /// 确认态点草稿文字：调用方把文字落 draft 并打开成文层。
    let onEdit: () -> Void

    private var text: String {
        session.displayText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 确认态：手指已离屏、终稿落定且有字可确认。失败但已转写出文字
    /// （如豆包中途断连）并入此态——文字照样可发送/编辑，只多一条错误标注。
    private var confirming: Bool { stage == .settled && !text.isEmpty }

    /// 留驻示错/引导：手指已离屏但没字可确认，背景可点关闭。
    private var resting: Bool { stage == .settled && text.isEmpty }

    private var failedMessage: String? {
        if case .failed(let message) = session.phase { return message }
        return nil
    }

    var body: some View {
        ZStack {
            VariableBlurView(intensity: 0.7)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                // 确认态背景不吞稿：弃稿只走显式的「取消」按钮
                .onTapGesture { if resting { onDiscard() } }
            VStack(spacing: 20) {
                Spacer()
                engineBadge
                bubble
                if confirming, let failedMessage {
                    Text(failedMessage)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.destructive)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                Spacer()
                footer
                    // 底座出现时（!resting）footer 得让到拱顶上方；resting
                    // 没有底座，沿用 068 的 48pt 位置不变（权限/失败提示不用跟着挪）
                    .padding(.bottom, resting ? 48 : DictationZone.baseApex + 24)
            }
            if !resting {
                // 底座在 finalizing 也留着（手指刚离开，画面别抽走），
                // 只有按钮在 finalizing 期间不出（终稿没到手，不给误触）
                stand
                if stage != .finalizing {
                    buttons
                }
            }
        }
        // hit-testing 两态（plan 066 老坑）：进行中蒙层一概不拦触摸——手指还
        // 按在占位条上，DragGesture 在跟踪它；确认态必须收按钮与草稿的点击。
        // finalizing 期间也关着：终稿没到手，没有可点的东西。底座/标签等新
        // 视图不单独加手势或 allowsHitTesting，一概走这一条（landmine）。
        .allowsHitTesting(stage == .settled)
        // 手指压在按钮上会挡住高亮，进出给一记轻触觉（触发值就是命中区本身）
        .sensoryFeedback(.selection, trigger: zone)
        .transition(.opacity)
    }

    /// 转写气泡：居中定格。进行中纯展示（蒙层不接管触摸）；确认态可点，
    /// 点进成文层编辑（plan 066 的编辑通道，067 删掉，068 恢复）。
    @ViewBuilder
    private var bubble: some View {
        let content = Text(session.displayText.isEmpty ? "聆听中…" : session.displayText)
            .font(Theme.Fonts.subtitle)
            .foregroundStyle(session.isVolatile ? Theme.mutedForeground : Theme.foreground)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .glassEffect(.regular, in: .rect(cornerRadius: 20))
            .padding(.horizontal, 32)
        if confirming {
            Button(action: onEdit) { content }
                .buttonStyle(.plain)
        } else {
            content
        }
    }

    // MARK: - 半圆底座（纯视觉锚点，不参与命中）

    /// 屏幕底部的舒缓扁弧带——手指原地（zone == .none）时整体变浅色，
    /// 提示语悬在拱顶上方（见 footer 的 padding）。confirming 态不高亮
    /// （手指已离屏，"原地"语义消失），但保留原样作视觉锚，不淡出。
    /// 椭圆本身按容器宽度画，再用 scaleEffect 水平拉伸出两侧沉出屏外的
    /// 超宽弧——scaleEffect 只影响渲染不影响布局尺寸，外层的 offset/frame
    /// 定位数学不用跟着变。真机首轮反馈"灰色大饼"：椭圆宽度=屏宽时边缘
    /// 弧高正好是 0、加实底 fill + 描边，看着像扣在底部的圆丘；这轮换成
    /// 材质 + 无描边 + 更宽更矮的椭圆。
    private var stand: some View {
        let active = stage == .listening && zone == .none
        return Color.clear
            .overlay(alignment: .bottom) {
                ZStack(alignment: .top) {
                    ZStack {
                        Ellipse().fill(.ultraThinMaterial)
                        if active {
                            Ellipse().fill(Theme.primary.opacity(0.18))
                        }
                    }
                    .scaleEffect(x: DictationZone.baseWidthMultiplier, y: 1)
                    Image(systemName: "waveform")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(active ? Theme.primary : Theme.mutedForeground)
                        .padding(.top, 24)
                }
                .frame(height: DictationZone.baseApex * 2)
                .offset(y: DictationZone.baseApex)
            }
            .animation(.smooth(duration: 0.15), value: active)
    }

    // MARK: - 底部两颗圆按钮（进行中 = 角标，确认态 = 实体按钮）

    private var buttons: some View {
        Color.clear
            .overlay(alignment: .bottomLeading) {
                orb(.cancel, icon: "xmark", label: "取消", tint: Theme.destructive)
                    .padding(.leading, DictationZone.edgeInset - DictationZone.diameter / 2)
                    .offset(y: -DictationZone.drawLift)
            }
            .overlay(alignment: .bottomTrailing) {
                orb(.send, icon: "arrow.up", label: "发送", tint: Theme.primary)
                    .padding(.trailing, DictationZone.edgeInset - DictationZone.diameter / 2)
                    .offset(y: -DictationZone.drawLift)
            }
    }

    /// 一颗圆按钮。进行中（角标）态标签用 overlay 悬在圆外——纯展示，不进
    /// 命中区，反正整层 allowsHitTesting 在这个相位就是关的。确认态标签
    /// 并进 Button 的 label（VStack 标签+圆整块都能点）——首轮真机反馈标签
    /// 用 overlay 悬在 Button 外面点不到字，这轮把它纳入可点区，不是给
    /// 标签单独加手势（那会绕开整层 allowsHitTesting 这条 landmine）。
    /// VStack 的标签在圆上方、圆在下：整块的底边仍是圆的底边，drawLift 的
    /// 定位数学（按圆本身算）不受标签高度影响。
    @ViewBuilder
    private func orb(_ target: DictationZone, icon: String, label: String, tint: Color) -> some View {
        // 命中高亮只在手指还在屏上时有意义；确认态手指已离屏，语义消失
        let active = stage == .listening && zone == target
        let glyph = Image(systemName: icon)
            .font(.system(size: 22, weight: .semibold))
            .frame(width: DictationZone.diameter, height: DictationZone.diameter)
        let labelText = Text(label)
            .font(Theme.Fonts.meta.weight(.semibold))
            .fixedSize()

        if confirming {
            // 实体按钮：发送是主操作（反色实底），取消次操作（玻璃）；标签
            // 在 Button 的 label 里，点字跟点圆一样能触发
            Button(action: target == .cancel ? onDiscard : onSend) {
                VStack(spacing: 6) {
                    labelText.foregroundStyle(tint)
                    if target == .cancel {
                        glyph
                            .foregroundStyle(Theme.destructive)
                            .glassEffect(.regular.interactive(), in: Circle())
                    } else {
                        glyph
                            .foregroundStyle(Theme.primaryForeground)
                            .background(Circle().fill(Theme.primary))
                    }
                }
            }
            .buttonStyle(.plain)
        } else {
            // 角标：低对比、无实体按钮感（手指还在屏上，这不是可点控件），
            // 滑进去才亮起来；标签纯展示，悬在圆外不进圆的几何
            glyph
                .foregroundStyle(active ? tint : Theme.mutedForeground)
                .background(Circle().fill(tint.opacity(active ? 0.22 : 0.06)))
                .overlay {
                    Circle().strokeBorder(active ? tint.opacity(0.65) : Theme.border, lineWidth: 1)
                }
                .scaleEffect(active ? 1.12 : 1)
                .animation(.smooth(duration: 0.15), value: active)
                .overlay(alignment: .top) {
                    labelText
                        .foregroundStyle(active ? tint : Theme.mutedForeground)
                        .offset(y: -24)
                }
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
        if confirming {
            Text("点文字可编辑")
                .font(Theme.Fonts.meta)
                .foregroundStyle(Theme.subtleForeground)
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
                // 走到这里 = 失败且无字可看（有字的并入确认态，标注在气泡下）
                Text(message)
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.destructive)
            default:
                Text(hint)
                    .font(Theme.Fonts.label.weight(.medium))
                    .foregroundStyle(zone == .cancel ? Theme.destructive : Theme.mutedForeground)
            }
        }
    }

    private var hint: String {
        if stage == .finalizing { return "整理中…" }
        switch zone {
        case .cancel: return "松开取消"
        case .send: return "松开发送"
        case .none: return "松开确认"
        }
    }
}

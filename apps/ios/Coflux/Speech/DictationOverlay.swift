import SwiftUI
import UIKit

/// 对讲操作台的命中区（plan 068/070 → Duo redesign, plan D14）：左取消 / 右发送两颗圆按钮。
/// 松手语义不变——原地松手进 068 的确认态，滑进哪颗松手就执行哪颗。
///
/// The buttons used to be placed with fixed points tuned for one phone. On the Duo the overlay's
/// container ranges from a ≈368 pt wide Split View half (≈440 pt minus the rail) to the 626 pt
/// wide tall layout, and from ≈370 pt to ≈820 pt high, so every distance is now derived from the
/// container's size (`Geometry`). Drawing (the overlay aligns to its own frame) and hit testing
/// (the host passes the overlay's global frame) use the same geometry, so the hit zone and the
/// drawn buttons coincide at every window size.
enum DictationZone: Equatable {
    /// 没命中按钮：松手 = 进确认态（plan 068 推翻 067 的松手直落终端）
    case none
    case cancel
    case send

    /// Button geometry for an overlay of `size`. The ratios reproduce the plan 070 constants on
    /// the ≈390×700 pt content area they were tuned on (diameter 60, edge inset 88, lift 252,
    /// tolerance 22, apex 140), clamped so the buttons stay finger-sized and always clear the
    /// composer the finger rests on at the bottom of the dock.
    struct Geometry {
        let size: CGSize

        /// 圆按钮直径（微信参考量级 56-64pt）
        var diameter: CGFloat { min(64, max(52, size.width * 0.155)) }
        /// 圆心距左右边的内缩
        var edgeInset: CGFloat { max(diameter / 2 + 16, size.width * 0.22) }
        /// 圆心距底边的高度。命中区下沿 = lift - diameter/2 - tolerance，必须高于 composer
        /// （底边上方约 64 pt）留出余量——手指静止按在 composer 上必判 none。
        var lift: CGFloat { min(260, max(150, size.height * 0.36)) }
        /// 命中容差：内侧（靠中间那侧）外扩的量；外侧直接吃到蒙层边缘，见 box()
        var tolerance: CGFloat { diameter * 0.36 }
        /// 绘制用：圆底边贴容器底时，要抬多少让圆心落在 lift 上
        var drawLift: CGFloat { lift - diameter / 2 }
        /// 底座拱顶距底边的高度——纯视觉，不进命中判定
        var baseApex: CGFloat { lift * 0.5 }
        /// 底座椭圆宽度相对蒙层宽度的倍数：两侧沉出屏外只露中段的舒缓扁弧
        var baseWidthMultiplier: CGFloat { 1.7 }

        /// 命中框故意跟绘制的圆不对称：内侧只外扩 tolerance，外侧（贴屏边那侧）直接吃到蒙层边缘
        /// ——"按住往屏幕边缘滑"的肌肉记忆不能落空（真机验收出的坑）。
        func box(_ zone: DictationZone, in bounds: CGRect) -> CGRect {
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

    /// bounds = 蒙层的框。判定传全局框（手势坐标空间也是 .global），绘制时同一组几何对齐
    /// 蒙层自身底边——两边同源。
    static func hit(_ point: CGPoint, in bounds: CGRect) -> DictationZone {
        guard bounds.width > 0, bounds.height > 0 else { return .none }
        let geometry = Geometry(size: bounds.size)
        for zone in [DictationZone.cancel, .send] where geometry.box(zone, in: bounds).contains(point) {
            return zone
        }
        return .none
    }
}

/// 蒙层交互相位（plan 068）
enum DictationStage: Equatable {
    /// 手指还按在 composer 上：按钮是轻量角标，蒙层一概不拦触摸
    case listening
    /// 松手后等 session.finish() 落定的窗口：不出按钮，杜绝终稿到手前的误触
    case finalizing
    /// 终稿落定、手指已离屏：有字 = 确认态（实体按钮 + 可点草稿），
    /// 无字 = 权限被拒 / 失败的留驻示错态（点任意处关闭，064 语义）
    case settled
}

/// 对讲态浮层（plan 064/068/070 → Duo redesign, mockup O5）：composer 长按后铺满终端页——
/// - 进行中：转写气泡 + 波形 + 底部扁弧底座（原地 = 底座高亮、提示语在拱内）+ 两颗圆角标
///   （左取消 / 右发送），滑进哪颗哪颗变大高亮，松手即执行；不接触摸（手指还在 composer 上跟
///   DragGesture 走）；
/// - 确认态：原地松手且有字，气泡定格且可点（进成文层编辑），取消 / 编辑 / 发送三颗实体按钮，
///   底座保留作锚——转写文字落终端前必经这一关（coflux 是纯转文字，识别错误没有兜底）；
/// - 错误/权限留驻：权限被拒 / 未配置 Key / 无字可看的失败，点任意处关闭（064 语义）。
struct DictationOverlay: View {
    @ObservedObject var session: DictationSession
    /// 手指当前命中的按钮：驱动圆的高亮与提示语（松手分发用同一个值）
    let zone: DictationZone
    let stage: DictationStage
    /// 确认态点「取消」/ 留驻示错点任意处：同一个动作——弃稿拆层。
    let onDiscard: () -> Void
    /// 确认态点「发送」：调用方把终稿落终端（文字 + 回车）。
    let onSend: () -> Void
    /// 确认态点草稿文字或「编辑」：调用方把文字落 draft 并打开成文层。
    let onEdit: () -> Void
    /// 未配置 Key 时的「去设置」：调用方关掉浮层并打开语音识别设置。
    let onOpenSettings: () -> Void

    private var text: String {
        session.displayText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 确认态：手指已离屏、终稿落定且有字可确认。失败但已转写出文字并入此态（多一条错误标注）。
    private var confirming: Bool { stage == .settled && !text.isEmpty }

    /// 留驻示错/引导：手指已离屏但没字可确认，背景可点关闭。
    private var resting: Bool { stage == .settled && text.isEmpty }

    private var failedMessage: String? {
        if case .failed(let message) = session.phase { return message }
        return nil
    }

    var body: some View {
        GeometryReader { proxy in
            let geometry = DictationZone.Geometry(size: proxy.size)
            ZStack {
                scrim
                VStack(spacing: 18) {
                    Spacer(minLength: 12)
                    engineBadge
                    bubble
                    if confirming, let failedMessage {
                        Text(failedMessage)
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.destructive)
                            .multilineTextAlignment(.center)
                    }
                    if !resting {
                        Waveform(active: stage == .listening)
                    }
                    Spacer(minLength: 12)
                    if resting {
                        restingFooter
                            .padding(.bottom, 48)
                    }
                }
                .padding(.horizontal, 16)
                // Content stays above the buttons and their labels.
                .padding(.bottom, resting ? 0 : geometry.lift + geometry.diameter / 2 + 34)
                if !resting {
                    // 底座在 finalizing 也留着（手指刚离开，画面别抽走），只有按钮在 finalizing
                    // 期间不出（终稿没到手，不给误触）
                    stand(geometry)
                    if stage != .finalizing {
                        buttons(geometry)
                    }
                }
            }
        }
        // hit-testing 两态（plan 066 老坑）：进行中蒙层一概不拦触摸——手指还按在 composer 上，
        // DragGesture 在跟踪它；确认态必须收按钮与草稿的点击。finalizing 期间也关着。新视图不单独
        // 加手势或 allowsHitTesting，一概走这一条（landmine）。
        .allowsHitTesting(stage == .settled)
        // 手指压在按钮上会挡住高亮，进出给一记轻触觉（触发值就是命中区本身）
        .sensoryFeedback(.selection, trigger: zone)
        .transition(.opacity)
    }

    private var scrim: some View {
        ZStack {
            VariableBlurView(intensity: 0.45)
            Theme.terminal.opacity(0.66)
        }
        .ignoresSafeArea()
        .contentShape(Rectangle())
        // 确认态背景不吞稿：弃稿只走显式的「取消」按钮
        .onTapGesture { if resting { onDiscard() } }
    }

    /// 转写气泡：进行中纯展示；确认态可点，点进成文层编辑。
    @ViewBuilder
    private var bubble: some View {
        let content = VStack(alignment: .leading, spacing: 8) {
            Text(confirming ? "识别结果 · 点按文字可编辑" : "正在聆听")
                .font(Theme.Fonts.meta)
                .foregroundStyle(Theme.mutedForeground)
            Text(session.displayText.isEmpty ? "请说话…" : session.displayText)
                .font(Theme.Fonts.transcript)
                .foregroundStyle(session.isVolatile ? Theme.mutedForeground : Theme.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: 560)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 26))
        .overlay(RoundedRectangle(cornerRadius: 26).strokeBorder(Theme.border, lineWidth: 1))
        if confirming {
            Button(action: onEdit) { content.contentShape(Rectangle()) }
                .buttonStyle(.plain)
        } else {
            content
        }
    }

    // MARK: - 扁弧底座（纯视觉锚点，不参与命中）

    /// 底部舒缓扁弧带：手指原地（zone == .none）时整体变亮，提示语在拱内。确认态保留作锚。
    /// scaleEffect 只影响渲染不影响布局，定位数学不用跟着变。
    private func stand(_ geometry: DictationZone.Geometry) -> some View {
        let active = stage == .listening && zone == .none
        return Color.clear
            .overlay(alignment: .bottom) {
                ZStack(alignment: .top) {
                    ZStack {
                        Ellipse().fill(Theme.card)
                        Ellipse().strokeBorder(Theme.border, lineWidth: 1)
                        if active {
                            Ellipse().fill(Theme.primary.opacity(0.12))
                        }
                    }
                    .scaleEffect(x: geometry.baseWidthMultiplier, y: 1)
                    Text(standHint)
                        .font(Theme.Fonts.label.weight(.medium))
                        .foregroundStyle(zone == .cancel ? Theme.destructive : (active ? Theme.foreground : Theme.mutedForeground))
                        .padding(.top, min(28, geometry.baseApex * 0.3))
                }
                .frame(height: geometry.baseApex * 2)
                .offset(y: geometry.baseApex)
            }
            .animation(.smooth(duration: 0.15), value: active)
    }

    private var standHint: String {
        if confirming { return "确认后发送" }
        if stage == .finalizing { return "正在识别…" }
        switch zone {
        case .cancel: return "松开取消"
        case .send: return "松开发送"
        case .none: return "松开确认"
        }
    }

    // MARK: - 圆按钮（进行中 = 角标，确认态 = 实体按钮）

    private func buttons(_ geometry: DictationZone.Geometry) -> some View {
        Color.clear
            .overlay(alignment: .bottomLeading) {
                orb(.cancel, icon: "xmark", label: "取消", tint: Theme.destructive, geometry: geometry)
                    .frame(width: geometry.diameter)
                    .padding(.leading, geometry.edgeInset - geometry.diameter / 2)
                    .offset(y: -geometry.drawLift)
            }
            .overlay(alignment: .bottom) {
                if confirming {
                    orb(nil, icon: "pencil", label: "编辑", tint: Theme.foreground, geometry: geometry)
                        .frame(width: geometry.diameter)
                        .offset(y: -geometry.drawLift)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                orb(.send, icon: "arrow.up", label: "发送", tint: Theme.primary, geometry: geometry)
                    .frame(width: geometry.diameter)
                    .padding(.trailing, geometry.edgeInset - geometry.diameter / 2)
                    .offset(y: -geometry.drawLift)
            }
    }

    /// 一颗圆按钮。标签在圆上方、圆在下：整块的底边仍是圆的底边，drawLift 的定位数学按圆本身算。
    /// 进行中（角标）态标签悬在圆外纯展示；确认态标签并进 Button 的 label（点字跟点圆一样能触发）。
    /// `target == nil` is the edit button: confirm state only, never a slide target.
    @ViewBuilder
    private func orb(
        _ target: DictationZone?,
        icon: String,
        label: String,
        tint: Color,
        geometry: DictationZone.Geometry
    ) -> some View {
        // 命中高亮只在手指还在屏上时有意义；确认态手指已离屏，语义消失
        let active = stage == .listening && target != nil && zone == target
        let glyph = Image(systemName: icon)
            .font(.system(size: geometry.diameter * 0.36, weight: .semibold))
            .frame(width: geometry.diameter, height: geometry.diameter)
        let labelText = Text(label)
            .font(Theme.Fonts.meta.weight(.semibold))
            .fixedSize()

        if confirming {
            // 实体按钮：发送是主操作（反色实底），取消 / 编辑次操作。不能用
            // .glassEffect(.interactive())——那层自带 UIKit 背板触摸响应，会吃掉 Button 的点击
            Button(action: target == .send ? onSend : (target == .cancel ? onDiscard : onEdit)) {
                VStack(spacing: 8) {
                    labelText.foregroundStyle(Theme.mutedForeground)
                    if target == .send {
                        glyph
                            .foregroundStyle(Theme.primaryForeground)
                            .background(Circle().fill(Theme.primary))
                    } else {
                        glyph
                            .foregroundStyle(target == .cancel ? Theme.destructive : Theme.foreground)
                            .background(Circle().fill(Theme.accentSurface))
                            .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            // 角标：低对比、无实体按钮感（手指还在屏上），滑进去才亮起来
            glyph
                .foregroundStyle(active ? tint : Theme.mutedForeground)
                .background(Circle().fill(active ? tint.opacity(0.22) : Theme.accentSurface.opacity(0.6)))
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
        case .active(let withContext):
            badge(withContext ? "豆包 · 带语境" : "豆包", tint: Theme.success)
        case .connecting:
            badge("连接中…", tint: Theme.mutedForeground)
        case .unavailable:
            // At rest the footer explains it; while the finger is down, say it up front.
            if resting { EmptyView() } else { badge("语音输入不可用", tint: Theme.warning) }
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

    /// 留驻态（没有底座与按钮）：权限引导、Key 未配置、无字失败。
    @ViewBuilder
    private var restingFooter: some View {
        switch session.phase {
        case .unavailable(.notConfigured):
            VStack(spacing: 8) {
                Text("语音输入不可用：未配置豆包 API Key")
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.foreground)
                    .multilineTextAlignment(.center)
                Button("去设置", action: onOpenSettings)
                    .font(Theme.Fonts.label.weight(.semibold))
                    .foregroundStyle(Theme.primary)
            }
        case .unavailable(.outdatedServer):
            Text("语音输入不可用：服务器版本过旧，不支持语音识别 Key")
                .font(Theme.Fonts.label)
                .foregroundStyle(Theme.foreground)
                .multilineTextAlignment(.center)
        case .permissionDenied:
            VStack(spacing: 8) {
                Text("需要麦克风权限")
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
            EmptyView()
        }
    }
}

/// A decorative waveform: it moves while listening and rests once the finger is off. The speech
/// engine exposes no level, so it signals "listening", not loudness.
private struct Waveform: View {
    let active: Bool
    private let bars = 15

    var body: some View {
        TimelineView(.animation(paused: !active)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0 ..< bars, id: \.self) { index in
                    let phase = time * 3.2 + Double(index) * 0.55
                    let level = active ? 0.35 + 0.65 * abs(sin(phase) * cos(phase * 0.37)) : 0.25
                    Capsule()
                        .fill(Theme.foreground.opacity(0.8))
                        .frame(width: 4, height: max(6, 40 * level))
                }
            }
            .frame(height: 40)
        }
        .accessibilityHidden(true)
    }
}

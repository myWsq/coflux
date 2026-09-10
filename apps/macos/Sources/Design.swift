import AppKit
import SwiftUI

struct WorkbenchIcon: View {
    let symbol: String
    var size: CGFloat = 12
    private var asset: String {
        ["arrow.branch": "git-branch", "folder.fill": "folder-open", "folder.badge.plus": "folder-plus",
         "lock.open": "lock-keyhole", "desktopcomputer": "monitor", "terminal": "square-terminal",
         "xmark": "x", "arrow.up": "arrow-up" ][symbol] ?? symbol
    }
    var body: some View {
        Image(asset).resizable().renderingMode(.template).frame(width: size, height: size).accessibilityHidden(true)
    }
}

enum Design {
    static let background = color(0x0f0f0f)
    static let foreground = color(0xe6e6e3)
    static let panel = color(0x151514)
    static let terminal = color(0x0a0a0a)
    static let muted = color(0x75756d)
    static let accent = color(0x262624)
    static let border = color(0x242422)
    static let success = color(0x4fae6e)
    static let warning = color(0xc9a227)
    static let destructive = color(0xe05c6a)
    static func color(_ rgb: UInt32) -> Color { Color(nsColor: native(rgb)) }
    static func native(_ rgb: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255,
                green: CGFloat((rgb >> 8) & 255) / 255,
                blue: CGFloat(rgb & 255) / 255, alpha: 1)
    }
}

/// macOS 的 PlainButtonStyle 仍会在按下时淡化标签；工作台由外层管理 hover / 选中外观。
struct WorkbenchPlainButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.contentShape(Rectangle())
    }
}

struct WorkbenchButtonStyle: ButtonStyle {
    var selected = false
    func makeBody(configuration: Configuration) -> some View {
        HoverContent(configuration: configuration, selected: selected)
    }
    private struct HoverContent: View {
        let configuration: Configuration
        let selected: Bool
        @State private var hovering = false
        var body: some View {
            configuration.label.contentShape(Rectangle())
                .background(selected || hovering || configuration.isPressed ? Design.accent : .clear,
                            in: RoundedRectangle(cornerRadius: 6))
                .onHover { hovering = $0 }
        }
    }
}

/// 对齐 Web 小号主按钮；仍由原生 Button 负责焦点与键盘激活。
struct WorkbenchPrimaryButtonStyle: ButtonStyle {
    var isLoading = false
    var height: CGFloat = 28
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13))
            .foregroundStyle(Design.color(0x171717))
            .opacity(isLoading ? 0 : 1)
            .padding(.horizontal, 12).frame(height: height)
            .overlay {
                if isLoading {
                    ProgressView().progressViewStyle(WorkbenchButtonProgressStyle())
                        .frame(width: 14, height: 14).accessibilityHidden(true)
                }
            }
            .background(Design.color(0xebebeb).opacity(configuration.isPressed ? 0.85 : 1),
                        in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .opacity(isEnabled ? 1 : 0.5)
    }
}

/// 对齐 Web 表单的次按钮，保持原生键盘与辅助功能语义。
struct WorkbenchSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13)).foregroundStyle(Design.foreground)
            .padding(.horizontal, 12).frame(height: 32)
            .background(Color.white.opacity(configuration.isPressed ? 0.16 : 0.1),
                        in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .opacity(isEnabled ? 1 : 0.5)
    }
}

/// 主按钮使用深色圆环，避免 AppKit spinner 的自动灰度在禁用背景上失去对比度。
private struct WorkbenchButtonProgressStyle: ProgressViewStyle {
    func makeBody(configuration: Configuration) -> some View { Ring() }
    private struct Ring: View {
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var rotating = false
        var body: some View {
            Circle().trim(from: 0.08, to: 0.83)
                .stroke(Design.color(0x171717), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .padding(1)
                .rotationEffect(.degrees(rotating && !reduceMotion ? 360 : 0))
                .animation(reduceMotion ? nil : .linear(duration: 0.8).repeatForever(autoreverses: false), value: rotating)
                .onAppear { rotating = true }
        }
    }
}

struct SmallButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            WorkbenchIcon(symbol: symbol).font(.system(size: 12))
                .frame(width: 24, height: 24)
        }.buttonStyle(WorkbenchButtonStyle()).accessibilityLabel(label)
            .workbenchTooltip(label)
    }
}

/// 使用原生子窗口，提示不会被标签滚动区域裁剪，也不改变终端尺寸。
private struct WorkbenchTooltip: ViewModifier {
    let text: String
    var below = false
    func body(content: Content) -> some View {
        content.modifier(SidebarDetailTooltip(tooltip:
            WorkbenchTooltipContent(text: text).accessibilityHidden(true), below: below, above: !below))
    }
}
/// 对齐main.tsx的cofluxTheme覆盖：深色popover、浅色正文12pt、横8/纵4内边距。
struct WorkbenchTooltipContent: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 12)).lineSpacing(3)
            .foregroundStyle(Design.color(0xfafafa))
            .frame(maxWidth: 284, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Design.color(0x1b1b1b), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.15), lineWidth: 1))
    }
}
extension View {
    func workbenchTooltip(_ text: String, below: Bool = false) -> some View { modifier(WorkbenchTooltip(text: text, below: below)) }
}

struct ActivityDots: View {
    let state: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var grid: Int { state == "active" ? 4 : 5 }
    private var lit: Set<Int>? {
        switch state {
        case "approval": [2, 7, 12, 22]
        case "question": [10, 12, 14]
        case "done", "waiting": [9, 13, 15, 17, 21]
        default: nil
        }
    }
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 20, paused: reduceMotion || state == "done" || state == "waiting")) { time in
            Canvas { context, size in
                let cell = size.width / CGFloat(grid)
                for index in 0..<(grid * grid) {
                    let on = lit?.contains(index) ?? true
                    let blink = !reduceMotion && state != "done" && state != "waiting" && on
                    let phase = time.date.timeIntervalSinceReferenceDate * 4 + Double(index) * 1.7
                    let opacity = on ? (blink ? 0.575 + 0.425 * sin(phase) : 1) : 0.12
                    let rect = CGRect(x: (CGFloat(index % grid) + 0.18) * cell,
                                      y: (CGFloat(index / grid) + 0.18) * cell,
                                      width: cell * 0.64, height: cell * 0.64)
                    context.fill(Path(ellipseIn: rect), with: .color(tone.opacity(opacity)))
                }
            }
        }.frame(width: 12, height: 12).accessibilityLabel(state)
    }
    private var tone: Color {
        if state == "approval" || state == "question" { return Design.warning }
        if state == "done" || state == "waiting" { return Design.success }
        return Design.muted
    }
}

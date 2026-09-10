import AppKit
import QuartzCore
import CofluxProtocol
import SwiftUI

struct WorkspaceTooltipContent: View {
    let workspace: Coflux_V1_Workspace
    let project: Coflux_V1_Project?
    let daemon: Coflux_V1_DaemonInfo?
    let activity: WorkspaceActivity
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(workspace.branch + (workspace.name.isEmpty || workspace.name == workspace.branch ? "" : " · " + workspace.name))
                .font(.system(size: 13, weight: .medium))
            VStack(alignment: .leading, spacing: 2) {
                if let state = activity.state {
                    HStack(spacing: 6) { ActivityDots(state: state); Text(activity.label) }.foregroundStyle(Design.muted)
                }
                if activity.state == "question", !activity.message.isEmpty {
                    detail("message-square", activity.message, multiline: true, primary: true)
                }
                if !activity.progress.isEmpty { detail("loader-circle", activity.progress, multiline: true) }
                detail("folder", workspace.path)
                detail("monitor", daemon.map { "\($0.name)（\($0.online ? "在线" : "离线")）" } ?? "设备记录缺失")
                if workspace.additions > 0 || workspace.deletions > 0 {
                    let branch = project?.defaultBranch ?? ""
                    let basis = branch.isEmpty || branch == workspace.branch ? "未提交改动" : "相对 \(branch) 的变更"
                    detail("file-diff", "\(basis) +\(workspace.additions) −\(workspace.deletions)")
                }
            }.font(.system(size: 11))
        }.frame(maxWidth: 284, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .foregroundStyle(Design.color(0xfafafa))
            .background(Design.color(0x1b1b1b), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.15), lineWidth: 1))
    }
    private func detail(_ icon: String, _ text: String, multiline: Bool = false, primary: Bool = false) -> some View {
        HStack(alignment: multiline ? .top : .center, spacing: 6) {
            WorkbenchIcon(symbol: icon).opacity(0.7).padding(.top, multiline ? 1 : 0)
            Text(text).lineLimit(multiline ? nil : 1).fixedSize(horizontal: false, vertical: multiline)
        }.foregroundStyle(primary ? Design.color(0xfafafa) : Design.muted)
    }
}

/// 独立子窗口不受 ScrollView 裁剪，也不改变侧栏或终端布局。
struct SidebarDetailTooltip<Tooltip: View>: ViewModifier {
    let tooltip: Tooltip
    var below = false
    var above = false
    @State private var hovered = false
    func body(content: Content) -> some View {
        content.onHover { hovered = $0 }
            .background(SidebarTooltipAnchor(content: tooltip, hovered: hovered, below: below, above: above))
    }
}
struct SidebarTooltipAnchor<Tooltip: View>: NSViewRepresentable {
    let content: Tooltip
    let hovered: Bool
    var below = false
    var above = false
    func makeNSView(context: Context) -> NativeTooltipAnchor { NativeTooltipAnchor() }
    func updateNSView(_ view: NativeTooltipAnchor, context: Context) {
        view.below = below
        view.above = above
        view.update(AnyView(content)); view.setAnchorHovered(hovered)
    }
    static func dismantleNSView(_ view: NativeTooltipAnchor, coordinator: ()) { view.dismiss() }
}
final class NativeTooltipPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
@MainActor final class NativeTooltipAnchor: NSView {
    var below = false
    var above = false
    private var tooltipContent = AnyView(EmptyView())
    private(set) var panel: NativeTooltipPanel?
    private var pending: Task<Void, Never>?
    private var refresh: Task<Void, Never>?
    private var contentHost: NSHostingView<AnyView>?
    private var anchorHovered = false
    private var eventMonitor: Any?
    private var observers: [NSObjectProtocol] = []
    override init(frame frameRect: NSRect) { super.init(frame: frameRect); clipsToBounds = true }
    required init?(coder: NSCoder) { super.init(coder: coder); clipsToBounds = true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    func update(_ content: AnyView) {
        tooltipContent = content
        guard panel != nil else { return }
        // SwiftUI更新先于布局；等本轮布局结束后再读取锚点，避免使用过渡坐标。
        refresh?.cancel()
        refresh = Task { @MainActor [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self, self.panel != nil else { return }
            self.window?.contentView?.layoutSubtreeIfNeeded()
            self.present()
        }
    }
    func setAnchorHovered(_ hovered: Bool) {
        guard anchorHovered != hovered else { return }
        anchorHovered = hovered
        setHovered(hovered, delay: hovered ? .milliseconds(200) : .milliseconds(100))
    }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); dismiss() }
    func setHovered(_ hovered: Bool, delay: Duration) {
        pending?.cancel()
        if hovered, panel != nil { return }
        pending = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard let self else { return }
            if hovered { self.present() } else { self.dismiss() }
        }
    }
    static func placement(anchor: CGRect, size: CGSize, visible: CGRect, below: Bool = false, above: Bool = false) -> CGRect {
        let bounds = visible.insetBy(dx: 4, dy: 4)
        let width = max(0, min(size.width, bounds.width)), height = max(0, min(size.height, bounds.height))
        if below || above {
            let lower = anchor.minY - height - 4, upper = anchor.maxY + 4
            let y = above ? (upper + height <= bounds.maxY ? upper : lower)
                          : (lower >= bounds.minY ? lower : upper)
            return CGRect(x: max(bounds.minX, min(anchor.midX - width / 2, bounds.maxX - width)),
                          y: max(bounds.minY, min(y, bounds.maxY - height)),
                          width: width, height: height)
        }
        let preferred = anchor.maxX + 4
        let x = preferred + width <= bounds.maxX ? preferred : anchor.minX - width - 4
        return CGRect(x: max(bounds.minX, min(x, bounds.maxX - width)),
                      y: max(bounds.minY, min(anchor.midY - height / 2, bounds.maxY - height)), width: width, height: height)
    }
    static func measuredHost(_ content: AnyView) -> (NSHostingView<AnyView>, CGSize) {
        let host = NSHostingView(rootView: content)
        let width = min(300, host.fittingSize.width)
        let controller = NSHostingController(rootView: content)
        let size = controller.sizeThatFits(in: CGSize(width: width, height: 10000))
        host.sizingOptions = []
        host.frame.size = size
        return (host, size)
    }
    func present() {
        guard let window, window.isVisible, !window.isMiniaturized, window.attachedSheet == nil,
              !visibleRect.intersection(bounds).isEmpty, let contentView = window.contentView else { dismiss(); return }
        let (host, size) = Self.measuredHost(AnyView(tooltipContent.onHover { [weak self] over in
            self?.setHovered(over, delay: over ? .zero : .milliseconds(100))
        }.environment(\.colorScheme, .dark)))
        let anchor = window.convertToScreen(convert(bounds, to: nil))
        let visible = window.convertToScreen(contentView.convert(contentView.bounds, to: nil))
            .intersection(window.screen?.visibleFrame ?? window.frame)
        guard !visible.isEmpty, !visible.isNull else { dismiss(); return }
        let frame = Self.placement(anchor: anchor, size: size, visible: visible, below: below, above: above)
        let tooltip = panel ?? NativeTooltipPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        tooltip.isReleasedWhenClosed = false; tooltip.isOpaque = false; tooltip.backgroundColor = .clear
        tooltip.hasShadow = true; tooltip.hidesOnDeactivate = true
        let isNew = panel == nil
        let root: AnyView
        if size.height > frame.height {
            root = AnyView(ScrollView {
                tooltipContent.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(width: frame.width, height: frame.height)
                .background(Design.color(0x1b1b1b), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.15), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .onHover { [weak self] over in self?.setHovered(over, delay: over ? .zero : .milliseconds(100)) }
                .environment(\.colorScheme, .dark))
        } else { root = host.rootView }
        if let contentHost {
            // 保留同一个NSHostingView，RTT更新不能触发移出/移入与重复入场。
            contentHost.rootView = root
            contentHost.frame = CGRect(origin: .zero, size: frame.size)
        } else {
            host.rootView = root
            host.frame = CGRect(origin: .zero, size: frame.size)
            contentHost = host
            tooltip.contentView = host
        }
        tooltip.setFrame(frame, display: true)
        if panel == nil {
            panel = tooltip
            window.addChildWindow(tooltip, ordered: .above)
            eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel]) { [weak self] event in
                if event.type == .scrollWheel, event.window === self?.panel { return event }
                if event.type == .keyDown,
                   (event.window?.firstResponder as? NSTextInputClient)?.hasMarkedText() == true { return event }
                if event.type != .keyDown || event.keyCode == 53 { self?.dismiss() }
                return event
            }
            for name in [NSWindow.didResignKeyNotification, NSWindow.willCloseNotification, NSWindow.didResizeNotification,
                         NSWindow.didMoveNotification, NSWindow.willBeginSheetNotification, NSWindow.didMiniaturizeNotification] {
                observeDismiss(name, object: window)
            }
            observeDismiss(NSApplication.didResignActiveNotification, object: NSApp)
            if let clip = enclosingScrollView?.contentView {
                clip.postsBoundsChangedNotifications = true
                observeDismiss(NSView.boundsDidChangeNotification, object: clip)
            }
        }
        let animateEntry = isNew && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if isNew { tooltip.alphaValue = animateEntry ? 0 : 1 }
        tooltip.orderFront(nil)
        if animateEntry, let view = tooltip.contentView {
            view.wantsLayer = true
            if let layer = view.layer {
                let timing = CAMediaTimingFunction(controlPoints: 0.24, 1, 0.4, 1)
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.165; context.timingFunction = timing
                    tooltip.animator().alphaValue = 1
                }
                let transform = CABasicAnimation(keyPath: "transform")
                // 以面板中心缩放；方向取Web声明的placement，而非边缘翻转后的方向。
                let vertical = below ? CGFloat(8) : above ? CGFloat(-8) : 0
                var start = CATransform3DMakeTranslation(frame.width * 0.025 + (below || above ? 0 : -8),
                                                        frame.height * 0.025 + (layer.isGeometryFlipped ? -vertical : vertical), 0)
                start = CATransform3DScale(start, 0.95, 0.95, 1)
                transform.fromValue = NSValue(caTransform3D: start)
                transform.toValue = NSValue(caTransform3D: CATransform3DIdentity)
                let group = CAAnimationGroup(); group.animations = [transform]
                group.duration = 0.165; group.timingFunction = timing
                layer.add(group, forKey: "tooltip.enter")
            }
        }
    }
    private func observeDismiss(_ name: Notification.Name, object: AnyObject) {
        observers.append(NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss() }
        })
    }
    func dismiss() {
        pending?.cancel(); pending = nil
        refresh?.cancel(); refresh = nil
        contentHost = nil
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor); self.eventMonitor = nil }
        observers.forEach { NotificationCenter.default.removeObserver($0) }; observers.removeAll()
        if let panel { panel.parent?.removeChildWindow(panel); panel.orderOut(nil); panel.contentView = nil }
        panel = nil
    }
}

import AppKit
import Carbon
import GhosttyKit

/// I/O 线程只能拷贝数据并投递；不在回调中同步重入 Ghostty。
private final class GhosttyCallbackContext: @unchecked Sendable {
    @MainActor weak var view: GhosttyTerminalView?
    @MainActor var valid = true
    @MainActor init(_ view: GhosttyTerminalView) { self.view = view }
    func write(_ bytes: Data) {
        DispatchQueue.main.async { [self] in
            guard valid, let view else { return }
            view.onInput?(bytes)
        }
    }
    func resize(_ columns: UInt32, _ rows: UInt32) {
        DispatchQueue.main.async { [self] in
            guard valid, let view else { return }
            view.onResize?(Int(columns), Int(rows))
        }
    }
}

@MainActor private final class GhosttyRuntime {
    static let shared = GhosttyRuntime()
    let app: ghostty_app_t
    let config: ghostty_config_t
    private init() {
        precondition(ghostty_init(0, nil) == 0)
        guard let config = ghostty_config_new() else { fatalError("Ghostty 配置初始化失败") }
        self.config = config
        let path = Bundle.main.path(forResource: "terminal", ofType: "conf")
            ?? ProcessInfo.processInfo.environment["COFLUX_GHOSTTY_CONFIG"]
        guard let path else { fatalError("缺少工作台终端配置 terminal.conf") }
        path.withCString { ghostty_config_load_file(config, $0) }
        ghostty_config_finalize(config)
        for index in 0..<ghostty_config_diagnostics_count(config) {
            let diagnostic = ghostty_config_get_diagnostic(config, index)
            if let message = diagnostic.message { assertionFailure(String(cString: message)) }
        }
        var runtime = ghostty_runtime_config_s()
        runtime.wakeup_cb = { _ in
            DispatchQueue.main.async { ghostty_app_tick(GhosttyRuntime.shared.app) }
        }
        runtime.action_cb = { _, target, action in
            MainActor.assumeIsolated {
                guard target.tag == GHOSTTY_TARGET_SURFACE,
                      let surface = target.target.surface,
                      let raw = ghostty_surface_userdata(surface) else { return action.tag == GHOSTTY_ACTION_OPEN_URL }
                let context = Unmanaged<GhosttyCallbackContext>.fromOpaque(raw).takeUnretainedValue()
                guard context.valid, let view = context.view else { return action.tag == GHOSTTY_ACTION_OPEN_URL }
                switch action.tag {
                case GHOSTTY_ACTION_SET_TITLE:
                    if let text = action.action.set_title.title { view.onTitle?(String(cString: text)) }
                    return true
                case GHOSTTY_ACTION_SCROLLBAR:
                    view.refreshScrollPosition()
                    return true
                case GHOSTTY_ACTION_MOUSE_SHAPE:
                    view.updateCursor(action.action.mouse_shape == GHOSTTY_MOUSE_SHAPE_POINTER ? .pointingHand : .iBeam)
                    return true
                case GHOSTTY_ACTION_OPEN_URL:
                    let url = action.action.open_url
                    if let pointer = url.url {
                        let text = String(decoding: UnsafeRawBufferPointer(start: pointer, count: Int(url.len)), as: UTF8.self)
                        view.onOpenLink?(text, url.kind == GHOSTTY_ACTION_OPEN_URL_KIND_OSC8)
                    }
                    return true
                default: return false
                }
            }
        }
        // 普通粘贴由宿主直接提交；远端 OSC 52 读取遵循 deny 配置。
        runtime.read_clipboard_cb = { _, _, _, _, _, _ in GHOSTTY_CLIPBOARD_READ_UNAVAILABLE }
        runtime.confirm_read_clipboard_cb = { _, _, _, _ in }
        runtime.write_clipboard_cb = { _, _, content, count, _ in
            guard let content else { return }
            let text = (0..<count).compactMap { index -> String? in
                let item = content[index]
                guard let mime = item.mime, String(cString: mime).hasPrefix("text/plain"), let data = item.data else { return nil }
                return String(decoding: UnsafeRawBufferPointer(start: data, count: item.len), as: UTF8.self)
            }.first
            if let text { DispatchQueue.main.async {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            } }
        }
        runtime.close_surface_cb = { _, _ in }
        guard let app = ghostty_app_new(&runtime, config) else { fatalError("Ghostty 运行时初始化失败") }
        self.app = app
    }
}

/// Metal 渲染与 VT 状态由 Ghostty 持有；网络会话、上传和工作台生命周期由宿主管理。
@MainActor class GhosttyTerminalView: NSView, @preconcurrency NSTextInputClient {
    private(set) var surface: ghostty_surface_t?
    private var context: GhosttyCallbackContext?
    weak var sessionCoordinator: AnyObject?
    var onInput: ((Data) -> Void)?
    var onResize: ((Int, Int) -> Void)?
    var onTitle: ((String) -> Void)?
    var onScroll: ((Double) -> Void)?
    private(set) var scrollPosition = 1.0
    var onOpenLink: ((String, Bool) -> Void)?
    private var markedText = NSAttributedString(string: "")
    private var markedSelection = NSRange(location: NSNotFound, length: 0)
    private var committed: [String]?
    private var surfaceVisible = true
    private let scroller = NSScroller(frame: NSRect(x: 0, y: 0, width: 14, height: 100))
    private var scrollTotal: UInt64 = 0
    private var scrollLength: UInt64 = 0
    private var currentCursor = NSCursor.iBeam
    private var tracking: NSTrackingArea?
    var columns: Int { surface.map { Int(ghostty_surface_size($0).columns) } ?? 80 }
    var rows: Int { surface.map { Int(ghostty_surface_size($0).rows) } ?? 24 }
    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        createSurface()
        scroller.scrollerStyle = .overlay
        scroller.knobStyle = .light
        scroller.isEnabled = true
        scroller.target = self
        scroller.action = #selector(scrollerChanged(_:))
        scroller.isHidden = true
        addSubview(scroller)
    }
    required init?(coder: NSCoder) { fatalError("不使用 Storyboard") }
    isolated deinit { closeSurface() }

    private func createSurface() {
        let runtime = GhosttyRuntime.shared
        let context = GhosttyCallbackContext(self)
        self.context = context
        let raw = Unmanaged.passUnretained(context).toOpaque()
        var io = ghostty_external_io_s()
        io.userdata = raw
        io.write = { raw, pointer, count in
            guard let raw, let pointer else { return }
            Unmanaged<GhosttyCallbackContext>.fromOpaque(raw).takeUnretainedValue().write(Data(bytes: pointer, count: count))
        }
        io.resize = { raw, columns, rows in
            guard let raw else { return }
            Unmanaged<GhosttyCallbackContext>.fromOpaque(raw).takeUnretainedValue().resize(columns, rows)
        }
        var options = ghostty_surface_config_new()
        options.platform_tag = GHOSTTY_PLATFORM_MACOS
        options.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(self).toOpaque()))
        options.userdata = raw
        options.scale_factor = Double(window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 1)
        options.font_size = 12
        surface = withUnsafePointer(to: &io) { pointer in
            options.external_io = pointer
            return ghostty_surface_new(runtime.app, &options)
        }
        precondition(surface != nil, "Ghostty 表面初始化失败")
        updateSurfaceSize()
        setSurfaceVisible(surfaceVisible)
    }
    func prepareForRemoval() {
        if window?.firstResponder === self { window?.makeFirstResponder(nil) }
        inputContext?.deactivate()
        trackingAreas.forEach { removeTrackingArea($0) }
        tracking = nil
        discardCursorRects()
        scroller.target = nil
        sessionCoordinator = nil
        onInput = nil; onResize = nil; onTitle = nil; onOpenLink = nil; onScroll = nil
        closeSurface()
    }
    func closeSurface() {
        context?.valid = false
        if let surface { ghostty_surface_free(surface); self.surface = nil }
        context = nil
    }
    /// 重建清除解析器残帧、备用屏幕、选择与滚动历史，防止旧状态污染服务器快照。
    func resetTerminal() {
        closeSurface()
        markedText = NSAttributedString(string: "")
        markedSelection = NSRange(location: NSNotFound, length: 0)
        createSurface()
        setTerminalFocus(window?.firstResponder === self && window?.isKeyWindow == true)
    }
    func feedOutput(_ bytes: ArraySlice<UInt8>) {
        guard let surface else { return }
        bytes.withUnsafeBufferPointer { if let base = $0.baseAddress { ghostty_surface_feed(surface, base, $0.count) } }
        refreshScrollPosition()
    }
    func feed(text: String) { feedOutput(Array(text.utf8)[...]) }
    func setSurfaceVisible(_ visible: Bool) {
        surfaceVisible = visible
        if let surface { ghostty_surface_set_occlusion(surface, visible) }
        scroller.isHidden = !visible || scrollTotal <= scrollLength
        if !visible { setTerminalFocus(false) }
    }
    func setTerminalFocus(_ focused: Bool) { if let surface { ghostty_surface_set_focus(surface, focused) } }
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { setTerminalFocus(window?.isKeyWindow == true) }
        return accepted
    }
    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { setTerminalFocus(false) }
        return accepted
    }
    override func setFrameSize(_ newSize: NSSize) { super.setFrameSize(newSize); updateSurfaceSize() }
    override func viewDidChangeBackingProperties() { super.viewDidChangeBackingProperties(); updateSurfaceSize() }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); updateSurfaceSize() }
    private func updateSurfaceSize() {
        guard let surface else { return }
        // SwiftUI 挂载或折叠时可能短暂没有可见面积，保留已有网格，避免无意义的重排。
        guard bounds.width > 0, bounds.height > 0 else { return }
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 1
        if let display = window?.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            ghostty_surface_set_display_id(surface, display.uint32Value)
        }
        ghostty_surface_set_content_scale(surface, scale, scale)
        ghostty_surface_set_size(surface, UInt32(max(1, bounds.width * scale)), UInt32(max(1, bounds.height * scale)))
    }
    @discardableResult func bindingAction(_ action: String) -> Bool {
        guard let surface else { return false }
        return action.withCString { ghostty_surface_binding_action(surface, $0, UInt(action.utf8.count)) }
    }
    func refreshScrollPosition() {
        guard let surface else { return }
        let state = ghostty_surface_scrollbar_state(surface)
        scrollTotal = state.total; scrollLength = state.len
        scrollPosition = state.total > state.len ? Double(state.offset) / Double(state.total - state.len) : 1
        scroller.doubleValue = scrollPosition
        scroller.knobProportion = state.total > 0 ? Double(state.len) / Double(state.total) : 1
        scroller.isHidden = !surfaceVisible || state.total <= state.len
        onScroll?(scrollPosition)
    }
    func scroll(toPosition position: Double) {
        guard let surface else { return }
        let maximum = scrollTotal > scrollLength ? scrollTotal - scrollLength : 0
        bindingAction("scroll_to_row:" + String(UInt64(Double(maximum) * min(1, max(0, position)))))
        ghostty_surface_sync(surface)
        refreshScrollPosition()
    }
    @objc private func scrollerChanged(_ sender: NSScroller) {
        let extent = Double(max(1, scrollTotal > scrollLength ? scrollTotal - scrollLength : 1))
        switch sender.hitPart {
        case .decrementLine: scroll(toPosition: scrollPosition - 1 / extent)
        case .incrementLine: scroll(toPosition: scrollPosition + 1 / extent)
        case .decrementPage: scroll(toPosition: scrollPosition - Double(scrollLength) / extent)
        case .incrementPage: scroll(toPosition: scrollPosition + Double(scrollLength) / extent)
        default: scroll(toPosition: sender.doubleValue)
        }
    }
    override func layout() {
        super.layout()
        scroller.frame = NSRect(x: max(0, bounds.width - 14), y: 0, width: 14, height: bounds.height)
    }
    func updateCursor(_ cursor: NSCursor) { currentCursor = cursor; window?.invalidateCursorRects(for: self) }
    override func resetCursorRects() { if surface != nil { addCursorRect(bounds, cursor: currentCursor) } }
    var mouseCaptured: Bool { surface.map { ghostty_surface_mouse_captured($0) } ?? false }
    func readText(viewport: Bool = false) -> String {
        guard let surface else { return "" }
        let tag = viewport ? GHOSTTY_POINT_VIEWPORT : GHOSTTY_POINT_SCREEN
        let selection = ghostty_selection_s(
            top_left: ghostty_point_s(tag: tag, coord: GHOSTTY_POINT_COORD_TOP_LEFT, x: 0, y: 0),
            bottom_right: ghostty_point_s(tag: tag, coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT, x: 0, y: 0), rectangle: false)
        var text = ghostty_text_s()
        guard ghostty_surface_read_text(surface, selection, &text), let pointer = text.text else { return "" }
        defer { ghostty_surface_free_text(surface, &text) }
        return String(decoding: UnsafeRawBufferPointer(start: pointer, count: Int(text.text_len)), as: UTF8.self)
    }
    func selectedText() -> String? {
        guard let surface else { return nil }
        var text = ghostty_text_s()
        guard ghostty_surface_read_selection(surface, &text), let pointer = text.text else { return nil }
        defer { ghostty_surface_free_text(surface, &text) }
        return String(decoding: UnsafeRawBufferPointer(start: pointer, count: Int(text.text_len)), as: UTF8.self)
    }
    @objc func copy(_ sender: Any?) {
        guard let text = selectedText() else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    }
    override func selectAll(_ sender: Any?) { bindingAction("select_all") }
    @objc func paste(_ sender: Any?) {
        if let text = NSPasteboard.general.string(forType: .string) { pasteUploadedPaths(text) }
    }
    func pasteUploadedPaths(_ text: String) {
        guard let surface else { return }
        text.withCString { ghostty_surface_text(surface, $0, UInt(text.utf8.count)) }
    }
    private func mods(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var value: UInt32 = 0
        for (flag, bit): (NSEvent.ModifierFlags, ghostty_input_mods_e) in [(.shift, GHOSTTY_MODS_SHIFT), (.control, GHOSTTY_MODS_CTRL), (.option, GHOSTTY_MODS_ALT), (.command, GHOSTTY_MODS_SUPER), (.capsLock, GHOSTTY_MODS_CAPS)] {
            if flags.contains(flag) { value |= bit.rawValue }
        }
        return ghostty_input_mods_e(rawValue: value)
    }
    private func sendKey(_ event: NSEvent, action: ghostty_input_action_e, text: String? = nil, composing: Bool = false) {
        guard let surface else { return }
        var key = ghostty_input_key_s()
        key.action = action; key.keycode = UInt32(event.keyCode); key.mods = mods(event.modifierFlags)
        key.consumed_mods = mods(event.modifierFlags.intersection([.shift, .option]))
        key.unshifted_codepoint = event.characters(byApplyingModifiers: [])?.unicodeScalars.first?.value ?? 0
        key.composing = composing
        if let text, let first = text.unicodeScalars.first, first.value >= 0x20 && !(0xf700...0xf8ff).contains(first.value) {
            text.withCString { key.text = $0; _ = ghostty_surface_key(surface, key) }
        } else { _ = ghostty_surface_key(surface, key) }
    }
    override func keyDown(with event: NSEvent) {
        let wasMarked = hasMarkedText()
        let inputSource = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
        committed = []
        interpretKeyEvents([event])
        let texts = committed ?? []; committed = nil
        if !wasMarked && !CFEqual(inputSource, TISCopyCurrentKeyboardInputSource().takeRetainedValue()) { return }
        let action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
        if wasMarked {
            for text in texts where !text.unicodeScalars.contains(where: { $0.value < 0x20 }) {
                var key = ghostty_input_key_s(); key.action = action
                if let surface { text.withCString { key.text = $0; _ = ghostty_surface_key(surface, key) } }
            }
            if !texts.isEmpty && ([124, 125, 126].contains(event.keyCode) || (event.keyCode == 123 && !event.modifierFlags.intersection([.shift, .control, .option, .command]).isEmpty)) {
                sendKey(event, action: action)
            }
            return
        }
        if !texts.isEmpty { for text in texts { sendKey(event, action: action, text: text) } }
        else { sendKey(event, action: action, text: event.characters, composing: hasMarkedText()) }
    }
    override func flagsChanged(with event: NSEvent) {
        guard !hasMarkedText() else { return }
        let modifier: NSEvent.ModifierFlags
        switch event.keyCode {
        case 57: modifier = .capsLock
        case 56, 60: modifier = .shift
        case 59, 62: modifier = .control
        case 58, 61: modifier = .option
        case 55, 54: modifier = .command
        default: return
        }
        let rightMask: UInt
        switch event.keyCode {
        case 60: rightMask = UInt(NX_DEVICERSHIFTKEYMASK)
        case 62: rightMask = UInt(NX_DEVICERCTLKEYMASK)
        case 61: rightMask = UInt(NX_DEVICERALTKEYMASK)
        case 54: rightMask = UInt(NX_DEVICERCMDKEYMASK)
        default: rightMask = 0
        }
        let pressed = event.modifierFlags.contains(modifier) && (rightMask == 0 || event.modifierFlags.rawValue & rightMask != 0)
        sendKey(event, action: pressed ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE)
    }
    override func keyUp(with event: NSEvent) { sendKey(event, action: GHOSTTY_ACTION_RELEASE) }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // 多终端常驻挂载时，只有当前输入目标能消费编辑快捷键。
        guard window?.firstResponder === self else { return false }
        guard event.modifierFlags.intersection([.command, .control, .option]) == .command else { return false }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "c": copy(nil); return true
        case "v": paste(nil); return true
        case "a": selectAll(nil); return true
        default: return false
        }
    }
    func hasMarkedText() -> Bool { markedText.length > 0 }
    func markedRange() -> NSRange { NSRange(location: hasMarkedText() ? 0 : NSNotFound, length: markedText.length) }
    func selectedRange() -> NSRange {
        let missing = NSRange(location: NSNotFound, length: 0)
        guard let surface else { return missing }
        if hasMarkedText() { return markedSelection }
        // 与 Ghostty 的 AppKit 宿主一样，非组合状态使用核心提供的视口选区坐标。
        var text = ghostty_text_s()
        guard ghostty_surface_read_selection(surface, &text) else { return missing }
        defer { ghostty_surface_free_text(surface, &text) }
        return NSRange(location: Int(text.offset_start), length: Int(text.offset_len))
    }
    func setMarkedText(_ value: Any, selectedRange: NSRange, replacementRange: NSRange) {
        markedText = (value as? NSAttributedString) ?? NSAttributedString(string: value as? String ?? "")
        markedSelection = selectedRange; syncPreedit()
    }
    func unmarkText() {
        markedText = NSAttributedString(string: "")
        markedSelection = NSRange(location: NSNotFound, length: 0)
        syncPreedit()
    }
    private func syncPreedit() {
        guard let surface else { return }
        let text = markedText.string
        text.withCString { ghostty_surface_preedit(surface, $0, UInt(text.utf8.count)) }
    }
    func insertText(_ value: Any, replacementRange: NSRange) {
        let text = (value as? NSAttributedString)?.string ?? value as? String ?? ""
        unmarkText()
        if committed != nil { committed?.append(text) }
        else if let surface {
            var key = ghostty_input_key_s(); key.action = GHOSTTY_ACTION_PRESS
            text.withCString { key.text = $0; _ = ghostty_surface_key(surface, key) }
        }
    }
    override func doCommand(by selector: Selector) {}
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        if hasMarkedText() {
            let clipped = NSIntersectionRange(range, NSRange(location: 0, length: markedText.length))
            actualRange?.pointee = clipped
            return markedText.attributedSubstring(from: clipped)
        }
        guard let text = selectedText() else { return nil }; return NSAttributedString(string: text)
    }
    func characterIndex(for point: NSPoint) -> Int { 0 }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let surface, let window else { return .zero }
        var x = 0.0, y = 0.0, width = 0.0, height = 0.0
        ghostty_surface_ime_point(surface, &x, &y, &width, &height)
        return window.convertToScreen(convert(NSRect(x: x, y: y, width: width, height: height), to: nil))
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking); self.tracking = nil }
        guard surface != nil else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
    }
    override func mouseMoved(with event: NSEvent) {
        guard let surface else { return }
        let point = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, point.x, point.y, mods(event.modifierFlags))
    }
    private func mouseButton(_ event: NSEvent, pressed: Bool) {
        window?.makeFirstResponder(self); mouseMoved(with: event)
        guard let surface else { return }
        let button: ghostty_input_mouse_button_e
        // 按 AppKit 分发的事件类型识别左右键；合成 NSEvent 的 buttonNumber 可能仍为 0。
        switch event.type {
        case .leftMouseDown, .leftMouseUp: button = GHOSTTY_MOUSE_LEFT
        case .rightMouseDown, .rightMouseUp: button = GHOSTTY_MOUSE_RIGHT
        default: button = ghostty_input_mouse_button_e(rawValue: UInt32(min(11, max(3, event.buttonNumber + 1))))
        }
        _ = ghostty_surface_mouse_button(surface, pressed ? GHOSTTY_MOUSE_PRESS : GHOSTTY_MOUSE_RELEASE, button, mods(event.modifierFlags))
    }
    override func mouseDown(with event: NSEvent) { mouseButton(event, pressed: true) }
    override func mouseUp(with event: NSEvent) { mouseButton(event, pressed: false) }
    override func mouseDragged(with event: NSEvent) { mouseMoved(with: event) }
    override func rightMouseDown(with event: NSEvent) { mouseButton(event, pressed: true) }
    override func rightMouseDragged(with event: NSEvent) { mouseMoved(with: event) }
    override func otherMouseDragged(with event: NSEvent) { mouseMoved(with: event) }
    override func rightMouseUp(with event: NSEvent) { mouseButton(event, pressed: false) }
    override func otherMouseDown(with event: NSEvent) { mouseButton(event, pressed: true) }
    override func otherMouseUp(with event: NSEvent) { mouseButton(event, pressed: false) }
    override func scrollWheel(with event: NSEvent) {
        guard let surface else { return }
        var momentum: Int32 = 0
        switch event.momentumPhase { case .began: momentum = 1; case .stationary: momentum = 2; case .changed: momentum = 3; case .ended: momentum = 4; case .cancelled: momentum = 5; case .mayBegin: momentum = 6; default: break }
        ghostty_surface_mouse_scroll(surface, event.scrollingDeltaX, event.scrollingDeltaY, (event.hasPreciseScrollingDeltas ? 1 : 0) | (momentum << 1))
    }
}

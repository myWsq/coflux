import AppKit
import GhosttyKit
@testable import GhosttyTerminal

// spike 固定 revision：公开封装未开放 replay/raw surface，通过 enable-testing 访问内部接口。
public typealias HostCallback = @convention(c) (UInt64, Int32, UnsafePointer<UInt8>?, Int32, Double, Double) -> Void
@MainActor private var hosts: [UInt64: Host] = [:]
@MainActor private var nextID: UInt64 = 0

// IO 线程生成的输入在生成时和主线程交付时各检查一次，切 Tab 后不能把旧回调交给新 epoch。
private final class InputGate: @unchecked Sendable {
    private let lock = NSLock()
    private var allowed = false
    private var epoch: UInt64 = 0
    func set(_ allowed: Bool, _ epoch: UInt64) { lock.lock(); self.allowed = allowed; self.epoch = epoch; lock.unlock() }
    func capture() -> UInt64? { lock.lock(); defer { lock.unlock() }; return allowed ? epoch : nil }
}

@MainActor private final class OverlayView: AppTerminalView {
    var command: ((String) -> Void)?
    var notice: ((String) -> Void)?
    var allowsInput = false
    private var handled: TimeInterval?
    private var suppressedKeys = Set<UInt16>()
    private func shortcut(_ event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection([.command, .shift, .option, .control]) == [.command] else { return false }
        // 与网页 event.code 一样按物理键位分发，避免输入法和键盘布局改变工作台快捷键。
        let commands: [UInt16: String] = [17: "create-terminal", 13: "close-terminal", 45: "create-workspace", 33: "previous-tab", 30: "next-tab", 44: "toggle-help", 18: "tab:0", 19: "tab:1", 20: "tab:2", 21: "tab:3", 23: "tab:4", 22: "tab:5", 26: "tab:6", 28: "tab:7", 25: "tab:8"]
        if let value = commands[event.keyCode] {
            suppressedKeys.insert(event.keyCode)
            if handled != event.timestamp { handled = event.timestamp; command?(value) }
            return true
        }
        if event.keyCode == 8 { suppressedKeys.insert(event.keyCode); if handled != event.timestamp { handled = event.timestamp; _ = copySelectedTextToPasteboard() }; return true }
        if event.keyCode == 9 { suppressedKeys.insert(event.keyCode); if handled != event.timestamp { handled = event.timestamp; pasteTextOnly() }; return true }
        return false
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self else { return false }
        return shortcut(event) || super.performKeyEquivalent(with: event)
    }
    override func keyDown(with event: NSEvent) {
        if shortcut(event) { return }
        guard allowsInput else { return }
        super.keyDown(with: event)
    }
    override func keyUp(with event: NSEvent) {
        // 已消费的 Command 快捷键不再把 release 编码成远端输入。
        if suppressedKeys.remove(event.keyCode) != nil || event.modifierFlags.contains(.command) { return }
        if allowsInput { super.keyUp(with: event) }
    }
    override func flagsChanged(with event: NSEvent) {
        if event.keyCode == 54 || event.keyCode == 55 { return }
        if allowsInput { super.flagsChanged(with: event) }
    }
    @objc func cofluxPaste(_ sender: Any?) { pasteTextOnly() }
    func pasteTextOnly() {
        guard allowsInput else { return }
        let pasteboard = NSPasteboard.general
        if pasteboard.types?.contains(.fileURL) == true || pasteboard.types?.contains(.png) == true || pasteboard.types?.contains(.tiff) == true {
            notice?("Ghostty 试验暂不支持文件和图片粘贴")
            return
        }
        if let text = pasteboard.string(forType: .string) { _ = paste(text: text) }
    }
    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        notice?("Ghostty 试验暂不支持拖拽上传")
        return []
    }
    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool { false }
}

@MainActor private final class Host: TerminalSurfaceOpenURLDelegate {
    let id: UInt64
    let callback: HostCallback
    let view: OverlayView
    let controller = TerminalController(configSource: .generated("keybind = clear\nclipboard-read = deny\n"))
    let gate = InputGate()
    var session: InMemoryTerminalSession!
    var closed = false
    var busy = false
    var smokeWindow: NSWindow?
    var confirmed: (Int, Int)?
    var waitingKind: Int32? = 1
    var pending: (Data, Bool)?
    var revision: UInt64 = 0
    var accessEpoch: UInt64 = 0

    init(id: UInt64, callback: @escaping HostCallback, parent: NSView, rect: NSRect) {
        self.id = id; self.callback = callback
        view = OverlayView(frame: rect)
        view.delegate = self
        view.command = { [weak self] command in self?.emit(7, data: Data(command.utf8)) }
        view.notice = { [weak self] notice in self?.emit(10, data: Data(notice.utf8)) }
        view.registerForDraggedTypes([.fileURL, .png, .tiff])
        configureSession()
        view.controller = controller
        parent.addSubview(view, positioned: .above, relativeTo: nil)
    }
    func configureSession() {
        let id = id, gate = gate, revision = revision
        session = InMemoryTerminalSession(write: { data in
            guard let epoch = gate.capture() else { return }
            DispatchQueue.main.async {
                guard let host = hosts[id], !host.closed, host.revision == revision, gate.capture() == epoch else { return }
                host.emit(2, data: data, x: Double(epoch))
            }
        }, resize: { viewport in
            DispatchQueue.main.async {
                guard let host = hosts[id], !host.closed, host.revision == revision else { return }
                host.confirmed = (Int(viewport.columns), Int(viewport.rows))
                host.emit(3, x: Double(viewport.columns), y: Double(viewport.rows))
                host.advanceFence()
            }
        })
        view.configuration = TerminalSurfaceOptions(backend: .inMemory(session), fontSize: 12, resizeThrottleMilliseconds: 0)
    }
    func emit(_ kind: Int32, data: Data = Data(), x: Double = 0, y: Double = 0) {
        guard !closed else { return }
        data.withUnsafeBytes { bytes in callback(id, kind, bytes.baseAddress?.assumingMemoryBound(to: UInt8.self), Int32(bytes.count), x, y) }
    }
    func terminalDidRequestOpenURL(_ url: String, kind: TerminalOpenURLKind) { emit(4, data: Data(url.utf8)) }
    func readyForOutput() -> Bool {
        guard let raw = view.surface?.rawValue, let confirmed else { return false }
        let size = ghostty_surface_size(raw)
        return confirmed.0 == Int(size.columns) && confirmed.1 == Int(size.rows)
    }
    func advanceFence() {
        guard !closed, readyForOutput() else { return }
        if let kind = waitingKind {
            waitingKind = nil
            emit(kind, x: Double(confirmed!.0), y: Double(confirmed!.1))
        }
        if let (data, replay) = pending { pending = nil; parse(data, replay: replay) }
    }
    func tickWhileParsing() {
        let id = id
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(5)) {
            guard let host = hosts[id], host.busy, host.pending == nil else { return }
            // 隐藏/后台窗口仍须排空 app mailbox，避免解析线程等待无人消费的标题等回调。
            host.controller.tick()
            host.tickWhileParsing()
        }
    }
    func parse(_ data: Data, replay: Bool) {
        guard let raw = view.surface?.rawValue else { busy = false; emit(5, data: Data("surface 已丢失".utf8)); return }
        let address = UInt(bitPattern: raw), id = id
        tickWhileParsing()
        DispatchQueue.global(qos: .userInitiated).async {
            let surface = UnsafeMutableRawPointer(bitPattern: address)!
            data.withUnsafeBytes { buffer in
                if let pointer = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) {
                    if replay { ghostty_surface_write_buffer_replay(surface, pointer, UInt(buffer.count)) }
                    else { ghostty_surface_write_buffer(surface, pointer, UInt(buffer.count)) }
                }
            }
            DispatchQueue.main.async {
                guard let current = hosts[id] else { return }
                current.busy = false
                if current.closed { current.releaseSurface() }
                else { current.emit(6, x: Double(data.count)) }
            }
        }
    }
    func destroy() {
        closed = true; gate.set(false, accessEpoch)
        view.setSurfaceVisible(false); view.removeFromSuperview()
        if pending != nil { pending = nil; busy = false }
        if !busy { releaseSurface() }
    }
    func releaseSurface() {
        view.core.freeSurface()
        smokeWindow?.close(); smokeWindow = nil
        hosts.removeValue(forKey: id)
    }
}

@_cdecl("coflux_ghostty_create") @MainActor
public func create(_ handle: UnsafeMutableRawPointer?, _ x: Double, _ y: Double, _ width: Double, _ height: Double, _ scale: Double, _ callback: @escaping HostCallback) -> UInt64 {
    guard Thread.isMainThread, width > 0, height > 0, scale > 0 else { return 0 }
    let parent: NSView
    var window: NSWindow?
    if let handle { parent = Unmanaged<NSView>.fromOpaque(handle).takeUnretainedValue() }
    else {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let hidden = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
        hidden.isReleasedWhenClosed = false; window = hidden; parent = hidden.contentView!
    }
    nextID += 1
    let rect = NSRect(x: x, y: parent.isFlipped ? y : parent.bounds.height - y - height, width: width, height: height)
    let host = Host(id: nextID, callback: callback, parent: parent, rect: rect)
    host.smokeWindow = window; hosts[nextID] = host
    guard host.view.surface?.rawValue != nil else { host.destroy(); return 0 }
    return nextID
}

@_cdecl("coflux_ghostty_destroy") @MainActor
public func destroy(_ id: UInt64) { precondition(Thread.isMainThread); hosts[id]?.destroy() }

@_cdecl("coflux_ghostty_frame") @MainActor
public func frame(_ id: UInt64, _ x: Double, _ y: Double, _ width: Double, _ height: Double, _ scale: Double) {
    precondition(Thread.isMainThread)
    guard let host = hosts[id], !host.closed, let parent = host.view.superview, width > 0, height > 0, scale > 0 else { return }
    host.waitingKind = 8
    host.view.frame = NSRect(x: x, y: parent.isFlipped ? y : parent.bounds.height - y - height, width: width, height: height)
    host.view.fitToSize(); host.advanceFence()
}

@_cdecl("coflux_ghostty_visible") @MainActor
public func visible(_ id: UInt64, _ value: Int32) {
    precondition(Thread.isMainThread)
    guard let host = hosts[id], !host.closed else { return }
    host.view.isHidden = value == 0; host.view.setSurfaceVisible(value != 0)
}

@_cdecl("coflux_ghostty_focus") @MainActor
public func focus(_ id: UInt64, _ value: Int32) {
    precondition(Thread.isMainThread)
    guard let host = hosts[id], !host.closed else { return }
    if value == 0 {
        host.view.unmarkText(); host.view.inputContext?.discardMarkedText()
        if host.view.window?.firstResponder === host.view { host.view.window?.makeFirstResponder(nil) }
    } else if !host.view.isHidden { host.view.window?.makeFirstResponder(host.view) }
}

@_cdecl("coflux_ghostty_access") @MainActor
public func access(_ id: UInt64, _ allowed: Int32, _ epoch: UInt64) {
    precondition(Thread.isMainThread)
    guard let host = hosts[id], !host.closed else { return }
    host.accessEpoch = epoch; host.gate.set(allowed != 0, epoch); host.view.allowsInput = allowed != 0
    if allowed == 0 { host.view.unmarkText(); host.view.inputContext?.discardMarkedText() }
}

@_cdecl("coflux_ghostty_write") @MainActor
public func write(_ id: UInt64, _ bytes: UnsafePointer<UInt8>?, _ count: Int32, _ replay: Int32) -> Int32 {
    precondition(Thread.isMainThread)
    guard count >= 0, count <= 1 << 20, let host = hosts[id], !host.closed, !host.busy else { return 0 }
    let data = bytes.map { Data(bytes: $0, count: Int(count)) } ?? Data()
    host.busy = true
    // receiveResize 回调来自引擎 IO resize 操作。其后 write 争取同一 terminal mutex，不能越过 resize。
    if host.readyForOutput() { host.parse(data, replay: replay != 0) }
    else { host.pending = (data, replay != 0) }
    return 1
}

@_cdecl("coflux_ghostty_reset") @MainActor
public func reset(_ id: UInt64) {
    precondition(Thread.isMainThread)
    guard let host = hosts[id], !host.closed, !host.busy else { return }
    // 重建真实 parser，清除半截 UTF-8/CSI、alt screen、模式与滚屏；不靠 RIS 拼接补救。
    host.revision += 1; host.confirmed = nil; host.waitingKind = 9
    host.view.core.freeSurface(); host.configureSession()
    if host.view.surface == nil { host.emit(5, data: Data("replacement surface 创建失败".utf8)) }
}

@_cdecl("coflux_ghostty_dump") @MainActor
public func dump(_ id: UInt64, _ buffer: UnsafeMutablePointer<UInt8>?, _ capacity: Int32) -> Int32 {
    precondition(Thread.isMainThread)
    guard let host = hosts[id], !host.closed, !host.busy, let text = host.session.readViewportText() else { return -1 }
    let data = Data(text.utf8)
    if let buffer, Int(capacity) >= data.count { data.copyBytes(to: buffer, count: data.count) }
    return Int32(data.count)
}

@_cdecl("coflux_ghostty_pump") @MainActor
public func pump() {
    precondition(Thread.isMainThread)
    for host in Array(hosts.values) where !host.closed { host.controller.tick() }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.002))
}

// 编辑菜单通过宿主显式调用，不让默认 paste: 读取本地文件路径。
@_cdecl("coflux_ghostty_clipboard") @MainActor
public func clipboard(_ id: UInt64, _ paste: Int32) {
    guard let host = hosts[id], !host.closed else { return }
    if paste != 0 { host.view.pasteTextOnly() } else { _ = host.view.copySelectedTextToPasteboard() }
}

@_cdecl("coflux_ghostty_has_focus") @MainActor
public func hasFocus(_ id: UInt64) -> Int32 {
    guard let host = hosts[id], !host.closed else { return 0 }
    return host.view.window?.firstResponder === host.view ? 1 : 0
}

@_cdecl("coflux_ghostty_allocated_bytes") @MainActor
public func allocatedBytes(_ id: UInt64) -> Double {
    guard let host = hosts[id], !host.closed, let device = host.view.metalLayer?.device else { return -1 }
    // device 总额，不是 surface 私有额；宿主聚合取 max，不能把多个 Tab 重复相加。
    return Double(device.currentAllocatedSize)
}

// 只由原生验收脚本调用；不暴露给 preload。覆盖 keyEquivalent/keyDown 重复分发和 keyUp 抑制。
@_cdecl("coflux_ghostty_test_command_key") @MainActor
public func testCommandKey(_ id: UInt64, _ code: UInt16, _ timestamp: Double) {
    guard let host = hosts[id], !host.closed,
          let down = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command],
            timestamp: timestamp, windowNumber: host.view.window?.windowNumber ?? 0, context: nil,
            characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: code),
          let up = NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: [],
            timestamp: timestamp + 0.001, windowNumber: host.view.window?.windowNumber ?? 0, context: nil,
            characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: code)
    else { return }
    _ = host.view.performKeyEquivalent(with: down)
    host.view.keyDown(with: down)
    host.view.keyUp(with: up)
}

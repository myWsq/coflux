import AppKit
import GhosttyKit

// 独立原生接线验收：不登录、不创建本地 PTY、不读取用户 Ghostty 配置。
final class ByteRecorder: @unchecked Sendable {
    let lock = NSLock()
    var bytes = Data()
    var columns: UInt32 = 0
    var rows: UInt32 = 0
    func append(_ data: Data) { lock.lock(); defer { lock.unlock() }; bytes.append(data) }
    func resize(_ columns: UInt32, _ rows: UInt32) { lock.lock(); defer { lock.unlock() }; self.columns = columns; self.rows = rows }
    func snapshot() -> (Data, UInt32, UInt32) { lock.lock(); defer { lock.unlock() }; return (bytes, columns, rows) }
}

@MainActor final class Harness {
    var app: ghostty_app_t?
    var surface: ghostty_surface_t?
    let recorder = ByteRecorder()
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 420), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 420))

    func start() {
        guard ghostty_init(0, nil) == 0, let config = ghostty_config_new() else { fatalError("Ghostty 初始化失败") }
        ghostty_config_finalize(config)
        defer { ghostty_config_free(config) }
        var runtime = ghostty_runtime_config_s()
        runtime.userdata = Unmanaged.passUnretained(self).toOpaque()
        runtime.wakeup_cb = { pointer in
            guard let pointer else { return }
            let value = UInt(bitPattern: pointer)
            DispatchQueue.main.async {
                let harness = Unmanaged<Harness>.fromOpaque(UnsafeMutableRawPointer(bitPattern: value)!).takeUnretainedValue()
                if let app = harness.app { ghostty_app_tick(app) }
            }
        }
        runtime.action_cb = { _, _, _ in true }
        runtime.read_clipboard_cb = { _, _, _, _, _, _ in GHOSTTY_CLIPBOARD_READ_UNAVAILABLE }
        runtime.confirm_read_clipboard_cb = { _, _, _, _ in }
        runtime.write_clipboard_cb = { _, _, _, _, _ in }
        runtime.close_surface_cb = { _, _ in }
        guard let app = ghostty_app_new(&runtime, config) else { fatalError("Ghostty App 初始化失败") }
        self.app = app
        window.contentView = view
        window.title = "Coflux Ghostty 原生接线验证"
        window.makeKeyAndOrderFront(nil)
        var io = ghostty_external_io_s()
        io.userdata = Unmanaged.passUnretained(recorder).toOpaque()
        io.write = { pointer, bytes, count in
            guard let pointer, let bytes else { return }
            Unmanaged<ByteRecorder>.fromOpaque(pointer).takeUnretainedValue().append(Data(bytes: bytes, count: count))
        }
        io.resize = { pointer, columns, rows in
            guard let pointer else { return }
            Unmanaged<ByteRecorder>.fromOpaque(pointer).takeUnretainedValue().resize(columns, rows)
        }
        var options = ghostty_surface_config_new()
        options.platform_tag = GHOSTTY_PLATFORM_MACOS
        options.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(view).toOpaque()))
        options.scale_factor = window.backingScaleFactor
        options.font_size = 12
        self.surface = withUnsafePointer(to: &io) { ioPointer in
            options.external_io = ioPointer
            return ghostty_surface_new(app, &options)
        }
        guard let surface else { fatalError("Ghostty Surface 初始化失败") }
        ghostty_surface_set_size(surface, 1600, 840)
        ghostty_surface_set_focus(surface, true)
        let output = Array("\u{1b}[32mcoflux:中文😀 Ghostty Metal\u{1b}[0m\r\n".utf8)
        output.withUnsafeBufferPointer { ghostty_surface_feed(surface, $0.baseAddress!, $0.count) }
        "remote-input".withCString { ghostty_surface_text(surface, $0, 12) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.verify() }
    }

    func verify() {
        guard let surface else { fatalError("表面已释放") }
        let action = "select_all"
        let selected = action.withCString { ghostty_surface_binding_action(surface, $0, UInt(action.utf8.count)) }
        var result = ghostty_text_s()
        guard selected, ghostty_surface_read_selection(surface, &result), let pointer = result.text else { fatalError("选择复制不可用") }
        let text = String(decoding: UnsafeBufferPointer(start: UnsafeRawPointer(pointer).assumingMemoryBound(to: UInt8.self), count: Int(result.text_len)), as: UTF8.self)
        ghostty_surface_free_text(surface, &result)
        precondition(text.contains("coflux:中文😀 Ghostty Metal"), text)
        let (input, columns, rows) = recorder.snapshot()
        precondition(String(decoding: input, as: UTF8.self).contains("remote-input"))
        precondition(columns > 0 && rows > 0)
        precondition(ghostty_surface_foreground_pid(surface) == 0, "不得创建本地 shell")
        print("GHOSTTY_REMOTE_IO_OK cols=\(columns) rows=\(rows) bytes=\(input.count) selected=\(text)")
        ghostty_surface_free(surface); self.surface = nil
        if let app { ghostty_app_free(app); self.app = nil }
        window.orderOut(nil)
        exit(0)
    }
}
@main struct SmokeMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let harness = Harness()
        harness.start()
        withExtendedLifetime(harness) { application.run() }
    }
}

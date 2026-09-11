import AppKit
import GhosttyKit
@testable import GhosttyTerminal

// spike 固定 revision：公开封装未开放 replay/raw surface，通过 enable-testing 访问内部接口。
public typealias HostCallback = @convention(c) (UInt64, Int32, UnsafePointer<UInt8>?, Int32, Double, Double) -> Void

@MainActor private var hosts: [UInt64: Host] = [:]
@MainActor private var nextID: UInt64 = 0

@MainActor private final class Host: TerminalSurfaceOpenURLDelegate {
    let id: UInt64
    let callback: HostCallback
    let view: AppTerminalView
    let controller = TerminalController(configSource: .none)
    var session: InMemoryTerminalSession!
    var closed = false
    var busy = false
    var smokeWindow: NSWindow?

    init(id: UInt64, callback: @escaping HostCallback, parent: NSView, rect: NSRect) {
        self.id = id
        self.callback = callback
        view = AppTerminalView(frame: rect)
        session = InMemoryTerminalSession(write: { data in
            DispatchQueue.main.async {
                guard let host = hosts[id], !host.closed else { return }
                host.emit(2, data: data)
            }
        }, resize: { viewport in
            DispatchQueue.main.async {
                guard let host = hosts[id], !host.closed else { return }
                host.emit(3, x: Double(viewport.columns), y: Double(viewport.rows))
            }
        })
        view.delegate = self
        view.configuration = TerminalSurfaceOptions(backend: .inMemory(session))
        view.controller = controller
        parent.addSubview(view, positioned: .above, relativeTo: nil)
    }

    func emit(_ kind: Int32, data: Data = Data(), x: Double = 0, y: Double = 0) {
        guard !closed else { return }
        data.withUnsafeBytes { bytes in
            callback(id, kind, bytes.baseAddress?.assumingMemoryBound(to: UInt8.self), Int32(bytes.count), x, y)
        }
    }

    func terminalDidRequestOpenURL(_ url: String, kind: TerminalOpenURLKind) {
        emit(4, data: Data(url.utf8))
    }

    func destroy() {
        closed = true
        view.setSurfaceVisible(false)
        view.removeFromSuperview()
        if !busy { releaseSurface() }
    }

    func releaseSurface() {
        view.core.freeSurface()
        smokeWindow?.close()
        smokeWindow = nil
        hosts.removeValue(forKey: id)
    }
}

@_cdecl("coflux_ghostty_create")
@MainActor
public func create(_ handle: UnsafeMutableRawPointer?, _ x: Double, _ y: Double,
                   _ width: Double, _ height: Double, _ scale: Double,
                   _ callback: @escaping HostCallback) -> UInt64 {
    guard Thread.isMainThread, width > 0, height > 0, scale > 0 else { return 0 }
    return MainActor.assumeIsolated {
        let parent: NSView
        var window: NSWindow?
        if let handle {
            // Electron getNativeWindowHandle() 返回 NSView*，不是 NSWindow*。
            parent = Unmanaged<NSView>.fromOpaque(handle).takeUnretainedValue()
        } else {
            TerminalDebugLog.enable([.lifecycle, .metrics])
            _ = NSApplication.shared
            NSApp.setActivationPolicy(.prohibited)
            let hidden = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            hidden.isReleasedWhenClosed = false
            window = hidden
            parent = hidden.contentView!
        }
        nextID += 1
        let rect = NSRect(x: x, y: parent.isFlipped ? y : parent.bounds.height - y - height, width: width, height: height)
        let host = Host(id: nextID, callback: callback, parent: parent, rect: rect)
        host.smokeWindow = window
        hosts[nextID] = host
        guard host.view.surface?.rawValue != nil else {
            print("smoke diagnostics: app=\(host.controller.app != nil), metal=\(MTLCreateSystemDefaultDevice() != nil), configurationIssue=\(host.controller.lastConfigurationIssue ?? "none")")
            host.emit(5, data: Data("Ghostty surface 创建失败".utf8))
            host.destroy()
            return 0
        }
        let id = nextID
        DispatchQueue.main.async {
            guard let current = hosts[id], !current.closed else { return }
            current.emit(1)
        }
        return id
    }
}

@_cdecl("coflux_ghostty_destroy")
public func destroy(_ id: UInt64) {
    precondition(Thread.isMainThread)
    MainActor.assumeIsolated { hosts[id]?.destroy() }
}

@_cdecl("coflux_ghostty_frame")
public func frame(_ id: UInt64, _ x: Double, _ y: Double, _ width: Double, _ height: Double, _ scale: Double) {
    precondition(Thread.isMainThread)
    MainActor.assumeIsolated {
        guard let host = hosts[id], !host.closed, let parent = host.view.superview,
              width > 0, height > 0, scale > 0 else { return }
        host.view.frame = NSRect(x: x, y: parent.isFlipped ? y : parent.bounds.height - y - height, width: width, height: height)
        host.view.fitToSize()
    }
}

@_cdecl("coflux_ghostty_visible")
public func visible(_ id: UInt64, _ value: Int32) {
    precondition(Thread.isMainThread)
    MainActor.assumeIsolated {
        guard let host = hosts[id], !host.closed else { return }
        host.view.isHidden = value == 0
        host.view.setSurfaceVisible(value != 0)
    }
}

@_cdecl("coflux_ghostty_focus")
public func focus(_ id: UInt64, _ value: Int32) {
    precondition(Thread.isMainThread)
    MainActor.assumeIsolated {
        guard let host = hosts[id], !host.closed else { return }
        if value == 0 {
            host.view.unmarkText()
            host.view.inputContext?.discardMarkedText()
            if host.view.window?.firstResponder === host.view { host.view.window?.makeFirstResponder(nil) }
        } else if !host.view.isHidden {
            host.view.window?.makeFirstResponder(host.view)
        }
    }
}

// 返回 1 表示已接收，ack(kind=6) 表示解析完成。一次仅接收一块，避免原生内部形成无界队列。
@_cdecl("coflux_ghostty_write")
public func write(_ id: UInt64, _ bytes: UnsafePointer<UInt8>?, _ count: Int32, _ replay: Int32) -> Int32 {
    precondition(Thread.isMainThread)
    guard count >= 0, count <= 1 << 20 else { return 0 }
    let data = bytes.map { Data(bytes: $0, count: Int(count)) } ?? Data()
    return MainActor.assumeIsolated {
        guard let host = hosts[id], !host.closed, !host.busy,
              let raw = host.view.surface?.rawValue else { return 0 }
        host.busy = true
        // 使用整数跨线程传递不透明指针；busy 持有 Host，destroy 延后释放 raw。
        let address = UInt(bitPattern: raw)
        DispatchQueue.global(qos: .userInitiated).async {
            let surface = UnsafeMutableRawPointer(bitPattern: address)!
            data.withUnsafeBytes { buffer in
                if let pointer = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) {
                    if replay != 0 { ghostty_surface_write_buffer_replay(surface, pointer, UInt(buffer.count)) }
                    else { ghostty_surface_write_buffer(surface, pointer, UInt(buffer.count)) }
                }
            }
            DispatchQueue.main.async {
                guard let current = hosts[id] else { return }
                current.busy = false
                if current.closed { current.releaseSurface() }
                else { current.emit(6, x: Double(count)) }
            }
        }
        return 1
    }
}

@_cdecl("coflux_ghostty_pump")
public func pump() {
    precondition(Thread.isMainThread)
    MainActor.assumeIsolated {
        for host in hosts.values where !host.closed { host.controller.tick() }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.002))
    }
}

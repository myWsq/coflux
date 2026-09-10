import AppKit
import GhosttyKit

@main struct SurfaceLifecycleSmoke {
    @MainActor static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 800, height: 420), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = GhosttyTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 420))
        window.contentView = view; window.title = "Coflux Ghostty 工作台接线验证"; window.makeKeyAndOrderFront(nil)
        var input = Data()
        view.onInput = { input.append($0) }
        view.feed(text: "旧快照\u{1b}[31m\u{1b}[")
        view.pasteUploadedPaths("OLD-INPUT")
        view.resetTerminal()
        view.feed(text: "\u{1b}[32m新快照：中文😀 Ghostty Metal\u{1b}[0m\r\n\u{1b}[?2004h")
        view.pasteUploadedPaths("hello\nworld")
        view.setMarkedText("拼音", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        precondition(view.hasMarkedText())
        view.insertText(NSAttributedString(string: "输入法"), replacementRange: NSRange(location: NSNotFound, length: 0))
        precondition(!view.hasMarkedText())
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            view.bindingAction("select_all")
            let text = view.selectedText() ?? ""
            precondition(text.contains("新快照：中文😀 Ghostty Metal"), text)
            precondition(!text.contains("旧快照"), text)
            let encoded = String(decoding: input, as: UTF8.self)
            precondition(encoded == "\u{1b}[200~hello\nworld\u{1b}[201~输入法", encoded.debugDescription)
            precondition(view.columns > 0 && view.rows > 0)
            precondition(ghostty_surface_foreground_pid(view.surface!) == 0)
            print("GHOSTTY_SURFACE_LIFECYCLE_OK \(view.columns)x\(view.rows) input=\(encoded.debugDescription)")
            if ProcessInfo.processInfo.environment["COFLUX_GHOSTTY_KEEP_WINDOW"] == "1" { return }
            view.closeSurface(); window.orderOut(nil); exit(0)
        }
        withExtendedLifetime(window) { application.run() }
    }
}

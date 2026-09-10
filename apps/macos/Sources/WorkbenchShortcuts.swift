import AppKit
import CofluxProtocol
import SwiftUI

/// 当前 Web standalone 使用纯 Command 和物理键位；不能随输入法或 Dvorak 字符映射漂移。
enum WorkbenchShortcut: Equatable {
    case help, createTerminal, closeTerminal, createWorkspace, previous, next, tab(Int)

    static func resolve(keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> Self? {
        let relevant = modifiers.intersection([.command, .control, .shift, .option])
        guard relevant == .command else { return nil }
        switch keyCode {
        case 44: return .help
        case 17: return .createTerminal
        case 13: return .closeTerminal
        case 45: return .createWorkspace
        case 33: return .previous
        case 30: return .next
        case 18: return .tab(0)
        case 19: return .tab(1)
        case 20: return .tab(2)
        case 21: return .tab(3)
        case 23: return .tab(4)
        case 22: return .tab(5)
        case 26: return .tab(6)
        case 28: return .tab(7)
        case 25: return .tab(8)
        default: return nil
        }
    }
}

/// 在 AppKit 分派给终端前截获；只处理挂载此视图的当前窗口，注销时移除监视器。
struct WorkbenchShortcutMonitor: NSViewRepresentable {
    let model: WorkbenchModel
    func makeNSView(context: Context) -> MonitorView {
        let view = MonitorView()
        view.model = model
        view.install()
        return view
    }
    func updateNSView(_ view: MonitorView, context: Context) { view.model = model }
    static func dismantleNSView(_ view: MonitorView, coordinator: ()) { view.uninstall() }

    final class MonitorView: NSView {
        weak var model: WorkbenchModel?
        private var monitor: Any?
        func install() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, let window = self.window,
                      (event.window === window || event.window?.sheetParent === window),
                      let model = self.model, model.client.authState == .authed,
                      let action = WorkbenchShortcut.resolve(keyCode: event.keyCode, modifiers: event.modifierFlags) else { return event }
                model.performShortcut(action)
                return nil
            }
        }
        func uninstall() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}

extension WorkbenchModel {
    var selectedProject: Coflux_V1_Project? {
        guard let workspace, !workspace.projectID.isEmpty else { return nil }
        return client.projects.first { $0.id == workspace.projectID }
    }
    func performShortcut(_ action: WorkbenchShortcut) {
        switch action {
        case .help: showHelp.toggle()
        case .createTerminal: createTerminal()
        case .closeTerminal: if let task = activeTask { requestClose(task) }
        case .createWorkspace: if let project = selectedProject { dialog = .createWorkspace(project) }
        case .previous: selectRelative(-1)
        case .next: selectRelative(1)
        case .tab(let index): selectTab(index)
        }
    }
}

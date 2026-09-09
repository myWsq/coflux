import AppKit
import SwiftUI

/// 使用 AppKit 的文本输入与 IME，仅接管列表导航命令。
struct NativeSearchField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let onMove: (Int) -> Void
    let onSubmit: () -> Void
    let onCancel: () -> Void
    var onTab: (() -> Void)? = nil
    var onEmptyBackspace: (() -> Void)? = nil
    var onCommandSubmit: (() -> Void)? = nil
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> Field {
        let field = Field()
        field.placeholderString = placeholder
        field.font = .systemFont(ofSize: 13)
        field.delegate = context.coordinator
        field.focusRingType = .none
        return field
    }
    func updateNSView(_ field: Field, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != text { field.stringValue = text }
    }
    final class Field: NSTextField {
        private var focused = false
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil, !focused else { return }
            focused = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.window?.makeFirstResponder(self)
            }
        }
    }
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: NativeSearchField
        init(_ parent: NativeSearchField) { self.parent = parent }
        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            parent.text = field.stringValue
        }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard !textView.hasMarkedText() else { return false }
            if selector == #selector(NSResponder.insertNewline(_:)),
               NSApp.currentEvent?.modifierFlags.contains(.command) == true, let action = parent.onCommandSubmit {
                action(); return true
            }
            if selector == #selector(NSResponder.insertTab(_:)), let action = parent.onTab { action(); return true }
            if selector == #selector(NSResponder.deleteBackward(_:)), parent.text.isEmpty, let action = parent.onEmptyBackspace {
                action(); return true
            }
            switch selector {
            case #selector(NSResponder.moveDown(_:)): parent.onMove(1)
            case #selector(NSResponder.moveUp(_:)): parent.onMove(-1)
            case #selector(NSResponder.insertNewline(_:)): parent.onSubmit()
            case #selector(NSResponder.cancelOperation(_:)): parent.onCancel()
            default: return false
            }
            return true
        }
    }
}

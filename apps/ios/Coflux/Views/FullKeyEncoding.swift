import Foundation

/// A key of the full-size terminal keyboard (`FullTerminalKeyboard`, the tall layout's Mac-layout
/// keyboard). What it sends is decided by `FullKeyEncoder`; the keyboard only tracks fingers.
enum FullKey: Equatable {
    /// A number or symbol key: `base` unshifted, `shifted` with ⇧ (`2` / `@`).
    case character(base: String, shifted: String)
    /// A letter key, stored lower case.
    case letter(String)
    case tab
    case enter
    case backspace
    case space
    case arrow(FullKeyArrow)
    /// ⇧, ctrl or ⌥: latched or held, never sent by itself.
    case modifier(FullKeyModifier)
    /// ⇪: toggles ⇧ between off and locked.
    case capsLock

    /// ⌫ and the arrows repeat while held.
    var repeats: Bool {
        switch self {
        case .backspace, .arrow: true
        default: false
        }
    }
}

/// The four arrow keys, with the final byte of their xterm sequence.
enum FullKeyArrow: Equatable {
    case up, down, left, right

    var letter: String {
        switch self {
        case .up: "A"
        case .down: "B"
        case .right: "C"
        case .left: "D"
        }
    }
}

/// The keyboard's three modifiers.
enum FullKeyModifier: CaseIterable, Hashable {
    case shift, control, option
}

/// The modifiers that apply to one key press.
struct FullKeyModifiers: Equatable {
    var shift = false
    var ctrl = false
    var alt = false
}

/// Maps a key press to the bytes a terminal expects (plan D4): plain xterm encoding, never the
/// kitty `CSI … u` form for ordinary keys, so Claude Code, a shell and vim all read the same
/// bytes. The one exception is ⇧⏎ / ⌥⏎ while the program pushed kitty keyboard flags, where the
/// legacy `ESC CR` would be ambiguous.
enum FullKeyEncoder {
    /// The bytes for `key` under `modifiers`; nil sends nothing (the modifiers and ⇪ themselves).
    /// `applicationCursor` is the terminal's DECCKM; `keyboardEnhanced` whether its program pushed
    /// any kitty keyboard flags.
    static func bytes(
        for key: FullKey,
        modifiers: FullKeyModifiers,
        applicationCursor: Bool,
        keyboardEnhanced: Bool
    ) -> String? {
        switch key {
        case .letter(let letter):
            let base = letter.lowercased()
            let typed: String
            if modifiers.ctrl, let control = controlCode(base) {
                typed = control
            } else {
                typed = modifiers.shift ? base.uppercased() : base
            }
            return withOption(typed, modifiers)
        case .character(let base, let shifted):
            var typed = modifiers.shift ? shifted : base
            // ctrl on a symbol without a control code types the symbol unchanged.
            if modifiers.ctrl, let control = controlCode(base) { typed = control }
            return withOption(typed, modifiers)
        case .space:
            if modifiers.ctrl { return "\u{00}" }
            return withOption(" ", modifiers)
        case .tab:
            return modifiers.shift ? "\u{1b}[Z" : "\t"
        case .enter:
            guard modifiers.shift || modifiers.alt else { return "\r" }
            guard keyboardEnhanced else { return "\u{1b}\r" }
            let code = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0)
            return "\u{1b}[13;\(code)u"
        case .backspace:
            return withOption(modifiers.ctrl ? "\u{08}" : "\u{7f}", modifiers)
        case .arrow(let arrow):
            let code = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0)
            if code > 1 { return "\u{1b}[1;\(code)\(arrow.letter)" }
            return (applicationCursor ? "\u{1b}O" : "\u{1b}[") + arrow.letter
        case .modifier, .capsLock:
            return nil
        }
    }

    /// ⌥ is Meta: an ESC before the key.
    private static func withOption(_ typed: String, _ modifiers: FullKeyModifiers) -> String {
        modifiers.alt ? "\u{1b}" + typed : typed
    }

    /// ctrl + `base`: a letter's C0 code, and the classic codes on `[ \ ] 2 6 -`; nil elsewhere.
    private static func controlCode(_ base: String) -> String? {
        switch base {
        case "[": return "\u{1b}"
        case "\\": return "\u{1c}"
        case "]": return "\u{1d}"
        case "2": return "\u{00}"
        case "6": return "\u{1e}"
        case "-": return "\u{1f}"
        default:
            let scalars = base.unicodeScalars
            guard scalars.count == 1, let scalar = scalars.first,
                  (0x61 ... 0x7A).contains(scalar.value),
                  let control = Unicode.Scalar(scalar.value - 0x60) else { return nil }
            return String(Character(control))
        }
    }
}

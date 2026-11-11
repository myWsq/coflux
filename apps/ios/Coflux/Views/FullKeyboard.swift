import CofluxClientCore
import CofluxProtocol
import SwiftUI
import UIKit

// MARK: - The full keyboard

/// The tall layout's full-size terminal keyboard (mockup
/// `wiki/plans/20261110-ios-inner-tall-keyboard-mockup.html`): a Mac layout whose keys send bytes
/// straight to the active terminal, with no input method in between. It replaces the dock in
/// `ShellLayout.tall`; the other layouts keep `TerminalInputArea`.
///
/// - The Claude row on top (SwiftUI keys): esc, ⇧⇥ 模式, ^C, 粘贴 and 中文 (the compose layer).
///   It is the same whatever the agent is doing (D9).
/// - The five Mac rows below are one UIKit touch surface (`FullKeyBlockView`), so several fingers
///   can press at once (hold ctrl, tap c) and keys send on release.
/// - Space types a space on a tap and talks on a hold.
/// - The secret-request bar floats above the keyboard's top edge, outside its measured height.
struct FullTerminalKeyboard: View {
    let client: CofluxClient
    let task: Coflux_V1_Task?
    /// Every row's height: `flatKeyHeight`, or the share of the region below the fold.
    var keyHeight: CGFloat = Self.flatKeyHeight
    /// The keyboard's measured height (the secret bar left out).
    let onHeight: (CGFloat) -> Void
    /// Open the secret request sheet of the active terminal.
    let onOpenSecret: () -> Void
    /// 中文: the compose layer with the system keyboard.
    let onCompose: () -> Void
    /// Space held to talk; `onDictateMove` gets window coordinates.
    let onDictatePrewarm: () -> Void
    let onDictateBegin: () -> Void
    let onDictateMove: (CGPoint) -> Void
    let onDictateEnd: () -> Void
    let onDictateAbort: () -> Void

    /// The key height fully open (D8).
    static let flatKeyHeight: CGFloat = 48
    static let topPadding: CGFloat = 8
    static let bottomPadding: CGFloat = 8

    /// The key height that lets all six rows share `height` (the laptop pose's region below the
    /// fold), never below the flat one.
    static func keyHeight(filling height: CGFloat) -> CGFloat {
        let rows = height - topPadding - bottomPadding - FullKeyBlockView.rowGap * 5
        return max(flatKeyHeight, (rows / 6).rounded(.down))
    }

    private var sender: TerminalKeySender {
        TerminalKeySender(client: client, task: task)
    }

    private var running: Bool {
        sender.sessionID != nil
    }

    private var pendingSecretName: String? {
        task.flatMap { client.pendingSecretRequests(taskID: $0.id).first?.name }
    }

    var body: some View {
        VStack(spacing: FullKeyBlockView.rowGap) {
            claudeRow
            FullKeyBlock(
                sender: sender,
                keyHeight: keyHeight,
                onDictatePrewarm: onDictatePrewarm,
                onDictateBegin: onDictateBegin,
                onDictateMove: onDictateMove,
                onDictateEnd: onDictateEnd,
                onDictateAbort: onDictateAbort
            )
            .frame(height: FullKeyBlockView.height(keyHeight: keyHeight))
        }
        .padding(.horizontal, TerminalInputArea.sideInset)
        .padding(.top, Self.topPadding)
        .padding(.bottom, Self.bottomPadding)
        .background(Theme.background)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeight($0) }
        // Outside the measured size, just above the keyboard's top edge over the terminal's last
        // line: the bar never resizes the terminal (D10).
        .overlay(alignment: .top) {
            SecretRequestNotice(client: client, task: task, onOpen: onOpenSecret)
                .padding(.horizontal, TerminalInputArea.sideInset)
                .alignmentGuide(.top) { $0[.bottom] }
        }
        .animation(.smooth(duration: 0.2), value: pendingSecretName)
    }

    // MARK: Claude row

    /// esc (7) · ⇧⇥ 模式 (10) · ^C (7) · gap (18) · 粘贴 (7) · 中文 (9), on the block's 58 columns.
    private var claudeRow: some View {
        let height = keyHeight
        // The unit comes from the width offered, never from a measurement of the keys (the
        // layout loop noted in `TerminalInputArea.keyRows`).
        return GeometryReader { proxy in
            let unit = proxy.size.width / FullKeyBlockView.columns
            HStack(spacing: 0) {
                slot(7, unit: unit) {
                    TerminalKey(sender: sender, label: "esc", height: height, functionSurface: true) { "\u{1b}" }
                        .accessibilityLabel("Escape")
                }
                slot(10, unit: unit) {
                    TerminalKey(sender: sender, label: "⇧⇥ 模式", height: height, functionSurface: true) { "\u{1b}[Z" }
                        .accessibilityLabel("Shift Tab，切换模式")
                }
                slot(7, unit: unit) {
                    TerminalKey(sender: sender, label: "^C", style: .destructive, height: height, functionSurface: true) {
                        "\u{03}"
                    }
                    .accessibilityLabel("Control C")
                }
                Color.clear
                    .frame(width: max(0, unit * 18))
                    .accessibilityHidden(true)
                slot(7, unit: unit) {
                    pasteKey(height: height)
                }
                slot(9, unit: unit) {
                    Button(action: onCompose) {
                        KeyCap(label: "中文", height: height, functionSurface: true)
                    }
                    .buttonStyle(KeyPressStyle())
                    .accessibilityLabel("中文输入")
                }
            }
        }
        .frame(height: height)
        .disabled(!running)
        .opacity(running ? 1 : FullKeyBlockView.inertAlpha)
    }

    private func slot(_ span: CGFloat, unit: CGFloat, @ViewBuilder _ key: () -> some View) -> some View {
        key()
            .padding(.horizontal, FullKeyBlockView.keyMargin)
            .frame(width: max(0, unit * span))
    }

    /// 粘贴: an image on the clipboard is uploaded, text is pasted (`TerminalKeySender.paste`).
    /// Pasted text already plays the keys' haptic; every other outcome plays it here.
    private func pasteKey(height: CGFloat) -> some View {
        let sender = sender
        return Button {
            let pasteboard = UIPasteboard.general
            if pasteboard.hasImages || !pasteboard.hasStrings {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            sender.paste()
        } label: {
            KeyCap(label: "粘贴", height: height, functionSurface: true)
        }
        .buttonStyle(KeyPressStyle())
        .disabled(sender.uploading)
        .accessibilityLabel("粘贴")
    }
}

// MARK: - The key block (SwiftUI wrapper)

/// `FullKeyBlockView` in SwiftUI: wires its presses to the active terminal.
private struct FullKeyBlock: UIViewRepresentable {
    let sender: TerminalKeySender
    let keyHeight: CGFloat
    let onDictatePrewarm: () -> Void
    let onDictateBegin: () -> Void
    let onDictateMove: (CGPoint) -> Void
    let onDictateEnd: () -> Void
    let onDictateAbort: () -> Void

    func makeUIView(context: Context) -> FullKeyBlockView {
        FullKeyBlockView()
    }

    func updateUIView(_ view: FullKeyBlockView, context: Context) {
        view.keyHeight = keyHeight
        view.isActive = sender.sessionID != nil
        let sender = sender
        view.onPress = { key, modifiers, repeated in
            Self.press(key, modifiers: modifiers, repeated: repeated, sender: sender)
        }
        view.onDictatePrewarm = onDictatePrewarm
        view.onDictateBegin = onDictateBegin
        view.onDictateMove = onDictateMove
        view.onDictateEnd = onDictateEnd
        view.onDictateAbort = onDictateAbort
    }

    static func dismantleUIView(_ view: FullKeyBlockView, coordinator: ()) {
        view.cancelAllTouches()
    }

    /// Encodes with the active terminal's modes as they are now, then sends. The first press
    /// of a key plays the light haptic (`TerminalKeySender.press`); a held key's repeats do not.
    private static func press(
        _ key: FullKey,
        modifiers: FullKeyModifiers,
        repeated: Bool,
        sender: TerminalKeySender
    ) {
        let registry = TerminalModeRegistry.shared
        let taskID = sender.task?.id
        guard let bytes = FullKeyEncoder.bytes(
            for: key,
            modifiers: modifiers,
            applicationCursor: taskID.map { registry.applicationCursor(taskID: $0) } ?? false,
            keyboardEnhanced: taskID.map { registry.keyboardEnhanced(taskID: $0) } ?? false
        ) else { return }
        if repeated {
            guard let sessionID = sender.sessionID else { return }
            sender.client.sendInput(sessionID: sessionID, bytes)
        } else {
            sender.press(bytes)
        }
    }
}

// MARK: - The key block (UIKit touch surface)

/// The keyboard's five Mac rows as one multi-touch surface (D3): it lays the keys out on a grid of
/// 58 columns and follows every finger itself, so a modifier held by one finger applies to a key
/// tapped by another, as on a hardware keyboard.
///
///     ` 1 2 3 4 5 6 7 8 9 0 - = ⌫
///     tab q w e r t y u i o p [ ] \
///     ⇪ a s d f g h j k l ; ' ⏎
///     ⇧ z x c v b n m , . / ↑
///     ctrl ⌥ space ← ↓ →
///
/// - A key sends on release, once. A finger that slides more than 6 pt off its key cancels it;
///   a modifier stays held wherever the finger goes.
/// - ⌫ and the arrows held for 0.35 s send at once and then every 80 ms (`RepeatKey`'s timing).
/// - Modifiers (D7): each is off, once or locked, and held while a finger is on it. A tap turns
///   off into once; a second tap within 300 ms locks; a later tap, or a tap on a lock, turns it
///   off. A key sent while a modifier is held applies it and uses that hold, and lifting a used
///   hold leaves the modifier as it was. Every key sent clears the once modifiers. ⇪ toggles ⇧
///   between off and locked.
/// - Space (D6): a tap types a space; held for 0.33 s the microphone prewarms, held for 0.45 s
///   talking begins and the finger's window position streams to the dictation overlay. While
///   talking every other finger is ignored.
final class FullKeyBlockView: UIView {
    /// The grid's width in columns: a letter key takes 4.
    static let columns: CGFloat = 58
    static let rowGap: CGFloat = 6
    /// Each key's inset from its columns on either side.
    static let keyMargin: CGFloat = 3
    static let keyRadius: CGFloat = 12
    /// How far a finger may slide off its key before the key is cancelled.
    static let slop: CGFloat = 6
    /// The whole keyboard while the terminal is not running.
    static let inertAlpha: CGFloat = 0.45
    static let pressedAlpha: CGFloat = 0.6
    /// Two taps on a modifier within this long lock it.
    static let lockInterval: TimeInterval = 0.3
    /// Space held this long prewarms the microphone, this long begins talking (D6).
    static let prewarmDelay: Duration = .milliseconds(330)
    static let talkDelay: Duration = .milliseconds(450)

    /// The block's height for a row height of `keyHeight`.
    static func height(keyHeight: CGFloat) -> CGFloat {
        keyHeight * CGFloat(rows.count) + rowGap * CGFloat(rows.count - 1)
    }

    /// A row item: a key and its width in columns, or an empty span.
    private enum Item {
        case key(FullKey, span: Int)
        case gap(Int)
    }

    private static func characters(_ pairs: [(String, String)]) -> [Item] {
        pairs.map { .key(.character(base: $0.0, shifted: $0.1), span: 4) }
    }

    private static func letters(_ letters: String) -> [Item] {
        letters.map { .key(.letter(String($0)), span: 4) }
    }

    private static let rows: [[Item]] = [
        characters([
            ("`", "~"), ("1", "!"), ("2", "@"), ("3", "#"), ("4", "$"), ("5", "%"), ("6", "^"),
            ("7", "&"), ("8", "*"), ("9", "("), ("0", ")"), ("-", "_"), ("=", "+"),
        ]) + [.key(.backspace, span: 6)],
        [.key(.tab, span: 6)] + letters("qwertyuiop") + characters([("[", "{"), ("]", "}"), ("\\", "|")]),
        [.key(.capsLock, span: 7)] + letters("asdfghjkl") + characters([(";", ":"), ("'", "\"")])
            + [.key(.enter, span: 7)],
        // ↑ straight above ↓; no right ⇧, so the corner above → stays empty (mockup).
        [.key(.modifier(.shift), span: 8)] + letters("zxcvbnm")
            + characters([(",", "<"), (".", ">"), ("/", "?")])
            + [.key(.arrow(.up), span: 5), .gap(5)],
        // Space centred on the board: 15 columns either side of it.
        [
            .key(.modifier(.control), span: 8), .key(.modifier(.option), span: 7), .key(.space, span: 28),
            .key(.arrow(.left), span: 5), .key(.arrow(.down), span: 5), .key(.arrow(.right), span: 5),
        ],
    ]

    /// A key's place on the grid.
    private struct Slot {
        let key: FullKey
        let row: Int
        let column: Int
        let span: Int
    }

    private static let slots: [Slot] = rows.enumerated().flatMap { entry -> [Slot] in
        let (row, items) = entry
        var column = 0
        var slots: [Slot] = []
        for item in items {
            switch item {
            case .key(let key, let span):
                slots.append(Slot(key: key, row: row, column: column, span: span))
                column += span
            case .gap(let span):
                column += span
            }
        }
        return slots
    }

    /// The modifier state of D7, apart from holding.
    private enum Latch {
        case off, once, locked
    }

    /// One finger on the block.
    @MainActor
    private final class TrackedTouch {
        let slot: Int
        /// Slid off its key, or another finger began talking: lifting sends nothing.
        var cancelled = false
        /// A held ⌫ or arrow that started repeating: lifting sends nothing more.
        var repeating = false
        /// A modifier hold that applied to a key: lifting leaves the modifier as it was.
        var used = false
        /// Space held past the prewarm delay: the microphone is open.
        var prewarmed = false
        /// Space held past the talk delay.
        var talking = false
        var timers: [Task<Void, Never>] = []

        init(slot: Int) {
            self.slot = slot
        }

        func stopTimers() {
            timers.forEach { $0.cancel() }
            timers = []
        }
    }

    // MARK: Inputs

    var keyHeight: CGFloat = FullTerminalKeyboard.flatKeyHeight {
        didSet {
            guard keyHeight != oldValue else { return }
            setNeedsLayout()
        }
    }

    /// The terminal runs: keys send. Otherwise the block dims and ignores new touches.
    var isActive = true {
        didSet {
            guard isActive != oldValue else { return }
            alpha = isActive ? 1 : Self.inertAlpha
            if !isActive { cancelTouches(keepingTalk: true) }
            refresh()
        }
    }

    /// A key was sent: the key, the modifiers that apply, and whether it is a held key's repeat.
    var onPress: (FullKey, FullKeyModifiers, Bool) -> Void = { _, _, _ in }
    var onDictatePrewarm: () -> Void = {}
    var onDictateBegin: () -> Void = {}
    /// The talking finger's position in window coordinates.
    var onDictateMove: (CGPoint) -> Void = { _ in }
    var onDictateEnd: () -> Void = {}
    var onDictateAbort: () -> Void = {}

    // MARK: State

    private var caps: [FullKeyCapView] = []
    private var accessibilityKeys: [FullKeyAccessibilityElement] = []
    private var tracked: [ObjectIdentifier: TrackedTouch] = [:]
    private var latches: [FullKeyModifier: Latch] = [:]
    private var lastTap: [FullKeyModifier: TimeInterval] = [:]

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        backgroundColor = .clear
        caps = Self.slots.map { FullKeyCapView(key: $0.key) }
        caps.forEach(addSubview)
        isAccessibilityElement = false
        accessibilityKeys = Self.slots.indices.map { index in
            let element = FullKeyAccessibilityElement(accessibilityContainer: self)
            element.onActivate = { [weak self] in self?.activate(index) ?? false }
            return element
        }
        accessibilityElements = accessibilityKeys
        refresh()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: Layout

    /// Where the key of `slot` is drawn.
    private func keyFrame(_ slot: Slot) -> CGRect {
        let unit = bounds.width / Self.columns
        return CGRect(
            x: CGFloat(slot.column) * unit + Self.keyMargin,
            y: CGFloat(slot.row) * (keyHeight + Self.rowGap),
            width: max(0, CGFloat(slot.span) * unit - Self.keyMargin * 2),
            height: keyHeight
        )
    }

    /// The area that picks the key of `slot` on touch down: its columns and half the row gaps,
    /// so a finger landing between two keys still presses one.
    private func touchArea(_ slot: Slot) -> CGRect {
        let unit = bounds.width / Self.columns
        let top = CGFloat(slot.row) * (keyHeight + Self.rowGap) - Self.rowGap / 2
        return CGRect(
            x: CGFloat(slot.column) * unit,
            y: top,
            width: CGFloat(slot.span) * unit,
            height: keyHeight + Self.rowGap
        )
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (index, slot) in Self.slots.enumerated() {
            let frame = keyFrame(slot)
            caps[index].frame = frame
            accessibilityKeys[index].accessibilityFrameInContainerSpace = frame
        }
    }

    private func slotIndex(at point: CGPoint) -> Int? {
        Self.slots.firstIndex { touchArea($0).contains(point) }
    }

    // MARK: Touches

    private var talking: Bool {
        tracked.values.contains { $0.talking }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            begin(touch)
        }
        refresh()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            guard let entry = tracked[ObjectIdentifier(touch)], !entry.cancelled else { continue }
            if entry.talking {
                onDictateMove(touch.location(in: nil))
                continue
            }
            let slot = Self.slots[entry.slot]
            if case .modifier = slot.key { continue }
            let allowed = keyFrame(slot).insetBy(dx: -Self.slop, dy: -Self.slop)
            if !allowed.contains(touch.location(in: self)) {
                cancel(entry)
            }
        }
        refresh()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            guard let entry = tracked.removeValue(forKey: ObjectIdentifier(touch)) else { continue }
            end(entry)
        }
        refresh()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            guard let entry = tracked.removeValue(forKey: ObjectIdentifier(touch)) else { continue }
            abandon(entry)
        }
        refresh()
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        // Taken off screen mid-press: a prewarmed microphone must be released.
        if newWindow == nil { cancelAllTouches() }
    }

    /// Drops every finger as if the system cancelled them.
    func cancelAllTouches() {
        cancelTouches(keepingTalk: false)
    }

    private func cancelTouches(keepingTalk: Bool) {
        for (id, entry) in tracked where !(keepingTalk && entry.talking) {
            tracked[id] = nil
            abandon(entry)
        }
        refresh()
    }

    private func begin(_ touch: UITouch) {
        guard isActive, !talking, let index = slotIndex(at: touch.location(in: self)) else { return }
        let entry = TrackedTouch(slot: index)
        tracked[ObjectIdentifier(touch)] = entry
        let key = Self.slots[index].key
        if key == .space {
            scheduleTalk(entry)
        } else if key.repeats {
            scheduleRepeat(entry, key: key)
        }
    }

    private func end(_ entry: TrackedTouch) {
        entry.stopTimers()
        if entry.talking {
            onDictateEnd()
            return
        }
        defer {
            if entry.prewarmed { onDictateAbort() }
        }
        guard !entry.cancelled else { return }
        let key = Self.slots[entry.slot].key
        switch key {
        case .modifier(let modifier):
            if !entry.used { tapModifier(modifier) }
        case .capsLock:
            toggleCapsLock()
        default:
            if !entry.repeating { send(key, repeated: false) }
        }
    }

    /// The system took the touch (or the block went away): nothing is sent.
    private func abandon(_ entry: TrackedTouch) {
        entry.stopTimers()
        if entry.talking || entry.prewarmed { onDictateAbort() }
    }

    private func cancel(_ entry: TrackedTouch) {
        entry.cancelled = true
        entry.stopTimers()
        if entry.prewarmed {
            entry.prewarmed = false
            onDictateAbort()
        }
    }

    private func scheduleRepeat(_ entry: TrackedTouch, key: FullKey) {
        let interval = Duration.seconds(RepeatKey.repeatInterval)
        entry.timers.append(Task { [weak self, weak entry] in
            try? await Task.sleep(for: RepeatKey.holdDelay)
            guard !Task.isCancelled, let self, let entry, !entry.cancelled else { return }
            entry.repeating = true
            self.send(key, repeated: false)
            while true {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, !entry.cancelled else { return }
                self.send(key, repeated: true)
            }
        })
    }

    private func scheduleTalk(_ entry: TrackedTouch) {
        entry.timers.append(Task { [weak self, weak entry] in
            try? await Task.sleep(for: Self.prewarmDelay)
            guard !Task.isCancelled, let self, let entry, !entry.cancelled else { return }
            entry.prewarmed = true
            self.onDictatePrewarm()
        })
        entry.timers.append(Task { [weak self, weak entry] in
            try? await Task.sleep(for: Self.talkDelay)
            guard !Task.isCancelled, let self, let entry, !entry.cancelled else { return }
            self.beginTalking(entry)
        })
    }

    private func beginTalking(_ entry: TrackedTouch) {
        entry.talking = true
        // Every other finger is ignored from here on: lifting them sends nothing. A second
        // finger's prewarm shares the one session, so it is not torn down.
        for other in tracked.values where other !== entry {
            other.cancelled = true
            other.prewarmed = false
            other.stopTimers()
        }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onDictateBegin()
        refresh()
    }

    // MARK: Modifiers and sending

    private func latch(_ modifier: FullKeyModifier) -> Latch {
        latches[modifier] ?? .off
    }

    /// A finger is on `modifier` (and was not cancelled).
    private func held(_ modifier: FullKeyModifier) -> Bool {
        tracked.values.contains { !$0.cancelled && Self.slots[$0.slot].key == .modifier(modifier) }
    }

    private func applies(_ modifier: FullKeyModifier) -> Bool {
        latch(modifier) != .off || held(modifier)
    }

    private func tapModifier(_ modifier: FullKeyModifier) {
        let now = CACurrentMediaTime()
        switch latch(modifier) {
        case .locked:
            latches[modifier] = .off
        case .once:
            let recent = now - (lastTap[modifier] ?? 0) < Self.lockInterval
            latches[modifier] = recent ? .locked : .off
        case .off:
            latches[modifier] = .once
        }
        lastTap[modifier] = now
    }

    private func toggleCapsLock() {
        latches[.shift] = latch(.shift) == .locked ? .off : .locked
    }

    /// Sends `key` with the modifiers that apply now, then clears the once modifiers and marks
    /// the held ones used.
    private func send(_ key: FullKey, repeated: Bool) {
        let modifiers = FullKeyModifiers(shift: applies(.shift), ctrl: applies(.control), alt: applies(.option))
        onPress(key, modifiers, repeated)
        for modifier in FullKeyModifier.allCases where latch(modifier) == .once {
            latches[modifier] = .off
        }
        for entry in tracked.values where !entry.cancelled {
            if case .modifier = Self.slots[entry.slot].key { entry.used = true }
        }
        refresh()
    }

    /// VoiceOver's activation: a tap on the key.
    private func activate(_ index: Int) -> Bool {
        guard isActive, !talking else { return false }
        let key = Self.slots[index].key
        switch key {
        case .modifier(let modifier):
            tapModifier(modifier)
        case .capsLock:
            toggleCapsLock()
        default:
            send(key, repeated: false)
        }
        refresh()
        return true
    }

    // MARK: Drawing

    /// Brings every cap and accessibility element in line with the state.
    private func refresh() {
        let shifted = applies(.shift)
        var pressed = Set<Int>()
        var talkingSlot: Int?
        for entry in tracked.values where !entry.cancelled {
            pressed.insert(entry.slot)
            if entry.talking { talkingSlot = entry.slot }
        }
        for (index, slot) in Self.slots.enumerated() {
            var state = FullKeyCapView.State()
            state.pressed = pressed.contains(index)
            state.shifted = shifted
            state.talking = talkingSlot == index
            switch slot.key {
            case .modifier(let modifier):
                state.locked = latch(modifier) == .locked
                state.highlighted = applies(modifier)
            case .capsLock:
                state.locked = latch(.shift) == .locked
                state.highlighted = state.locked
            default:
                break
            }
            caps[index].state = state
            accessibilityKeys[index].update(key: slot.key, state: state, enabled: isActive)
        }
    }
}

// MARK: - A key cap

/// One key's cap on the block: never touched itself, the block follows the fingers.
private final class FullKeyCapView: UIView {
    struct State: Equatable {
        var pressed = false
        /// ⇧ applies: letters upper case, the shifted character large.
        var shifted = false
        /// A modifier that applies (once, held or locked): drawn inverted.
        var highlighted = false
        /// A locked modifier (or ⇪ while ⇧ is locked): inverted with a bar under the glyph.
        var locked = false
        /// Space while talking.
        var talking = false
    }

    var state = State() {
        didSet {
            guard state != oldValue else { return }
            apply()
        }
    }

    let key: FullKey
    /// The key's glyph or word; on a number or symbol key, the unshifted character.
    private let main = UILabel()
    /// A number or symbol key's shifted character, above `main`.
    private let alternate = UILabel()
    /// The space key's microphone.
    private let icon = UIImageView()
    /// Under a locked modifier's glyph.
    private let lockBar = UIView()

    private static let input = UIColor(Theme.input)
    private static let function = UIColor(Theme.secondarySurface)
    private static let border = UIColor(Theme.border)
    private static let foreground = UIColor(Theme.foreground)
    private static let muted = UIColor(Theme.mutedForeground)
    private static let primary = UIColor(Theme.primary)
    private static let primaryForeground = UIColor(Theme.primaryForeground)
    private static let microphone = UIColor(Theme.microphone)

    init(key: FullKey) {
        self.key = key
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.cornerRadius = FullKeyBlockView.keyRadius
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        for label in [main, alternate] {
            label.textAlignment = .center
            label.adjustsFontSizeToFitWidth = true
            label.minimumScaleFactor = 0.6
            addSubview(label)
        }
        alternate.isHidden = true
        icon.contentMode = .center
        icon.isHidden = true
        addSubview(icon)
        lockBar.layer.cornerRadius = 1.25
        lockBar.isHidden = true
        addSubview(lockBar)
        switch key {
        case .character:
            alternate.isHidden = false
        case .space:
            icon.isHidden = false
            icon.image = UIImage(
                systemName: "mic",
                withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .medium)
            )
            main.text = "按住说话"
            main.font = Theme.Fonts.FullKeyboard.hint
        case .tab:
            main.text = "tab"
            main.font = Theme.Fonts.FullKeyboard.function
        case .modifier(.control):
            main.text = "ctrl"
            main.font = Theme.Fonts.FullKeyboard.function
        default:
            main.text = Self.glyph(key)
            main.font = Theme.Fonts.FullKeyboard.symbol
        }
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// A one-glyph key's cap.
    private static func glyph(_ key: FullKey) -> String {
        switch key {
        case .enter: "⏎"
        case .backspace: "⌫"
        case .capsLock: "⇪"
        case .modifier(.shift): "⇧"
        case .modifier(.option): "⌥"
        case .arrow(.up): "↑"
        case .arrow(.down): "↓"
        case .arrow(.left): "←"
        case .arrow(.right): "→"
        default: ""
        }
    }

    private var isFunction: Bool {
        switch key {
        case .character, .letter, .space, .enter: false
        default: true
        }
    }

    private func apply() {
        let inverted = state.highlighted || state.locked || key == .enter
        let fill: UIColor
        let stroke: UIColor
        let ink: UIColor
        if state.talking {
            fill = Self.microphone.withAlphaComponent(0.16)
            stroke = Self.microphone.withAlphaComponent(0.45)
            ink = Self.microphone
        } else if inverted {
            fill = Self.primary
            stroke = .clear
            ink = Self.primaryForeground
        } else {
            fill = isFunction ? Self.function : Self.input
            stroke = Self.border
            ink = key == .space ? Self.muted : Self.foreground
        }
        backgroundColor = fill
        layer.borderColor = stroke.cgColor
        main.textColor = ink
        icon.tintColor = ink
        lockBar.backgroundColor = ink
        lockBar.isHidden = !state.locked

        switch key {
        case .letter(let letter):
            main.text = state.shifted ? letter.uppercased() : letter
            main.font = Theme.Fonts.FullKeyboard.letter
        case .character(let base, let shifted):
            // The shifted character stays above the base one; ⇧ swaps which one is large.
            alternate.text = shifted
            main.text = base
            alternate.font = state.shifted ? Theme.Fonts.FullKeyboard.character : Theme.Fonts.FullKeyboard.alternate
            alternate.textColor = state.shifted ? Self.foreground : Self.muted
            main.font = state.shifted ? Theme.Fonts.FullKeyboard.alternate : Theme.Fonts.FullKeyboard.character
            main.textColor = state.shifted ? Self.muted : Self.foreground
        case .space:
            icon.image = UIImage(
                systemName: state.talking ? "mic.fill" : "mic",
                withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .medium)
            )
        default:
            break
        }

        UIView.animate(withDuration: 0.08, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.alpha = self.state.pressed ? FullKeyBlockView.pressedAlpha : 1
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let inset = bounds.insetBy(dx: 4, dy: 2)
        switch key {
        case .character:
            let top = alternate.sizeThatFits(inset.size)
            let bottom = main.sizeThatFits(inset.size)
            let gap: CGFloat = 3
            let total = top.height + gap + bottom.height
            let y = bounds.midY - total / 2
            alternate.frame = CGRect(x: inset.minX, y: y, width: inset.width, height: top.height)
            main.frame = CGRect(x: inset.minX, y: y + top.height + gap, width: inset.width, height: bottom.height)
        case .space:
            let gap: CGFloat = 7
            let iconSize = icon.image?.size ?? .zero
            let text = main.sizeThatFits(inset.size)
            let width = min(inset.width, iconSize.width + gap + text.width)
            let x = bounds.midX - width / 2
            icon.frame = CGRect(x: x, y: bounds.midY - iconSize.height / 2, width: iconSize.width, height: iconSize.height)
            main.frame = CGRect(
                x: x + iconSize.width + gap,
                y: bounds.midY - text.height / 2,
                width: max(0, width - iconSize.width - gap),
                height: text.height
            )
        default:
            main.frame = inset
        }
        lockBar.frame = CGRect(x: bounds.midX - 8, y: bounds.maxY - 7 - 2.5, width: 16, height: 2.5)
    }
}

// MARK: - Accessibility

/// One key for VoiceOver: its frame on the block, its name, and a tap as its activation.
private final class FullKeyAccessibilityElement: UIAccessibilityElement {
    var onActivate: () -> Bool = { false }

    override func accessibilityActivate() -> Bool {
        onActivate()
    }

    func update(key: FullKey, state: FullKeyCapView.State, enabled: Bool) {
        accessibilityLabel = Self.label(key, shifted: state.shifted)
        accessibilityTraits = enabled ? [.keyboardKey] : [.keyboardKey, .notEnabled]
        switch key {
        case .modifier, .capsLock:
            accessibilityValue = state.locked ? "已锁定" : state.highlighted ? "生效一次" : nil
            if state.highlighted { accessibilityTraits.insert(.selected) }
        default:
            accessibilityValue = nil
        }
    }

    private static func label(_ key: FullKey, shifted: Bool) -> String {
        switch key {
        case .letter(let letter): shifted ? letter.uppercased() : letter
        case .character(let base, let alternate): shifted ? alternate : base
        case .tab: "Tab"
        case .enter: "回车"
        case .backspace: "删除"
        case .space: "空格，按住说话"
        case .arrow(.up): "上"
        case .arrow(.down): "下"
        case .arrow(.left): "左"
        case .arrow(.right): "右"
        case .modifier(.shift): "Shift"
        case .modifier(.control): "Control"
        case .modifier(.option): "Option"
        case .capsLock: "大写锁定"
        }
    }
}

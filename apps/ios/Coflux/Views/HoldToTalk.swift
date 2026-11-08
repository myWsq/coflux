import SwiftUI
import UIKit

/// Press-and-hold to talk (plan 064 → 069), attachable to any view: the key row's microphone
/// key carries it.
///
/// - Touch down: after a debounce `onPrewarm` (capture starts early, overlay
///   still hidden). A normal tap (~60–120 ms) lifts before the debounce and never prewarms.
/// - Hold for 0.28 s (LongPressGesture sequenced before a DragGesture — the system's own
///   "long press, then drag", so duration, movement tolerance and tap disambiguation stay the
///   system's): haptic + `onBegin`, then the finger's global position streams to `onMove`.
/// - Lift after a hold: `onEnd`. Lift before it: `onAbort` (the host tears down a prewarmed
///   session; the microphone must be released on this path).
///
/// Pair it with an `.onTapGesture` applied before it: the system disambiguates the tap from the
/// hold. It does not reach a toolbar `Button`, which the system turns into a bar button item.
struct HoldToTalk: ViewModifier {
    let onPrewarm: () -> Void
    let onBegin: () -> Void
    let onMove: (CGPoint) -> Void
    let onEnd: () -> Void
    let onAbort: () -> Void

    @State private var active = false
    @State private var prewarmTask: Task<Void, Never>?
    /// Resets by itself when the gesture ends or the system cancels it.
    @GestureState private var pressing = false

    /// Shorter than the 0.28 s hold, long enough to filter out every tap.
    private static let prewarmDelay = Duration.milliseconds(120)

    func body(content: Content) -> some View {
        content
            .gesture(gesture)
            .onChange(of: pressing) { _, down in pressChanged(down) }
            // Torn down while still pressed: the GestureState reset never reaches onChange, and a
            // prewarmed session would keep the microphone open in the background.
            .onDisappear { pressChanged(false) }
    }

    private var gesture: some Gesture {
        LongPressGesture(minimumDuration: 0.28)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .global))
            .updating($pressing) { _, state, _ in
                state = true
            }
            .onChanged { value in
                guard case .second(true, let drag) = value else { return }
                if !active {
                    active = true
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    onBegin()
                }
                if let drag { onMove(drag.location) }
            }
            .onEnded { _ in
                guard active else { return }
                active = false
                onEnd()
            }
    }

    private func pressChanged(_ down: Bool) {
        prewarmTask?.cancel()
        prewarmTask = nil
        guard down else {
            onAbort()
            return
        }
        prewarmTask = Task {
            // A cancelled sleep returns at once: check again.
            try? await Task.sleep(for: Self.prewarmDelay)
            guard !Task.isCancelled else { return }
            onPrewarm()
        }
    }
}

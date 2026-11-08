import SwiftUI

/// Clawd's pose on a terminal tab, as on the desktop (`clawd-glyph.tsx`, plan 075): working →
/// gym, waiting for approval or an answer → waving the flag, finished and not yet looked at →
/// confetti, looked at → standing still (gym frame 0).
enum ClawdPose: Equatable {
    case active, raise, rest, idle

    /// The desktop's mapping (`AgentGlyph` in workspace-terminal.tsx). `error` has no pose: the
    /// caller shows the error mark instead.
    init(state: String, seen: Bool) {
        switch state {
        case "active": self = .active
        case "approval", "question": self = .raise
        case "done", "waiting": self = seen ? .idle : .rest
        default: self = .idle
        }
    }

    fileprivate var sheet: ClawdSheet {
        switch self {
        case .active, .idle: .gym
        case .raise: .flag
        case .rest: .confetti
        }
    }
}

/// The frame sheets rendered from the desktop's SVGs by `scripts/render-ios-clawd.mjs`.
enum ClawdSheet: String {
    case gym, flag, confetti

    struct Sheet {
        /// The SVG's view box: what is fitted into the glyph's box.
        let viewBox: CGRect
        /// The union of every frame's bounds — confetti and the flag reach past the view box.
        let bounds: CGRect
        let count: Int
    }
}

/// Clawd, frame by frame with the desktop's timing. The glyph takes `size` × `size` in layout;
/// what reaches outside the character (confetti, the flag) draws over its surroundings, as on
/// the desktop. With Reduce Motion each pose holds one frame.
struct ClawdGlyph: View {
    let pose: ClawdPose
    /// At most `ClawdSheet.renderedGlyphSize`, so the frames only ever scale down.
    var size: CGFloat = 18
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var frame = 0

    var body: some View {
        let sheet = pose.sheet
        let geometry = ClawdSheet.sheet(sheet)
        let viewBox = geometry.viewBox
        // Fitted like an SVG's default preserveAspectRatio (xMidYMid meet).
        let scale = size / max(viewBox.width, viewBox.height)
        let originX = (size - viewBox.width * scale) / 2 - viewBox.minX * scale
        let originY = (size - viewBox.height * scale) / 2 - viewBox.minY * scale
        Color.clear
            .frame(width: size, height: size)
            .overlay(alignment: .topLeading) {
                Image(String(format: "clawd-%@-%02d", sheet.rawValue, min(frame, geometry.count - 1)))
                    .resizable()
                    .interpolation(.medium)
                    .frame(width: geometry.bounds.width * scale, height: geometry.bounds.height * scale)
                    .offset(x: originX + geometry.bounds.minX * scale, y: originY + geometry.bounds.minY * scale)
                    .allowsHitTesting(false)
            }
            .task(id: TaskKey(pose: pose, reduceMotion: reduceMotion)) {
                await play()
            }
            .accessibilityHidden(true)
    }

    private struct TaskKey: Equatable {
        let pose: ClawdPose
        let reduceMotion: Bool
    }

    private func play() async {
        if reduceMotion {
            frame = Self.stillFrame(pose)
            return
        }
        switch pose {
        case .idle:
            frame = 0
        case .active:
            // 36 frames, 13–24 played twice: 48 beats, then a long hold on the last.
            let sequence = Array(0 ..< 13) + Array(13 ..< 25) + Array(13 ..< 25) + Array(25 ..< 36)
            var index = 0
            while !Task.isCancelled {
                let current = sequence[index]
                frame = current
                let delay: Int
                if index == sequence.count - 1 {
                    delay = 1500
                } else if current == 6 || current == 7 {
                    delay = 270
                } else if current == 15 || current == 21 {
                    delay = 400
                } else {
                    delay = 85
                }
                index = (index + 1) % sequence.count
                try? await Task.sleep(for: .milliseconds(delay))
            }
        case .raise:
            // The wave once from the top, then frames 3…11 over and over.
            await loop(intro: 0, loopFrom: 3, through: 11, every: 100)
        case .rest:
            // Ticks 0…5 bring the two bursts out; 6…13 is the steady loop.
            await loop(intro: 0, loopFrom: 6, through: 13, every: 125)
        }
    }

    private func loop(intro: Int, loopFrom: Int, through last: Int, every milliseconds: Int) async {
        var current = intro
        while !Task.isCancelled {
            frame = current
            current = current == last ? loopFrom : current + 1
            try? await Task.sleep(for: .milliseconds(milliseconds))
        }
    }

    /// The desktop's reduced-motion stills.
    private static func stillFrame(_ pose: ClawdPose) -> Int {
        switch pose {
        case .active: 32
        case .raise: 5
        case .rest, .idle: 0
        }
    }
}

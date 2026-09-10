import SwiftUI

struct AgentCompletionInput: Equatable {
    struct Entry: Equatable { var sessionID: String; var state: String }
    var entries: [Entry]
    var visibleSessionID: String?
}
struct AgentCompletions {
    private(set) var seen = Set<String>()
    mutating func update(_ input: AgentCompletionInput) {
        seen.formIntersection(Set(input.entries.map(\.sessionID)))
        for entry in input.entries {
            if entry.state == "done" || entry.state == "waiting" {
                if entry.sessionID == input.visibleSessionID { seen.insert(entry.sessionID) }
            } else if !entry.state.isEmpty { seen.remove(entry.sessionID) }
        }
    }
}

enum ClawdAnimation {
    enum Pose: String { case active, raise, rest, idle }
    static let gymSequence = Array(0..<13) + Array(13..<25) + Array(13..<25) + Array(25..<36)
    static func pose(state: String, seen: Bool) -> Pose {
        if state == "active" { return .active }
        if state == "approval" || state == "question" { return .raise }
        if (state == "done" || state == "waiting") && !seen { return .rest }
        return .idle
    }
    static func frame(_ pose: Pose, step: Int, frozen: Bool) -> Int {
        if frozen { return pose == .active ? 32 : pose == .raise ? 5 : 0 }
        switch pose {
        case .active: return gymSequence[step % gymSequence.count]
        case .raise: return step < 12 ? step : 3 + (step - 12) % 9
        case .rest: return step < 14 ? step : 6 + (step - 14) % 8
        case .idle: return 0
        }
    }
    static func delay(_ pose: Pose, step: Int) -> Duration {
        if pose == .raise { return .milliseconds(100) }
        if pose == .rest { return .milliseconds(125) }
        let index = step % gymSequence.count, frame = gymSequence[index]
        if index == gymSequence.count - 1 { return .milliseconds(1500) }
        if frame == 6 || frame == 7 { return .milliseconds(270) }
        if frame == 15 || frame == 21 { return .milliseconds(400) }
        return .milliseconds(85)
    }
}

struct AgentGlyph: View {
    let agent: String
    let state: String
    let seen: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var step = 0
    private var pose: ClawdAnimation.Pose { ClawdAnimation.pose(state: state, seen: seen) }
    private var frozen: Bool { reduceMotion || scenePhase != .active || pose == .idle }
    var body: some View {
        Group {
            if agent == "claude" {
                let kind = pose == .raise ? "flag" : pose == .rest ? "confetti" : "gym"
                let width: CGFloat = kind == "gym" ? 158 : kind == "flag" ? 140 : 129
                let height: CGFloat = kind == "gym" ? 128 : kind == "flag" ? 146 : 113
                let scale = 16 / max(width, height)
                Image("clawd-\(kind)-\(ClawdAnimation.frame(pose, step: step, frozen: frozen))")
                    .resizable().interpolation(.none)
                    .frame(width: (width + 200) * scale, height: (height + 200) * scale)
                    .frame(width: 16, height: 16)
            } else {
                Image("bot").renderingMode(.template).resizable().frame(width: 12, height: 12)
                    .foregroundStyle(state == "approval" || state == "question" ? Design.warning : state == "done" ? Design.success : Design.foreground)
            }
        }.accessibilityHidden(true).allowsHitTesting(false)
            .task(id: "\(agent):\(pose.rawValue):\(frozen)") {
                step = 0
                guard agent == "claude", !frozen else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: ClawdAnimation.delay(pose, step: step)) }
                    catch { return }
                    guard !Task.isCancelled else { return }
                    step += 1
                }
            }
    }
}

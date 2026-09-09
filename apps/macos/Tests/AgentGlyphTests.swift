import AppKit
import SwiftUI
import XCTest
@testable import Coflux

final class AgentGlyphTests: XCTestCase {
    func testCompletionRequiresVisibleTerminalAndResetsForNewRound() {
        var state = AgentCompletions()
        state.update(.init(entries: [.init(sessionID: "a", state: "done"), .init(sessionID: "b", state: "waiting")], visibleSessionID: nil))
        XCTAssertTrue(state.seen.isEmpty)
        state.update(.init(entries: [.init(sessionID: "a", state: "done"), .init(sessionID: "b", state: "waiting")], visibleSessionID: "b"))
        XCTAssertEqual(state.seen, ["b"])
        state.update(.init(entries: [.init(sessionID: "a", state: "done"), .init(sessionID: "b", state: "active")], visibleSessionID: "a"))
        XCTAssertEqual(state.seen, ["a"])
        state.update(.init(entries: [.init(sessionID: "new", state: "done")], visibleSessionID: nil))
        XCTAssertTrue(state.seen.isEmpty)
    }
    func testFrameSequenceLoopsAndReducedMotionPoses() {
        XCTAssertEqual(ClawdAnimation.gymSequence.count, 48)
        XCTAssertEqual(ClawdAnimation.frame(.active, step: 48, frozen: false), 0)
        XCTAssertEqual(ClawdAnimation.frame(.raise, step: 12, frozen: false), 3)
        XCTAssertEqual(ClawdAnimation.frame(.rest, step: 14, frozen: false), 6)
        XCTAssertEqual(ClawdAnimation.frame(.active, step: 4, frozen: true), 32)
        XCTAssertEqual(ClawdAnimation.pose(state: "waiting", seen: true), .idle)
        XCTAssertEqual(ClawdAnimation.pose(state: "waiting", seen: false), .rest)
        XCTAssertEqual(ClawdAnimation.delay(.active, step: 47), .milliseconds(1500))
    }
    @MainActor func testAllNativeFramesLoadAndRender() throws {
        for (name, count) in [("gym", 36), ("flag", 12), ("confetti", 14)] {
            for frame in 0..<count { XCTAssertNotNil(NSImage(named: "clawd-\(name)-\(frame)")) }
        }
        XCTAssertNotNil(NSImage(named: "bot"))
        let host = NSHostingView(rootView: HStack(spacing: 24) {
            ForEach(["active", "approval", "question", "done"], id: \.self) { state in
                VStack(spacing: 12) {
                    AgentGlyph(agent: "claude", state: state, seen: false)
                    Text(state)
                }
            }
            VStack(spacing: 12) { AgentGlyph(agent: "claude", state: "done", seen: true); Text("已读") }
            VStack(spacing: 12) { AgentGlyph(agent: "codex", state: "active", seen: false); Text("codex") }
        }.padding(24).frame(width: 640, height: 120).background(Design.panel).foregroundStyle(Design.foreground).preferredColorScheme(.dark))
        host.frame = NSRect(x: 0, y: 0, width: 640, height: 120)
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let file = URL(fileURLWithPath: "/tmp/coflux-native-agent-glyphs.png")
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: file)
    }
    @MainActor func testNativeAnimationAdvancesAndInactiveSceneStaysStill() async throws {
        for paused in [false, true] {
            let host = NSHostingView(rootView: AgentGlyph(agent: "claude", state: "active", seen: false)
                .scaleEffect(4).frame(width: 128, height: 128).background(Design.panel)
                .environment(\.scenePhase, paused ? .inactive : .active))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 128, height: 128), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = host; window.orderFront(nil)
            defer { window.close() }
            func pixels() throws -> Data {
                host.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            }
            try await Task.sleep(for: .milliseconds(50))
            let first = try pixels()
            try await Task.sleep(for: .milliseconds(400))
            let second = try pixels()
            if paused { XCTAssertEqual(first, second, "非活动场景必须静止") }
            else { XCTAssertNotEqual(first, second, "原生视图必须实际切换动画帧") }
        }
    }

}

import AppKit
import Darwin
import GhosttyKit
import XCTest
@testable import Coflux

@MainActor
final class TerminalPerformanceTests: XCTestCase {
    private final class ReleaseProbe {
        weak var view: GhosttyTerminalView?
        weak var pump: TerminalOutputPump?
        init(view: GhosttyTerminalView, pump: TerminalOutputPump) { self.view = view; self.pump = pump }
    }

    func testRepeatedTerminalReleaseDoesNotRetainViewsOrPumps() async throws {
        let baseline = try physicalFootprint()
        let payload = Data(String(repeating: "\u{1b}[32m回收测试 中文😀 abcdefghijklmnopqrstuvwxyz\u{1b}[0m\r\n", count: 5000).utf8)
        for cycle in 1...3 {
            var views = (0..<8).map { _ in configuredTerminal() }
            var pumps = views.map { view in let pump = TerminalOutputPump(); pump.view = view; return pump }
            let probes = zip(views, pumps).map { ReleaseProbe(view: $0.0, pump: $0.1) }
            pumps.forEach { $0.enqueue(payload + Data("RELEASE-COMPLETE\r\n".utf8), replace: false) }
            let deadline = ContinuousClock.now + .seconds(15)
            while pumps.contains(where: { $0.pendingBytes > 0 }) {
                guard ContinuousClock.now < deadline else { return XCTFail("回收测试输出未排空") }
                try await Task.sleep(for: .milliseconds(5))
            }
            let filled = try withExtendedLifetime(views) { try physicalFootprint() }
            for view in views {
                XCTAssertTrue(view.readText().contains("RELEASE-COMPLETE"))
            }
            pumps.forEach { $0.clear() }
            pumps.removeAll(); views.removeAll()
            let releaseDeadline = ContinuousClock.now + .seconds(3)
            while probes.contains(where: { $0.view != nil || $0.pump != nil }), ContinuousClock.now < releaseDeadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertTrue(probes.allSatisfy { $0.view == nil }, "终端视图不应在关闭后被保留")
            XCTAssertTrue(probes.allSatisfy { $0.pump == nil }, "输出泵不应在关闭后被保留")
            try await Task.sleep(for: .milliseconds(100))
            print("NATIVE_TERMINAL_RELEASE cycle=\(cycle) baselineBytes=\(baseline) filledBytes=\(filled) releasedBytes=\(try physicalFootprint())")
        }
    }

    private func physicalFootprint() throws -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { throw NSError(domain: "MachTaskInfo", code: Int(result)) }
        return info.phys_footprint
    }

    private func configuredTerminal() -> GhosttyTerminalView {
        let view = NativeTerminal.configuredView()
        view.setFrameSize(NSSize(width: 1000, height: 600))
        return view
    }

    func testConcurrentTerminalOutputKeepsMainActorResponsiveAndIndependent() async throws {
        try await concurrentOutput(visible: false)
    }

    func testVisibleTerminalOutputKeepsMainActorResponsiveAndIndependent() async throws {
        try await concurrentOutput(visible: true)
    }

    private func concurrentOutput(visible: Bool) async throws {
        let memoryBefore = try physicalFootprint()
        let views = (0..<8).map { _ in configuredTerminal() }
        let pumps = views.map { view in let pump = TerminalOutputPump(); pump.view = view; return pump }
        let window: NSWindow? = visible ? NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 600),
            styleMask: [.titled], backing: .buffered, defer: false) : nil
        if let window {
            window.isReleasedWhenClosed = false
            window.title = "原生终端可见负载验收"
            window.contentView = views[0]
            for view in views.dropFirst() { view.setSurfaceVisible(false) }
            window.makeKeyAndOrderFront(nil)
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
        }
        defer {
            pumps.forEach { $0.clear() }
            window?.orderOut(nil); window?.contentView = nil; window?.close()
        }
        var largestHeartbeatGap = 0.0
        var heartbeats = 0
        let heartbeat = Task { @MainActor in
            var previous = ContinuousClock.now
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(2)) } catch { return }
                let now = ContinuousClock.now
                let gap = previous.duration(to: now)
                largestHeartbeatGap = max(largestHeartbeatGap, Double(gap.components.seconds) * 1000 + Double(gap.components.attoseconds) / 1e15)
                previous = now
                heartbeats += 1
            }
        }
        defer { heartbeat.cancel() }
        await Task.yield()
        let started = ContinuousClock.now
        for (index, pump) in pumps.enumerated() {
            let line = "\u{1b}[32m终端 \(index) 中文😀\u{1b}[0m abcdefghijklmnopqrstuvwxyz\r\n"
            pump.enqueue(Data((String(repeating: line, count: 5000) + "COMPLETE-\(index)\r\n").utf8), replace: false)
        }
        let deadline = started + .seconds(20)
        while pumps.contains(where: { $0.pendingBytes > 0 }), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        // 在提取buffer为测试字符串之前采样，避免把断言用的全文副本算进输出负载。
        let completed = ContinuousClock.now
        // 完成后至少再观察一次心跳，覆盖最后一批占用；不把全文断言计入心跳延迟。
        let finalBeat = heartbeats
        while heartbeats == finalBeat {
            try await Task.sleep(for: .milliseconds(1))
        }
        heartbeat.cancel()
        let memoryAfter = try physicalFootprint()
        for (index, pump) in pumps.enumerated() {
            XCTAssertEqual(pump.pendingBytes, 0)
            let text = views[index].readText()
            XCTAssertTrue(text.contains("COMPLETE-\(index)"))
            for other in pumps.indices where other != index { XCTAssertFalse(text.contains("COMPLETE-\(other)")) }
        }
        XCTAssertGreaterThan(heartbeats, 0)
        print("NATIVE_TERMINAL_CONCURRENT visible=\(visible) count=8 largestHeartbeatGapMS=\(largestHeartbeatGap) heartbeats=\(heartbeats) elapsed=\(started.duration(to: completed)) cols=\(views[0].columns) rows=\(views[0].rows)")
        print("NATIVE_TERMINAL_DRAIN totalMS=\(pumps.reduce(0) { $0 + $1.totalDrainMS }) slices=\(pumps.reduce(0) { $0 + $1.sliceCount }) largestSliceMS=\(pumps.map(\.largestSliceMS).max() ?? 0)")
        print("NATIVE_TERMINAL_MEMORY count=8 linesPerTerminal=5000 beforeBytes=\(memoryBefore) afterBytes=\(memoryAfter) deltaBytes=\(Int64(memoryAfter) - Int64(memoryBefore))")
    }

    func testTerminalBurstBaseline() throws {
        let view = configuredTerminal()
        let line = "\u{1b}[32mcoflux 中文 output\u{1b}[0m 0123456789 abcdefghijklmnopqrstuvwxyz\r\n"
        let data = Data((String(repeating: line, count: 5000) + "BURST-COMPLETE\r\n").utf8)
        let start = ContinuousClock.now
        view.feedOutput( ArraySlice(data))
        let elapsed = start.duration(to: .now)
        let milliseconds = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
        XCTAssertTrue(view.readText().contains("BURST-COMPLETE"))
        print("NATIVE_TERMINAL_BASELINE bytes=\(data.count) lines=5000 mainThreadMS=\(milliseconds)")
    }
    func testSlicedOutputPreservesBytesAndSnapshotReplacement() async throws {
        let view = configuredTerminal()
        let pump = TerminalOutputPump(); pump.view = view
        let line = "\u{1b}[32mcoflux 中文 output\u{1b}[0m 0123456789 abcdefghijklmnopqrstuvwxyz\r\n"
        let data = Data((String(repeating: line, count: 5000) + "BURST-COMPLETE\r\n").utf8)
        let start = ContinuousClock.now
        pump.enqueue(data, replace: false)
        let deadline = start + .seconds(10)
        while pump.pendingBytes > 0 {
            guard ContinuousClock.now < deadline else { XCTFail("输出泵未收敛"); return }
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTAssertTrue(view.readText().contains("BURST-COMPLETE"))
        XCTAssertGreaterThan(pump.sliceCount, 0)
        XCTAssertLessThan(pump.largestSliceMS, 20, "单次处理不能长期占用输入线程")
        print("NATIVE_TERMINAL_SLICED bytes=\(data.count) slices=\(pump.sliceCount) largestSliceMS=\(pump.largestSliceMS) elapsed=\(start.duration(to: .now))")
        pump.enqueue(Data("OLD-QUEUED".utf8), replace: false)
        pump.enqueue(Data("NEW-SNAPSHOT".utf8), replace: true)
        pump.enqueue(Data("-TAIL".utf8), replace: false)
        while pump.pendingBytes > 0 { try await Task.sleep(for: .milliseconds(1)) }
        let text = view.readText()
        XCTAssertTrue(text.contains("NEW-SNAPSHOT-TAIL"))
        XCTAssertFalse(text.contains("OLD-QUEUED"))
    }
    func testBackpressureYieldsCancelsAndResumesAfterReplacement() async throws {
        let view = configuredTerminal()
        let pump = TerminalOutputPump(); pump.view = view
        let burst = Data(String(repeating: "负载\r\n", count: 700_000).utf8)
        pump.enqueue(burst, replace: false)
        pump.enqueue(burst, replace: false)
        XCTAssertEqual(pump.pendingBytes, burst.count * 2)
        XCTAssertEqual(pump.sliceCount, 0, "超过阈值也不能同步阻塞主线程")
        var admitted = false
        let receiver = Task { @MainActor in
            try await TerminalOutputPump.waitForReceiveCapacity()
            admitted = true
        }
        try await Task.sleep(for: .milliseconds(10))
        XCTAssertFalse(admitted, "消费不足时不能继续接收")
        receiver.cancel()
        do { try await receiver.value; XCTFail("等待接收必须响应取消") }
        catch is CancellationError {} catch { XCTFail("意外错误：\(error)") }
        pump.enqueue(Data("RECOVERED".utf8), replace: true)
        try await TerminalOutputPump.waitForReceiveCapacity()
        let deadline = ContinuousClock.now + .seconds(5)
        while pump.pendingBytes > 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTAssertEqual(pump.pendingBytes, 0)
        XCTAssertTrue(view.readText().contains("RECOVERED"))
    }

    func testSplitUTF8AndANSIEqualsSynchronousTerminal() async throws {
        let baseline = configuredTerminal()
        let sliced = configuredTerminal()
        let pump = TerminalOutputPump(); pump.view = sliced
        let data = Data((String(repeating: "a", count: 4095) + "中文😀\u{1b}[31m红色\u{1b}[0m\r\n" +
                         String(repeating: "尾行\r\n", count: 200)).utf8)
        baseline.feedOutput( ArraySlice(data))
        // Data 切片可能带非零起始索引，也必须保留跨帧 UTF-8 和 ANSI 解析状态。
        for index in stride(from: 0, to: data.count, by: 4097) {
            pump.enqueue(data[index..<min(index + 4097, data.count)], replace: false)
        }
        let deadline = ContinuousClock.now + .seconds(5)
        while pump.pendingBytes > 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTAssertEqual(pump.pendingBytes, 0)
        XCTAssertEqual(sliced.readText(), baseline.readText())
    }

    func testSustainedOutputDrainsWithReceiveBackpressure() async throws {
        let view = configuredTerminal()
        let pump = TerminalOutputPump(); pump.view = view
        let frame = Data(String(repeating: "持续输出 中文 😀 abcdefghijklmnopqrstuvwxyz\r\n", count: 10_000).utf8)
        let started = ContinuousClock.now
        var peakPending = 0
        for _ in 0..<16 {
            try await TerminalOutputPump.waitForReceiveCapacity()
            pump.enqueue(frame, replace: false)
            peakPending = max(peakPending, pump.pendingBytes)
        }
        pump.enqueue(Data("SUSTAINED-COMPLETE\r\n".utf8), replace: false)
        let deadline = ContinuousClock.now + .seconds(30)
        while pump.pendingBytes > 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTAssertEqual(pump.pendingBytes, 0)
        XCTAssertLessThanOrEqual(peakPending, 4 * 1024 * 1024 + frame.count)
        XCTAssertGreaterThan(pump.sliceCount, 0)
        XCTAssertLessThan(pump.largestSliceMS, 20, "持续输出仍需保留主线程响应预算")
        XCTAssertTrue(view.readText().contains("SUSTAINED-COMPLETE"))
        print("NATIVE_TERMINAL_SUSTAINED bytes=\(frame.count * 16) peakPending=\(peakPending) largestSliceMS=\(pump.largestSliceMS) elapsed=\(started.duration(to: .now))")
    }

}

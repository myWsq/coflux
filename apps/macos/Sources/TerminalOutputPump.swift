import Foundation

/// 小批次处理终端输出，让主线程有机会接收输入；不丢字节，不跨快照重排。
@MainActor
final class TerminalOutputPump {
    weak var view: GhosttyTerminalView?
    private var chunks: [Data?] = []
    private var head = 0
    private var offset = 0
    private(set) var pendingBytes = 0
    private var scheduled = false
    private var resetPending = false
    private var generation = 0
    private(set) var largestSliceMS = 0.0
    private(set) var totalDrainMS = 0.0
    private(set) var sliceCount = 0
    private static var livePumps: [WeakPump] = []
    private final class WeakPump {
        weak var value: TerminalOutputPump?
        init(_ value: TerminalOutputPump) { self.value = value }
    }

    init() { Self.livePumps.append(WeakPump(self)) }

    /// 接收端暂停取下一帧，把背压交回 WebSocket，而不是在主线程同步排空。
    /// 阈值是所有终端的合计；允许已在途的每连接一帧超过阈值。
    static func waitForReceiveCapacity() async throws {
        while true {
            try Task.checkCancellation()
            livePumps.removeAll { $0.value == nil }
            let pending = livePumps.reduce(0) { $0 + ($1.value?.pendingBytes ?? 0) }
            if pending < 4 * 1024 * 1024 { return }
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    func enqueue(_ bytes: Data, replace: Bool) {
        if replace { clear(); resetPending = true }
        if !bytes.isEmpty { chunks.append(bytes); pendingBytes += bytes.count }
        schedule()
    }
    func clear() {
        generation += 1
        chunks.removeAll(keepingCapacity: true)
        head = 0; offset = 0; pendingBytes = 0; resetPending = false; scheduled = false
    }
    private func schedule() {
        guard !scheduled, pendingBytes > 0 || resetPending else { return }
        scheduled = true
        let ticket = generation
        DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == ticket else { return }
            self.scheduled = false
            self.drain()
            self.schedule()
        }
    }
    private func drain() {
        guard let view else { clear(); return }
        Self.livePumps.removeAll { $0.value == nil }
        let contenders = Self.livePumps.reduce(0) { count, item in
            guard let pump = item.value, pump.view != nil else { return count }
            return count + (pump.pendingBytes > 0 || pump.resetPending ? 1 : 0)
        }
        // 多个泵的主队列回调会连续执行，不能让每个终端都独占 4ms。
        // 至少处理一块后让出；单次 Ghostty feed 仍可能超过预算，不能视作硬时限。
        let budget = Duration.nanoseconds(Int64(4_000_000 / max(1, contenders)))
        let start = ContinuousClock.now
        if resetPending { view.resetTerminal(); resetPending = false }
        while head < chunks.count {
            let chunk = chunks[head]!
            let end = min(chunk.count, offset + 4096)
            let bytes = ArraySlice(chunk[(chunk.startIndex + offset)..<(chunk.startIndex + end)])
            view.feedOutput(bytes)
            pendingBytes -= end - offset
            offset = end
            if offset == chunk.count { chunks[head] = nil; head += 1; offset = 0 }
            if start.duration(to: .now) >= budget { break }
        }
        if head == chunks.count { chunks.removeAll(keepingCapacity: true); head = 0 }
        else if head > 128 { chunks.removeFirst(head); head = 0 }
        let duration = start.duration(to: .now)
        let milliseconds = Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
        totalDrainMS += milliseconds
        largestSliceMS = max(largestSliceMS, milliseconds)
        sliceCount += 1
    }
}

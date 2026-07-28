import AVFoundation
import Foundation
import Speech

private struct DictationTimeoutError: Error {}

/// 一次长按对讲的会话状态机（plan 064）。引擎选型只在会话开始时判一次：
/// 豆包 IME 免 key 通道优先，~2.5s 准入超时内未连上则降级 Apple 本地识别，
/// 会话期间不再切换引擎。
@MainActor
final class DictationSession: ObservableObject {
    enum Engine {
        case doubao
        case apple
    }

    enum Phase: Equatable {
        case connecting
        case modelDownloading(progress: Double?)
        case active(Engine)
        case permissionDenied
        case failed(String)
    }

    @Published private(set) var phase: Phase = .connecting
    @Published private(set) var displayText = ""
    @Published private(set) var isVolatile = false

    private let capture = AudioCapture()
    private var provider: (any SpeechTranscribing)?
    private var listenTask: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    /// 快速按下-松开可能在豆包 2.5s 准入判定还没跑完时就要求收尾；每个 await
    /// 挂起点之后都要重新检查这个标志，避免残留连接或重复初始化（真实场景，
    /// 不是臆造的边界情况）。
    private var teardownRequested = false
    /// 准入期（握手/降级判定，最多几百 ms 到 2.5s）采到的音频先攒这里，
    /// provider 就绪后在 feedProvider 里补喂——否则开口前几百 ms 全丢字。
    /// 上限防异常场景无限膨胀（16kHz mono Int16 下 300KB ≈ 9.4s，远超准入窗口）。
    private var pendingPCM: [Data] = []
    private var pendingPCMBytes = 0
    private static let pendingPCMCapBytes = 300 * 1024

    private static let admissionTimeout: UInt64 = 2_500_000_000

    /// 长按触发：包一层 Task 存进 startTask，finish() 靠它等 phase 落定
    /// （权限被拒/引擎失败都在 start() 内部同步设置，await 它就不会读到
    /// 过期的 .connecting）。
    func begin() {
        startTask = Task { await self.start() }
    }

    private func start() async {
        guard await Self.requestMicPermission() else {
            phase = .permissionDenied
            return
        }
        let speechGranted = await Self.requestSpeechPermission()
        guard !teardownRequested else { return }

        do {
            try capture.start()
        } catch {
            phase = .failed("无法打开麦克风")
            return
        }
        capture.onPCM = { [weak self] data in
            Task { await self?.feedProvider(data) }
        }
        guard !teardownRequested else {
            capture.stop()
            return
        }

        let doubao = DoubaoIMEProvider()
        do {
            try await Self.withTimeout(Self.admissionTimeout) { try await doubao.start() }
            guard !teardownRequested else {
                await doubao.cancel()
                capture.stop()
                return
            }
            provider = doubao
            phase = .active(.doubao)
            pump(doubao)
            return
        } catch {
            await doubao.cancel()
        }

        guard !teardownRequested else {
            capture.stop()
            return
        }
        guard speechGranted else {
            phase = .permissionDenied
            capture.stop()
            return
        }
        guard #available(iOS 26.0, *) else {
            phase = .failed("语音识别暂不可用")
            capture.stop()
            return
        }

        let apple = AppleSpeechProvider()
        do {
            try await apple.start()
            guard !teardownRequested else {
                await apple.cancel()
                capture.stop()
                return
            }
            provider = apple
            phase = .active(.apple)
            pump(apple)
        } catch {
            phase = .failed("语音识别暂不可用")
            capture.stop()
        }
    }

    /// 上滑取消：不等终稿，尽快断开
    func cancel() {
        guard !teardownRequested else { return }
        teardownRequested = true
        listenTask?.cancel()
        capture.stop()
        if let provider {
            Task { await provider.cancel() }
        }
    }

    /// 松手结束：等 start() 把 phase 落定（权限拒绝/引擎失败也在此刻才能读到
    /// 准确值），再请求引擎给出终稿，最多等 2s，返回已转写文字（不含首尾空白）。
    /// 收尾强制调 provider.cancel() 关 ws/结束 listenTask：SessionFinished
    /// 丢包或超时都不该让连接悬挂到服务端自己断（cancel 内部已改幂等）。
    func finish() async -> String {
        guard !teardownRequested else { return displayText.trimmingCharacters(in: .whitespacesAndNewlines) }
        teardownRequested = true
        await startTask?.value
        capture.stop()
        await provider?.finish()
        if let task = listenTask {
            _ = try? await Self.withTimeout(2_000_000_000) { await task.value }
        }
        await provider?.cancel()
        return displayText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func feedProvider(_ data: Data) async {
        guard let provider else {
            pendingPCM.append(data)
            pendingPCMBytes += data.count
            while pendingPCMBytes > Self.pendingPCMCapBytes, !pendingPCM.isEmpty {
                pendingPCMBytes -= pendingPCM.removeFirst().count
            }
            return
        }
        if !pendingPCM.isEmpty {
            let backlog = pendingPCM
            pendingPCM.removeAll()
            pendingPCMBytes = 0
            // ponytail: actor 重入下背压帧与几乎同时到达的新帧理论上可能交错
            // （排空期间 MainActor 可能先处理另一路 feedProvider 调用），实践中
            // 窗口 < 一帧（20ms），ASR 对此不敏感；要严格保序需单一串行发送
            // 队列，量级不值当。
            for chunk in backlog {
                await provider.feed(pcm: chunk)
            }
        }
        await provider.feed(pcm: data)
    }

    private func pump(_ provider: any SpeechTranscribing) {
        listenTask = Task { [weak self] in
            for await event in provider.events {
                await self?.apply(event)
            }
        }
    }

    private func apply(_ event: SpeechTranscriptEvent) {
        switch event {
        case .volatile(let text):
            displayText = text
            isVolatile = true
        case .finalized(let text):
            displayText = text
            isVolatile = false
        case .modelDownloading(let progress):
            phase = .modelDownloading(progress: progress)
        case .failed(let message):
            phase = .failed(message)
        case .closed:
            break
        }
    }

    private static func requestMicPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    private static func requestSpeechPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    private static func withTimeout<T: Sendable>(
        _ nanoseconds: UInt64, operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: nanoseconds)
                throw DictationTimeoutError()
            }
            guard let result = try await group.next() else {
                throw DictationTimeoutError()
            }
            group.cancelAll()
            return result
        }
    }
}

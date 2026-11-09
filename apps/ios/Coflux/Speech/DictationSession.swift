import AVFoundation
import CofluxClientCore
import Foundation
import UIKit

private struct DictationTimeoutError: Error {}

/// 一次长按对讲的会话状态机（plan 064 → 20261108-ios-seed-asr → 20261109-speech-providers）：
/// 用账号上「当前使用」的那一家（豆包 Seed-ASR 或 OpenAI Realtime）与它自己的 Base URL、模型和
/// API Key，不重试、不降级、也不换另一家（D1）。准入（取凭据 + 等语境 + 建连）整体限时约 3s；
/// 取凭据、读语境与开麦克风并行。
@MainActor
final class DictationSession: ObservableObject {
    /// Why dictation cannot start at all; the microphone is never opened.
    enum Unavailability: Equatable {
        /// The provider in use has no key.
        case notConfigured(SpeechProviderID)
        /// The centre does not store provider configurations (older server).
        case outdatedServer
    }

    enum Phase: Equatable {
        case connecting
        /// Recognising with `provider`; `withContext` = the agent conversation went into the
        /// recognition context.
        case active(provider: SpeechProviderID, withContext: Bool)
        case unavailable(Unavailability)
        case permissionDenied
        case failed(String)
    }

    static let invalidKeyMessage = "Key 无效，请在「语音识别」里重新填写"
    static let unreachableMessage = "无法连接识别服务"

    @Published private(set) var phase: Phase = .connecting
    @Published private(set) var displayText = ""
    @Published private(set) var isVolatile = false

    private let client: CofluxClient
    private let contextSource: DictationContextSource
    private let capture = AudioCapture()
    private var provider: (any SpeechTranscribing)?
    private var listenTask: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    private var keyTask: Task<Result<SpeechCredentials, any Error>, Never>?
    private var contextTask: Task<DictationContext, Never>?
    /// 快速按下-松开可能在准入还没跑完时就要求收尾；每个 await 挂起点之后都要重新检查这个
    /// 标志，避免残留连接或重复初始化（真实场景，不是臆造的边界情况）。
    private var teardownRequested = false
    /// 准入期（取凭据 / 等语境 / 握手，最多约 3s）采到的音频先攒这里，provider 就绪后在
    /// feedProvider 里补喂——否则开口前几百 ms 全丢字。上限防异常场景无限膨胀
    /// （约 9.4s 的音频，远超准入窗口；按采样率换算成字节，16kHz 下即 300KB）。
    private var pendingPCM: [Data] = []
    private var pendingPCMBytes = 0
    private var pendingPCMCapBytes = 300 * 1024

    /// The whole admission — key fetch, context wait and connect — is bounded: `finish()` awaits
    /// `startTask` first, so an unbounded admission would leave the overlay finalizing for the key
    /// fetch's full timeout.
    private static let admissionTimeout: Duration = .seconds(3)
    /// The conversation context is waited for at most this long from touch-down; after it the
    /// workspace sentence alone goes in.
    private static let contextDeadline: Duration = .milliseconds(1200)
    private let createdAt = ContinuousClock.now

    /// `sessionID`: the terminal's session, whose agent conversation becomes the context.
    init(client: CofluxClient, workspaceID: String, sessionID: String?) {
        self.client = client
        contextSource = DictationContextSource(client: client, workspaceID: workspaceID, sessionID: sessionID)
    }

    /// 麦克风是否已授权（同步可读），一处两用：
    /// - start() 的权限快路径（plan 066）：已授权时没有权限框弹出/收起这回事，
    ///   慢路径那套等待可整段跳过；
    /// - 预热准入（plan 069）：不满足就完全不预热——否则首次点一下占位条想
    ///   打字就弹麦克风权限框。这同时把预热隔在"权限框刚收起就起 AURemoteIO
    ///   被 AudioToolbox abort"的崩溃时序之外（见下面慢路径注释），别为了
    ///   "预热也支持首次授权"把它打开。
    static var permissionsGranted: Bool {
        AVAudioApplication.shared.recordPermission == .granted
    }

    /// The provider in use has a key on a centre that stores provider configurations: dictation can
    /// start. Prewarm is skipped otherwise.
    static func isAvailable(on client: CofluxClient) -> Bool {
        guard client.speechConfigSupported, let config = client.speechConfig else { return false }
        return config[config.active].keyConfigured
    }

    /// The capture rate each provider expects (D10).
    private static func sampleRate(for provider: SpeechProviderID) -> Double {
        switch provider {
        case .doubao: 16000
        case .openai: 24000
        }
    }

    /// 长按触发：包一层 Task 存进 startTask，finish() 靠它等 phase 落定
    /// （不可用/权限被拒/连接失败都在 start() 内部设置，await 它就不会读到
    /// 过期的 .connecting）。
    func begin() {
        startTask = Task { await self.start() }
    }

    private func start() async {
        guard client.speechConfigSupported else {
            phase = .unavailable(.outdatedServer)
            return
        }
        // The provider in use is read once, at touch-down; it is never switched mid-session.
        let speechProvider = client.speechConfig?.active ?? .doubao
        guard client.speechConfig?[speechProvider].keyConfigured == true else {
            phase = .unavailable(.notConfigured(speechProvider))
            return
        }
        // Credentials and context run alongside the microphone, from touch-down (prewarm) on. Both
        // are cancelled by cancel(); their late results are ignored behind teardownRequested.
        let client = client
        let keyTask = Task { () -> Result<SpeechCredentials, any Error> in
            do { return .success(try await client.speechCredentials(for: speechProvider)) } catch { return .failure(error) }
        }
        let source = contextSource
        let contextTask = Task { await source.load(client: client) }
        self.keyTask = keyTask
        self.contextTask = contextTask

        if !Self.permissionsGranted {
            let firstAsk = AVAudioApplication.shared.recordPermission != .granted
            guard await AVAudioApplication.requestRecordPermission() else {
                phase = .permissionDenied
                return
            }
            guard !teardownRequested else { return }

            // 真机长按崩溃根因（2026-07-29，栈：_ReportRPCTimeout →
            // AURemoteIO::Initialize → [AVAudioEngine inputNode]）：权限框刚收起
            // 的瞬间 app 尚未回到 active、mediaserverd 的授权迁移未完成，此时起
            // AURemoteIO 会 RPC 超时被 AudioToolbox 直接 abort——app 侧 catch 不住，
            // 只能消除时序：等回 active（上限 2s 防挂死），首次授权再多留一拍缓冲
            var waited = 0
            while UIApplication.shared.applicationState != .active, waited < 2000 {
                try? await Task.sleep(for: .milliseconds(100))
                waited += 100
            }
            if firstAsk {
                try? await Task.sleep(for: .milliseconds(400))
            }
        }
        // 权限快路径（plan 066）：已授权时直接进 capture.start()，消除长按后立即开口时
        // 头几百 ms 音频在采音开始前被丢的窗口。
        guard !teardownRequested else { return }

        let sampleRate = Self.sampleRate(for: speechProvider)
        pendingPCMCapBytes = 300 * 1024 * Int(sampleRate) / 16000
        do {
            try capture.start(sampleRate: sampleRate)
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

        let deadline = ContinuousClock.now + Self.admissionTimeout

        guard let keyResult = await Self.value(of: keyTask, before: deadline) else {
            return fail(Self.unreachableMessage)
        }
        guard !teardownRequested else {
            capture.stop()
            return
        }
        let credentials: SpeechCredentials
        switch keyResult {
        case .success(let value):
            credentials = value
        case .failure(let error):
            return fail((error as? SpeechError)?.message ?? Self.unreachableMessage)
        }
        guard !credentials.apiKey.isEmpty else {
            phase = .unavailable(.notConfigured(speechProvider))
            capture.stop()
            return
        }

        let context = await Self.value(of: contextTask, before: min(createdAt + Self.contextDeadline, deadline))
            ?? contextSource.fallback
        guard !teardownRequested else {
            capture.stop()
            return
        }

        let transcriber: any SpeechTranscribing = switch speechProvider {
        case .doubao:
            SeedASRProvider(
                apiKey: credentials.apiKey, endpoint: credentials.baseURL,
                resourceID: credentials.model, contextItems: context.items
            )
        case .openai:
            OpenAIRealtimeTranscriber(
                apiKey: credentials.apiKey, baseURL: credentials.baseURL,
                model: credentials.model, contextItems: context.items
            )
        }
        let connect = Task { () -> Result<Void, SpeechStartError> in
            do {
                try await transcriber.start()
                return .success(())
            } catch let error as SpeechStartError {
                return .failure(error)
            } catch {
                return .failure(.unreachable)
            }
        }
        guard let outcome = await Self.value(of: connect, before: deadline) else {
            await transcriber.cancel()
            return fail(Self.unreachableMessage)
        }
        guard !teardownRequested else {
            await transcriber.cancel()
            capture.stop()
            return
        }
        switch outcome {
        case .failure(.invalidKey):
            await transcriber.cancel()
            return fail(Self.invalidKeyMessage)
        case .failure(.unreachable):
            await transcriber.cancel()
            return fail(Self.unreachableMessage)
        case .success:
            provider = transcriber
            phase = .active(provider: speechProvider, withContext: context.includesConversation)
            pump(transcriber)
        }
    }

    /// An admission failure: show it and release the microphone. No fallback (D1).
    private func fail(_ message: String) {
        phase = .failed(message)
        capture.stop()
    }

    /// 上滑取消 / 未达长按就松手：不等终稿，尽快断开；在飞的取凭据与读语境一并取消。
    func cancel() {
        guard !teardownRequested else { return }
        teardownRequested = true
        keyTask?.cancel()
        contextTask?.cancel()
        listenTask?.cancel()
        capture.stop()
        if let provider {
            Task { await provider.cancel() }
        }
    }

    /// 松手结束：等 start() 把 phase 落定（不可用/权限拒绝/连接失败也在此刻才能读到
    /// 准确值），再请求引擎给出终稿，最多等 2s，返回已转写文字（不含首尾空白）。
    /// 收尾强制调 provider.cancel() 关 ws/结束 listenTask：终包丢失或超时都不该让连接
    /// 悬挂到服务端自己断（cancel 内部幂等）。
    func finish() async -> String {
        guard !teardownRequested else { return displayText.trimmingCharacters(in: .whitespacesAndNewlines) }
        teardownRequested = true
        await startTask?.value
        keyTask?.cancel()
        contextTask?.cancel()
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
            while pendingPCMBytes > pendingPCMCapBytes, !pendingPCM.isEmpty {
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
        case .failed(let message):
            phase = .failed(message)
        case .closed:
            break
        }
    }

    /// The task's value, or nil once `deadline` passes, whichever comes first. The task is not
    /// cancelled here; a late value is simply dropped.
    private static func value<T: Sendable>(of task: Task<T, Never>, before deadline: ContinuousClock.Instant) async -> T? {
        let race = FirstResult<T>()
        return await withCheckedContinuation { continuation in
            race.continuation = continuation
            race.timer = Task { @MainActor in
                do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
                race.resolve(nil)
            }
            Task { @MainActor in
                race.resolve(await task.value)
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

/// One-shot resolution of `DictationSession.value(of:before:)`: whichever side comes first wins.
@MainActor
private final class FirstResult<T: Sendable> {
    var continuation: CheckedContinuation<T?, Never>?
    var timer: Task<Void, Never>?

    func resolve(_ value: T?) {
        guard let continuation else { return }
        self.continuation = nil
        timer?.cancel()
        continuation.resume(returning: value)
    }
}

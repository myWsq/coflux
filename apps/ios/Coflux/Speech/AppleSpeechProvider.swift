import AVFoundation
import Speech

enum AppleSpeechError: Error {
    case localeUnsupported
}

/// Apple 本地 SpeechAnalyzer/SpeechTranscriber(iOS 26) 降级引擎，豆包免 key 通道
/// 不可用（2.5s 准入超时/连接失败）时启用，纯本地不出网。
///
/// 风险声明（plan 064 报告中会再次强调）：iOS 26 Speech 框架是 2025 WWDC 新
/// API，本会话禁止执行任何构建/编译验证，本文件的类型名与方法签名（
/// SpeechTranscriber/SpeechAnalyzer/AssetInventory/AnalyzerInput 等）系依据公开
/// 资料交叉核对后重建，未经编译器校验，是本次实现中风险最高的部分。
@available(iOS 26.0, *)
actor AppleSpeechProvider: SpeechTranscribing {
    nonisolated let events: AsyncStream<SpeechTranscriptEvent>
    private let eventContinuation: AsyncStream<SpeechTranscriptEvent>.Continuation

    private let locale = Locale(identifier: "zh_CN")
    private var transcriber: SpeechTranscriber?
    private var analyzer: SpeechAnalyzer?
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    private var converter: AVAudioConverter?
    private var analyzerFormat: AVAudioFormat?
    private var resultsTask: Task<Void, Never>?
    private var finalizedText = ""

    // 共享采音器固定输出的格式（AudioCapture.swift），feed(pcm:) 用它把
    // Int16 PCM 重建为 buffer 再转换到 analyzer 要求的格式
    private let sourceFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true
    )!

    init() {
        var continuation: AsyncStream<SpeechTranscriptEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        eventContinuation = continuation
    }

    func start() async throws {
        let transcriber = SpeechTranscriber(
            locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: []
        )
        self.transcriber = transcriber

        let continuation = eventContinuation
        try await Self.ensureModel(transcriber: transcriber, locale: locale) { progress in
            continuation.yield(.modelDownloading(progress: progress))
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer

        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw AppleSpeechError.localeUnsupported
        }
        analyzerFormat = format

        let (stream, inputContinuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.inputContinuation = inputContinuation
        try await analyzer.start(inputSequence: stream)

        resultsTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await result in transcriber.results {
                    await self.handle(result: result)
                }
            } catch {
                await self.emitFailure()
            }
            await self.emitClosed()
        }
    }

    func feed(pcm: Data) async {
        guard let inputContinuation, let analyzerFormat else { return }

        let frameCount = AVAudioFrameCount(pcm.count / MemoryLayout<Int16>.size)
        guard let inBuffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: frameCount),
              let channelData = inBuffer.int16ChannelData
        else { return }
        inBuffer.frameLength = frameCount
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            channelData[0].update(from: samples.baseAddress!, count: samples.count)
        }

        if converter == nil {
            converter = AVAudioConverter(from: sourceFormat, to: analyzerFormat)
        }
        guard let converter else { return }

        let ratio = analyzerFormat.sampleRate / sourceFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(frameCount) * ratio) + 32
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return }

        var delivered = false
        var conversionError: NSError?
        let status = converter.convert(to: outBuffer, error: &conversionError) { _, inputStatus in
            if delivered {
                inputStatus.pointee = .noDataNow
                return nil
            }
            delivered = true
            inputStatus.pointee = .haveData
            return inBuffer
        }
        guard status != .error, conversionError == nil, outBuffer.frameLength > 0 else { return }

        inputContinuation.yield(AnalyzerInput(buffer: outBuffer))
    }

    func finish() async {
        inputContinuation?.finish()
        inputContinuation = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
    }

    func cancel() async {
        resultsTask?.cancel()
        inputContinuation?.finish()
        inputContinuation = nil
        try? await analyzer?.cancelAndFinishNow()
        eventContinuation.yield(.closed)
        eventContinuation.finish()
    }

    // MARK: - 结果处理

    /// finalized 结果是增量分段（累加到 finalizedText 后即定稿，后续分段不再回改）；
    /// volatile 结果是当前未定稿分段的实时预览（叠加在 finalizedText 之后展示，
    /// 会被同一分段的下一次 volatile/finalized 结果整体替换）——与豆包引擎的
    /// "累计全量文本" 语义相反，两者在 SpeechTranscriptEvent 层已统一抹平。
    private func handle(result: SpeechTranscriber.Result) {
        let text = String(result.text.characters)
        if result.isFinal {
            finalizedText += text
            eventContinuation.yield(.finalized(finalizedText))
        } else {
            eventContinuation.yield(.volatile(finalizedText + text))
        }
    }

    private func emitFailure() {
        eventContinuation.yield(.failed("本地语音识别中断"))
    }

    private func emitClosed() {
        eventContinuation.yield(.closed)
        eventContinuation.finish()
    }

    // MARK: - 模型资产

    private static func ensureModel(
        transcriber: SpeechTranscriber, locale: Locale, onProgress: @escaping @Sendable (Double?) -> Void
    ) async throws {
        let bcp47 = locale.identifier(.bcp47)
        let supported = await SpeechTranscriber.supportedLocales
        guard supported.contains(where: { $0.identifier(.bcp47) == bcp47 }) else {
            throw AppleSpeechError.localeUnsupported
        }
        let installed = await SpeechTranscriber.installedLocales
        if installed.contains(where: { $0.identifier(.bcp47) == bcp47 }) {
            return
        }
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
            return
        }
        onProgress(0)
        let progressTask = Task {
            while !Task.isCancelled {
                onProgress(request.progress.fractionCompleted)
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
        }
        try await request.downloadAndInstall()
        progressTask.cancel()
        onProgress(1)
    }
}

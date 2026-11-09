import AVFoundation

enum SpeechCaptureError: Error {
    case converterUnavailable
    case inputUnavailable
}

/// 共享采音器（plan 064 决策）：一份 AVAudioEngine tap，统一重采样到调用方指定采样率的
/// mono Int16 PCM 喂给转写 provider（Seed-ASR 收 16 kHz，OpenAI Realtime 收 24 kHz，
/// plan 20261109-speech-providers D10）。
/// 用 @unchecked Sendable：AVAudioEngine 的 tap 回调
/// 跑在 CoreAudio 实时线程，不受 Swift 并发隔离管辖；本类只由持有者
/// （DictationSession，MainActor）在 start/stop 上做外部串行化，tap 内部只读
/// converter/format（只在未运行时的 start() 里换），不与外部发生并发写冲突。
final class AudioCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var targetFormat = AudioCapture.format(sampleRate: 16000)
    private var converter: AVAudioConverter?
    private(set) var isRunning = false

    /// 每帧转好的 mono Int16 PCM（采样率为本次 start 指定的值）；在 CoreAudio 线程上调用
    var onPCM: (@Sendable (Data) -> Void)?

    private static func format(sampleRate: Double) -> AVAudioFormat {
        AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
    }

    /// 对讲期间独占音频（landmine）：激活录音会打断别的音频播放；
    /// 结束/取消/出错路径都必须走 stop()，不能留悬挂 tap（下次长按会静音或崩溃）
    /// `sampleRate`：本次输出的目标采样率（Hz），由所用 provider 决定。
    func start(sampleRate: Double) throws {
        guard !isRunning else { return }
        if targetFormat.sampleRate != sampleRate { targetFormat = Self.format(sampleRate: sampleRate) }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        // 无输入路由/权限受限时 inputNode 报 0Hz/0ch，把它交给 installTap 会
        // NSException(SIGABRT) 直接崩进程（AVAudioEngine 不容忍无效格式，
        // 2026-07-29 真机长按崩溃 + 模拟器探针复现同源）。此处拦下走报错态
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw SpeechCaptureError.inputUnavailable
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw SpeechCaptureError.converterUnavailable
        }
        self.converter = converter

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1600, format: inputFormat) { [weak self] buffer, _ in
            self?.convertAndEmit(buffer)
        }
        engine.prepare()
        try engine.start()
        isRunning = true
    }

    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        isRunning = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func convertAndEmit(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = targetFormat.sampleRate / max(buffer.format.sampleRate, 1)
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var delivered = false
        var conversionError: NSError?
        let status = converter.convert(to: outBuffer, error: &conversionError) { _, inputStatus in
            if delivered {
                inputStatus.pointee = .noDataNow
                return nil
            }
            delivered = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, conversionError == nil,
              let channelData = outBuffer.int16ChannelData,
              outBuffer.frameLength > 0
        else { return }

        let data = Data(bytes: channelData[0], count: Int(outBuffer.frameLength) * MemoryLayout<Int16>.size)
        onPCM?(data)
    }
}

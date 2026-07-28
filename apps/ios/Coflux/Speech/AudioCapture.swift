import AVFoundation

enum SpeechCaptureError: Error {
    case converterUnavailable
}

/// 共享采音器（plan 064 决策）：一份 AVAudioEngine tap，统一重采样到 16kHz mono
/// Int16 PCM 喂给转写 provider（豆包要 16k mono 做 Opus；Apple 引擎侧自己转成
/// bestAvailableAudioFormat）。用 @unchecked Sendable：AVAudioEngine 的 tap 回调
/// 跑在 CoreAudio 实时线程，不受 Swift 并发隔离管辖；本类只由持有者
/// （DictationSession，MainActor）在 start/stop 上做外部串行化，tap 内部只读
/// immutable 的 converter/format，不与外部发生并发写冲突。
final class AudioCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true
    )!
    private var converter: AVAudioConverter?
    private(set) var isRunning = false

    /// 每帧转好的 16kHz mono Int16 PCM；在 CoreAudio 线程上调用
    var onPCM: (@Sendable (Data) -> Void)?

    /// 对讲期间独占音频（landmine）：激活录音会打断别的音频播放；
    /// 结束/取消/出错路径都必须走 stop()，不能留悬挂 tap（下次长按会静音或崩溃）
    func start() throws {
        guard !isRunning else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
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

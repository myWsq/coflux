import AVFoundation
import Opus

enum DoubaoOpusError: Error {
    case formatUnavailable
    case bufferUnavailable
    case encodeFailed
}

/// 20ms/640B PCM 帧 → Opus，对应 doubaoime.rs 的 opus 编码器封装（16kHz mono，
/// Application::Audio，单帧最大输出 4000B）。用 alta/swift-opus 而非
/// AVAudioConverter→kAudioFormatOpus：Apple 的 Opus **编码**路径未文档化，
/// 多篇开发者论坛反馈不可靠，解码路径才是有保障的那一半（plan 064 决策，见
/// 最终报告中的调研说明）。
final class DoubaoOpusEncoder {
    private let encoder: Opus.Encoder
    private let format: AVAudioFormat
    private static let maxOutputBytes = 4000

    init() throws {
        guard let format = AVAudioFormat(
            opusPCMFormat: .int16, sampleRate: 16000, channels: 1
        ) else {
            throw DoubaoOpusError.formatUnavailable
        }
        self.format = format
        self.encoder = try Opus.Encoder(format: format, application: .audio)
    }

    /// 输入恰好一帧 640B（320 samples @ Int16 mono）PCM，输出 Opus 包
    func encodeFrame(_ pcm: Data) throws -> Data {
        let frameCount = AVAudioFrameCount(pcm.count / MemoryLayout<Int16>.size)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
              let channelData = buffer.int16ChannelData
        else {
            throw DoubaoOpusError.bufferUnavailable
        }
        buffer.frameLength = frameCount
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            channelData[0].update(from: samples.baseAddress!, count: samples.count)
        }

        var output = Data(count: Self.maxOutputBytes)
        let written = try encoder.encode(buffer, to: &output)
        guard written > 0 else { throw DoubaoOpusError.encodeFailed }
        output.removeSubrange(written..<output.count)
        return output
    }
}

import Foundation

public enum P2PFramingError: Error, Equatable, Sendable {
    case invalidFrameLength(Int)
    case invalidStream
}

/// reliable + ordered DataChannel 的线格式，与当前 Web 和 Rust worker 一致：
/// [u32 大端长度][DeviceEnvelope]，每条 SCTP 消息最多 16 KiB。
public enum P2PFraming {
    public static let chunkBytes = 16 * 1024
    public static let maximumFrameBytes = DeviceProtocol.maxFrameBytes

    public static func chunks(for frame: Data) throws -> [Data] {
        guard !frame.isEmpty, frame.count <= maximumFrameBytes else {
            throw P2PFramingError.invalidFrameLength(frame.count)
        }
        let length = UInt32(frame.count)
        var chunk = Data((0..<4).map { UInt8(truncatingIfNeeded: length >> (24 - $0 * 8)) })
        var result: [Data] = []
        var cursor = frame.startIndex
        while cursor < frame.endIndex {
            let end = min(frame.endIndex, cursor + chunkBytes - chunk.count)
            chunk.append(frame[cursor..<end])
            result.append(chunk)
            chunk = Data()
            cursor = end
        }
        return result
    }
}

/// 每个通道独享一个重组器，按接收顺序调用。只累积当前帧，不按消息重复复制整份积压。
/// 无效前缀后永久拒绝输入：调用方必须关闭通道，不能继续猜测帧边界。
public struct P2PFrameAssembler: Sendable {
    private var header: UInt32 = 0
    private var headerBytes = 0
    private var expected: Int?
    private var body = Data()
    private var invalid = false

    public init() {}

    public mutating func push(_ bytes: Data) throws -> [Data] {
        guard !invalid else { throw P2PFramingError.invalidStream }
        var cursor = bytes.startIndex
        var frames: [Data] = []
        while cursor < bytes.endIndex {
            if expected == nil {
                while headerBytes < 4, cursor < bytes.endIndex {
                    header = (header << 8) | UInt32(bytes[cursor])
                    headerBytes += 1
                    cursor += 1
                }
                guard headerBytes == 4 else { break }
                let length = Int(header)
                guard length > 0, length <= P2PFraming.maximumFrameBytes else {
                    invalid = true
                    body = Data()
                    throw P2PFramingError.invalidFrameLength(length)
                }
                expected = length
                header = 0
                headerBytes = 0
            }
            if let expected {
                let end = min(bytes.endIndex, cursor + expected - body.count)
                body.append(bytes[cursor..<end])
                cursor = end
                if body.count == expected {
                    frames.append(body)
                    body = Data()
                    self.expected = nil
                }
            }
        }
        return frames
    }
}

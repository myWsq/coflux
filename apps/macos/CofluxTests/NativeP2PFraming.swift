import Foundation

/// native WebRTC DataChannel 与 Rust worker 之间的线上字节流契约。
///
/// 每个 DeviceEnvelope 先加 4-byte big-endian 长度，再按不超过 16 KiB 的
/// DataChannel message 切分。可靠、有序 SCTP 使接收端可把这些 message 当字节流重组。
enum NativeP2PFraming {
    static let chunkBytes = 16 * 1024
    static let maxFrameBytes = 30 * 1024 * 1024

    static func chunks(for frame: Data) throws -> [Data] {
        guard !frame.isEmpty, frame.count <= maxFrameBytes else {
            throw NativeP2PFramingError.invalidFrameLength(frame.count)
        }

        var stream = Data(capacity: MemoryLayout<UInt32>.size + frame.count)
        var length = UInt32(frame.count).bigEndian
        withUnsafeBytes(of: &length) { stream.append(contentsOf: $0) }
        stream.append(frame)

        return stride(from: 0, to: stream.count, by: chunkBytes).map { offset in
            stream.subdata(in: offset..<min(offset + chunkBytes, stream.count))
        }
    }
}

enum NativeP2PFramingError: Error, Equatable, CustomStringConvertible {
    case invalidFrameLength(Int)
    case oversizedChunk(Int)
    case dataChannelClosed
    case admissionTimeout
    case drainTimeout
    case sendRejected

    var description: String {
        switch self {
        case .invalidFrameLength(let length):
            return "P2P 帧长前缀违规：\(length)"
        case .oversizedChunk(let length):
            return "P2P DataChannel message 超过 16 KiB：\(length)"
        case .dataChannelClosed:
            return "P2P DataChannel 已关闭"
        case .admissionTimeout:
            return "P2P 整帧发送排队超时"
        case .drainTimeout:
            return "P2P DataChannel bufferedAmount 排水超时"
        case .sendRejected:
            return "P2P DataChannel 拒绝分片发送"
        }
    }
}

/// 把 libwebrtc 的 DataChannel 缩成可注入、可验证的分片发送边界。实现必须保证
/// `sendChunk` 返回 false 后 `close` 会让整条有序字节流失效，不能续发剩余分片。
protocol NativeP2PChunkChannel: AnyObject {
    var isOpen: Bool { get }
    var bufferedAmount: UInt64 { get }

    func sendChunk(_ chunk: Data) -> Bool
    func close()
}

/// 每次持锁发送一个完整 frame，防止两个调用把各自的 header/payload chunks 交错。
/// admission 在复制 chunks 之前发生，且排队时间纳入同一 deadline；因此并发的近 30 MiB
/// 帧不会同时构造多份分片。close 可从外部并发触发，发送循环会及时收敛。
final class NativeP2PFrameWriter: @unchecked Sendable {
    private let frameLock = NSLock()

    func send(
        frame: Data,
        timeout: TimeInterval,
        channel: NativeP2PChunkChannel,
        now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        pause: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    ) throws {
        guard !frame.isEmpty, frame.count <= NativeP2PFraming.maxFrameBytes else {
            throw NativeP2PFramingError.invalidFrameLength(frame.count)
        }

        let deadline = now() + timeout
        while !frameLock.try() {
            guard now() < deadline else { throw NativeP2PFramingError.admissionTimeout }
            pause(0.005)
        }
        defer { frameLock.unlock() }

        guard now() < deadline else { throw NativeP2PFramingError.admissionTimeout }
        let chunks = try NativeP2PFraming.chunks(for: frame)
        guard now() < deadline else { throw NativeP2PFramingError.admissionTimeout }
        guard channel.isOpen else { throw NativeP2PFramingError.dataChannelClosed }
        for chunk in chunks {
            guard now() < deadline else {
                channel.close()
                throw NativeP2PFramingError.drainTimeout
            }
            while channel.bufferedAmount > UInt64(NativeP2PSendState.highWaterBytes) {
                guard now() < deadline else {
                    channel.close()
                    throw NativeP2PFramingError.drainTimeout
                }
                guard channel.isOpen else {
                    channel.close()
                    throw NativeP2PFramingError.dataChannelClosed
                }
                pause(0.005)
            }
            guard channel.isOpen else {
                channel.close()
                throw NativeP2PFramingError.dataChannelClosed
            }
            guard channel.sendChunk(chunk) else {
                channel.close()
                throw NativeP2PFramingError.sendRejected
            }
        }
    }
}

/// 长度前缀分片流重组器。协议违规后调用方必须关闭 DataChannel；字节流已经失步，
/// 不能尝试跳过坏帧继续解析。
struct NativeP2PFrameAssembler {
    private var buffer = Data()
    private var readOffset = 0
    private var frameBytesNeeded: Int?

    mutating func push(_ chunk: Data) throws -> [Data] {
        guard chunk.count <= NativeP2PFraming.chunkBytes else {
            throw NativeP2PFramingError.oversizedChunk(chunk.count)
        }
        if !chunk.isEmpty {
            buffer.append(chunk)
        }

        var frames: [Data] = []
        while true {
            if frameBytesNeeded == nil {
                guard availableBytes >= MemoryLayout<UInt32>.size else {
                    compactIfNeeded()
                    return frames
                }
                let length = Int(readUInt32BigEndian(at: readOffset))
                readOffset += MemoryLayout<UInt32>.size
                guard length > 0, length <= NativeP2PFraming.maxFrameBytes else {
                    throw NativeP2PFramingError.invalidFrameLength(length)
                }
                frameBytesNeeded = length
            }

            guard let needed = frameBytesNeeded, availableBytes >= needed else {
                compactIfNeeded()
                return frames
            }
            frames.append(buffer.subdata(in: readOffset..<(readOffset + needed)))
            readOffset += needed
            frameBytesNeeded = nil
            compactIfNeeded()
        }
    }

    private var availableBytes: Int {
        buffer.count - readOffset
    }

    private func readUInt32BigEndian(at offset: Int) -> UInt32 {
        buffer[offset..<(offset + 4)].reduce(UInt32(0)) { value, byte in
            (value << 8) | UInt32(byte)
        }
    }

    private mutating func compactIfNeeded() {
        guard readOffset > 0 else { return }
        if readOffset == buffer.count {
            buffer.removeAll(keepingCapacity: true)
            readOffset = 0
        } else if readOffset >= 1024 * 1024, readOffset >= buffer.count / 2 {
            buffer.removeSubrange(0..<readOffset)
            readOffset = 0
        }
    }
}

/// DataChannel 的可观察 liveness。ICE connected/远端 onClose 都不是判活依据；
/// application traffic 超过 deadline 没有活动时，由 Router 主动判死并保留/恢复 relay。
struct NativeP2PLiveness {
    enum State: Equatable {
        case alive
        case silentTimeout
        case closed
    }

    let timeout: TimeInterval
    private(set) var lastActivity: TimeInterval
    private(set) var closed = false

    init(now: TimeInterval, timeout: TimeInterval) {
        self.lastActivity = now
        self.timeout = timeout
    }

    mutating func recordActivity(at now: TimeInterval) {
        guard !closed else { return }
        lastActivity = now
    }

    mutating func recordClose() {
        closed = true
    }

    func state(at now: TimeInterval) -> State {
        if closed { return .closed }
        return now - lastActivity >= timeout ? .silentTimeout : .alive
    }
}

/// relay-first 竞争的最小状态契约。P2P 只有 DataChannel 真正 open 后才可接管；
/// P2P 拒绝、发送失败或静默超时均不得顺带关闭已可用的 relay。
struct NativeP2PPromotionState {
    enum ActiveTransport: Equatable {
        case none
        case relay
        case p2p
    }

    private(set) var active: ActiveTransport = .none
    private(set) var relayAvailable = false
    private(set) var relayGeneration: UInt64?
    private(set) var pendingP2PGeneration: UInt64?
    private(set) var activeP2PGeneration: UInt64?

    mutating func relayOpened(generation: UInt64) {
        guard generation > 0 else { return }
        if let current = relayGeneration, generation <= current { return }
        relayAvailable = true
        relayGeneration = generation
        if active == .none { active = .relay }
    }

    mutating func beginP2PAttempt(generation: UInt64) {
        guard generation > 0 else { return }
        pendingP2PGeneration = generation
    }

    mutating func p2pDataChannelOpened(generation: UInt64) {
        guard pendingP2PGeneration == generation else { return }
        pendingP2PGeneration = nil
        guard active == .none || (
            active == .relay && generation > (relayGeneration ?? 0)
        ) else { return }
        activeP2PGeneration = generation
        active = .p2p
    }

    mutating func p2pFailed(generation: UInt64) {
        if pendingP2PGeneration == generation { pendingP2PGeneration = nil }
        guard activeP2PGeneration == generation else { return }
        activeP2PGeneration = nil
        if active == .p2p { active = relayAvailable ? .relay : .none }
    }

    mutating func relayClosed(generation: UInt64) {
        guard relayGeneration == generation else { return }
        relayAvailable = false
        relayGeneration = nil
        if active == .relay { active = .none }
    }
}

/// sendData 的同步判定与失败收敛。真正的排水器仍依据 `bufferedAmount` 异步等待；
/// 这里固定“整帧要么入队，要么拒绝”，避免写入半帧后让分片流永久失步。
struct NativeP2PSendState {
    enum Decision: Equatable {
        case accept
        case backpressured
        case invalidFrame
        case closed
    }

    static let highWaterBytes = 4 * 1024 * 1024
    private(set) var closed = false

    func decision(frameBytes: Int, bufferedAmount: UInt64) -> Decision {
        if closed { return .closed }
        guard frameBytes > 0, frameBytes <= NativeP2PFraming.maxFrameBytes else {
            return .invalidFrame
        }
        if bufferedAmount > UInt64(Self.highWaterBytes) { return .backpressured }
        return .accept
    }

    mutating func recordSendFailure() {
        closed = true
    }
}

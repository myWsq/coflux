import CofluxClientCore
import Foundation
@preconcurrency import WebRTC

enum NativeRTCConnectionError: Error {
    case sendQueueFull
    case receiveQueueFull
    case concurrentReceive
    case nonBinaryMessage
    case sendFailed
}

/// WebRTC 的回调和调用在专用串行队列收敛，分片/重组不占用 UI 主线程。
/// unchecked Sendable 的依据：除不可变 channel/queue 外，状态只在 queue 内访问；
/// 回调入队前的字节预算单独受 ingressLock 保护，避免 GCD 队列本身成为无界缓存。
final class NativeRTCConnection: NSObject, TransportConnection, @unchecked Sendable {
    private struct Send {
        var chunks: [Data]
        var index = 0
        let completion: CheckedContinuation<Void, any Error>
    }
    private let channel: RTCDataChannel
    private let queue = DispatchQueue(label: "dev.coflux.rtc-channel", qos: .userInitiated)
    private let ingressLock = NSLock()
    private var ingressBytes = 0
    private var ingressClosed = false
    private static let queueLimit = 2 * P2PFraming.maximumFrameBytes + 1024
    private static let highWater: UInt64 = 1024 * 1024
    private var sends: [Send] = []
    private var sendBytes = 0
    private var drainScheduled = false
    private var closed = false
    private var assembler = P2PFrameAssembler()
    private var frames: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?

    init(channel: RTCDataChannel) {
        self.channel = channel
        super.init()
        channel.delegate = self
    }

    func send(_ data: Data) async throws {
        try Task.checkCancellation()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (completion: CheckedContinuation<Void, any Error>) in
                queue.async {
                    guard !self.closed else { completion.resume(throwing: TransportClosedError()); return }
                    guard !data.isEmpty, data.count <= P2PFraming.maximumFrameBytes else {
                        completion.resume(throwing: P2PFramingError.invalidFrameLength(data.count)); return
                    }
                    guard self.sends.count < 256,
                          self.sendBytes + data.count + 4 + Int(self.channel.bufferedAmount) <= Self.queueLimit else {
                        completion.resume(throwing: NativeRTCConnectionError.sendQueueFull); return
                    }
                    do {
                        let chunks = try P2PFraming.chunks(for: data)
                        self.sends.append(Send(chunks: chunks, completion: completion))
                        self.sendBytes += data.count + 4
                        self.scheduleDrain()
                    } catch { completion.resume(throwing: error) }
                }
            }
        } onCancel: {
            // 帧可能已发送一部分，取消后必须关闭整条流，不能跳到下一帧。
            self.queue.async { self.finish(CancellationError()) }
        }
    }

    func receive() async throws -> Data {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { completion in
                queue.async {
                    guard !self.closed else { completion.resume(throwing: TransportClosedError()); return }
                    guard self.receiver == nil else {
                        completion.resume(throwing: NativeRTCConnectionError.concurrentReceive); return
                    }
                    if !self.frames.isEmpty {
                        let frame = self.frames.removeFirst()
                        self.releaseIngress(frame.count + 4)
                        completion.resume(returning: frame)
                    } else { self.receiver = completion }
                }
            }
        } onCancel: {
            self.queue.async { self.finish(CancellationError()) }
        }
    }

    func close() async {
        await withCheckedContinuation { completion in
            queue.async { self.finish(TransportClosedError()); completion.resume() }
        }
    }

    private func scheduleDrain(after delay: DispatchTimeInterval = .milliseconds(0)) {
        guard !drainScheduled, !closed, !sends.isEmpty else { return }
        drainScheduled = true
        queue.asyncAfter(deadline: .now() + delay) {
            self.drainScheduled = false
            self.drain()
        }
    }

    private func drain() {
        guard !closed else { return }
        switch channel.readyState {
        case .connecting: scheduleDrain(after: .milliseconds(20)); return
        case .open: break
        default: finish(TransportClosedError()); return
        }
        // 每轮最多交给 SCTP 256 KiB，再让出队列处理接收、取消和关闭。
        var batchBytes = 0
        while !sends.isEmpty, batchBytes < 256 * 1024 {
            if channel.bufferedAmount > Self.highWater {
                scheduleDrain(after: .milliseconds(10)); return
            }
            let chunk = sends[0].chunks[sends[0].index]
            guard channel.sendData(RTCDataBuffer(data: chunk, isBinary: true)) else {
                finish(NativeRTCConnectionError.sendFailed); return
            }
            sends[0].chunks[sends[0].index] = Data()
            sends[0].index += 1
            batchBytes += chunk.count
            sendBytes -= chunk.count
            if sends[0].index == sends[0].chunks.count {
                sends.removeFirst().completion.resume()
            }
        }
        scheduleDrain()
    }

    private func releaseIngress(_ count: Int) {
        ingressLock.withLock { ingressBytes -= count }
    }

    private func accept(_ data: Data) {
        guard !closed else { return }
        do {
            for frame in try assembler.push(data) {
                if let receiver {
                    self.receiver = nil
                    releaseIngress(frame.count + 4)
                    receiver.resume(returning: frame)
                } else {
                    guard frames.count < 4096 else { throw NativeRTCConnectionError.receiveQueueFull }
                    frames.append(frame)
                }
            }
        } catch { finish(error) }
    }

    private func finish(_ error: any Error) {
        guard !closed else { return }
        closed = true
        ingressLock.withLock { ingressClosed = true; ingressBytes = 0 }
        channel.delegate = nil
        channel.close()
        for send in sends { send.completion.resume(throwing: error) }
        sends.removeAll()
        sendBytes = 0
        receiver?.resume(throwing: error)
        receiver = nil
        frames.removeAll()
        assembler = P2PFrameAssembler()
    }
}

extension NativeRTCConnection: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        queue.async {
            switch self.channel.readyState {
            case .open: self.scheduleDrain()
            case .closing, .closed: self.finish(TransportClosedError())
            default: break
            }
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard buffer.isBinary else {
            let shouldClose = ingressLock.withLock {
                guard !ingressClosed else { return false }
                ingressClosed = true
                return true
            }
            if shouldClose { queue.async { self.finish(NativeRTCConnectionError.nonBinaryMessage) } }
            return
        }
        let data = buffer.data
        guard !data.isEmpty else { return }
        let accepted: Bool? = ingressLock.withLock {
            guard !ingressClosed else { return nil }
            guard data.count <= Self.queueLimit - ingressBytes else {
                ingressClosed = true
                return false
            }
            ingressBytes += data.count
            return true
        }
        guard let accepted else { return }
        guard accepted else {
            queue.async { self.finish(NativeRTCConnectionError.receiveQueueFull) }; return
        }
        queue.async { self.accept(data) }
    }
}

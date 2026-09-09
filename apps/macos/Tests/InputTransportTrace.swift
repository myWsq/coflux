import CofluxClientCore
import CofluxProtocol
import Foundation
@testable import Coflux

/// 仅测试使用的原生传输观测；不记录凭据、终端正文或生产流量。
final class InputTransportTrace: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = 0
    private var started = 0.0
    private var sessionID = ""
    private var needle = Data()
    private var tail = Data()
    private var events: [String: Double] = [:]
    private var lastInputSeq: UInt64 = 0
    private var expectedBytes = 0

    func begin(sessionID: String, marker: String) {
        lock.withLock {
            generation += 1; started = ProcessInfo.processInfo.systemUptime
            self.sessionID = sessionID; needle = Data(("ACK:" + marker).utf8)
            tail.removeAll(keepingCapacity: true); events.removeAll(keepingCapacity: true)
            lastInputSeq = 0; expectedBytes = marker.utf8.count + 1
            events["startedWallMS"] = Date().timeIntervalSince1970 * 1000
        }
    }
    func sending(_ bytes: Data) -> Int? {
        guard let envelope = try? Coflux_V1_DeviceEnvelope(serializedBytes: bytes),
              case .ptyInput(let input) = envelope.payload else { return nil }
        return lock.withLock {
            guard !needle.isEmpty, input.sessionID == sessionID, events["ackReceivedMS"] == nil else { return nil }
            let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000
            if events["firstSendMS"] == nil { events["firstSendMS"] = elapsed }
            events["lastSendMS"] = elapsed
            lastInputSeq = input.inputSeq
            events["sentFrames", default: 0] += 1
            events["lastInputFingerprint"] = Self.fingerprint(bytes)
            events["sentBytes", default: 0] += Double(input.data.count)
            return generation
        }
    }
    func sent(_ token: Int?) {
        guard let token else { return }
        lock.withLock {
            guard token == generation else { return }
            events["sendCompletedMS"] = (ProcessInfo.processInfo.systemUptime - started) * 1000
        }
    }
    func received(_ bytes: Data) {
        let timestamp = ProcessInfo.processInfo.systemUptime
        guard let envelope = try? Coflux_V1_DeviceEnvelope(serializedBytes: bytes) else { return }
        lock.withLock {
            guard !needle.isEmpty else { return }
            switch envelope.payload {
            case .ptyInputAck(let ack):
                guard ack.sessionID == sessionID, lastInputSeq > 0, ack.appliedThroughSeq >= lastInputSeq,
                      events["sentBytes"] == Double(expectedBytes), events["inputAppliedAckMS"] == nil else { return }
                events["inputAppliedAckMS"] = (timestamp - started) * 1000
                events["inputAppliedFingerprint"] = Self.fingerprint(bytes)
            case .ptyOutput(let output):
                guard output.sessionID == sessionID, events["ackReceivedMS"] == nil else { return }
                tail.append(output.data)
                if tail.range(of: needle) != nil {
                    events["ackReceivedMS"] = (timestamp - started) * 1000
                    events["outputAckFingerprint"] = Self.fingerprint(bytes)
                }
                // 保留跨帧边界；检查后限长，避免快照/输出量改变观测内存规模。
                if tail.count > 256 { tail = Data(tail.suffix(256)) }
            default: break
            }
        }
    }
    // 截取52位以便JSON/Double无损关联；只是诊断标识，不用于安全校验。
    private static func fingerprint(_ bytes: Data) -> Double {
        let hash = bytes.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 }
        return Double(hash & ((1 << 52) - 1))
    }
    func snapshot() -> [String: Double] { lock.withLock { events } }
}

struct InputTracingTransport: Transport {
    let trace: InputTransportTrace
    func connect(to url: URL) async throws -> any TransportConnection {
        let base = try await SocketTransport().connect(to: url)
        if url.path == "/client" { return base }
        return InputTracingConnection(base: base, trace: trace)
    }
}
private struct InputTracingConnection: TransportConnection {
    let base: any TransportConnection
    let trace: InputTransportTrace
    func send(_ bytes: Data) async throws {
        let token = trace.sending(bytes)
        try await base.send(bytes)
        trace.sent(token)
    }
    func receive() async throws -> Data {
        let bytes = try await base.receive()
        trace.received(bytes)
        return bytes
    }
    func close() async { await base.close() }
}

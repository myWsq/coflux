import Foundation
import SwiftProtobuf
@preconcurrency import WebRTC

enum NativeWebRTCProbeError: Error, CustomStringConvertible {
    case timeout(String)
    case invalidMessage(String)
    case rejected(String)
    case unavailable(String)
    case sendFailed(String)

    var description: String {
        switch self {
        case .timeout(let detail): return "超时：\(detail)"
        case .invalidMessage(let detail): return "消息无效：\(detail)"
        case .rejected(let detail): return "被拒绝：\(detail)"
        case .unavailable(let detail): return "不可用：\(detail)"
        case .sendFailed(let detail): return "发送失败：\(detail)"
        }
    }
}

/// 把 callback API 桥成有 deadline 的同步 probe。所有共享状态均由锁保护；
/// `@unchecked Sendable` 只覆盖这个封装本身，不把底层 ObjC WebRTC 对象跨 actor 传播。
final class NativeBlockingResult<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var result: Result<Value, Error>?

    func complete(_ result: Result<Value, Error>) {
        lock.lock()
        guard self.result == nil else {
            lock.unlock()
            return
        }
        self.result = result
        lock.unlock()
        semaphore.signal()
    }

    func wait(timeout: TimeInterval, label: String) throws -> Value {
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            throw NativeWebRTCProbeError.timeout(label)
        }
        lock.lock()
        let result = self.result
        lock.unlock()
        guard let result else {
            throw NativeWebRTCProbeError.invalidMessage("\(label) 无完成结果")
        }
        return try result.get()
    }
}

/// 最小中心控制 WS：只实现认证与 P2P offer/answer/channel grant，使用生产 protobuf 信封。
/// 它是同步单 consumer probe：唯一 receive 串行区会缓存未命中消息，并明确拒绝
/// 并发 waiter。任一 send/receive timeout 都会终止 socket，禁止旧的 URLSession receive
/// 在调用方重试后吞掉下一条 protobuf frame。
final class NativeP2PControlClient {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private let sendLock = NSLock()
    private let receiveLock = NSLock()
    private let stateLock = NSLock()
    private var terminated = false
    private var pendingPayloads: [Coflux_V1_ServerToClient.OneOf_Payload] = []

    init(url: URL, origin: String?) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
        var request = URLRequest(url: url)
        if let origin { request.setValue(origin, forHTTPHeaderField: "Origin") }
        socket = session.webSocketTask(with: request)
        socket.resume()
    }

    func authenticate(username: String, password: String, timeout: TimeInterval = 20) throws -> Coflux_V1_AuthOk {
        var auth = Coflux_V1_ClientAuth()
        auth.username = username
        auth.password = password
        auth.clientVersion = "dev"
        try send(.clientAuth(auth), timeout: timeout)

        let payload = try waitPayload(timeout: timeout) { payload in
            switch payload {
            case .authOk, .authError, .clientOutdated: return true
            default: return false
            }
        }
        switch payload {
        case .authOk(let result): return result
        case .authError(let error): throw NativeWebRTCProbeError.rejected(error.message)
        case .clientOutdated: throw NativeWebRTCProbeError.rejected("native probe 版本不匹配")
        default: throw NativeWebRTCProbeError.invalidMessage("认证返回了非认证消息")
        }
    }

    func send(_ payload: Coflux_V1_ClientToServer.OneOf_Payload, timeout: TimeInterval = 20) throws {
        guard sendLock.try() else {
            throw NativeWebRTCProbeError.unavailable("control WS 不允许并发 send")
        }
        defer { sendLock.unlock() }
        try ensureAvailable()
        var envelope = Coflux_V1_ClientToServer()
        envelope.payload = payload
        let bytes = try envelope.serializedData()
        let completion = NativeBlockingResult<Void>()
        socket.send(.data(bytes)) { error in
            if let error { completion.complete(.failure(error)) }
            else { completion.complete(.success(())) }
        }
        do {
            _ = try completion.wait(timeout: timeout, label: "control WS send")
        } catch {
            terminate()
            throw error
        }
    }

    func waitPayload(
        timeout: TimeInterval,
        matching predicate: (Coflux_V1_ServerToClient.OneOf_Payload) -> Bool
    ) throws -> Coflux_V1_ServerToClient.OneOf_Payload {
        guard receiveLock.try() else {
            throw NativeWebRTCProbeError.unavailable("control WS 仅支持一个 receive waiter")
        }
        defer { receiveLock.unlock() }
        try ensureAvailable()
        if let index = pendingPayloads.firstIndex(where: predicate) {
            return pendingPayloads.remove(at: index)
        }

        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else {
                terminate()
                throw NativeWebRTCProbeError.timeout("control WS response")
            }
            let payload = try receive(timeout: remaining)
            if predicate(payload) { return payload }
            pendingPayloads.append(payload)
        }
    }

    func close() {
        terminate()
    }

    private func receive(timeout: TimeInterval) throws -> Coflux_V1_ServerToClient.OneOf_Payload {
        do {
            try ensureAvailable()
            let completion = NativeBlockingResult<URLSessionWebSocketTask.Message>()
            socket.receive { result in completion.complete(result.mapError { $0 as Error }) }
            let message = try completion.wait(timeout: timeout, label: "control WS receive")
            let data: Data
            switch message {
            case .data(let bytes): data = bytes
            case .string: throw NativeWebRTCProbeError.invalidMessage("control WS 收到 text frame")
            @unknown default: throw NativeWebRTCProbeError.invalidMessage("control WS 收到未知 frame")
            }
            let envelope = try Coflux_V1_ServerToClient(serializedBytes: data)
            guard let payload = envelope.payload else {
                throw NativeWebRTCProbeError.invalidMessage("ServerToClient 缺少 payload")
            }
            return payload
        } catch {
            terminate()
            throw error
        }
    }

    private func ensureAvailable() throws {
        if stateLock.withLock({ terminated }) {
            throw NativeWebRTCProbeError.unavailable("control WS 已终止")
        }
    }

    private func terminate() {
        let shouldTerminate = stateLock.withLock {
            if terminated { return false }
            terminated = true
            return true
        }
        guard shouldTerminate else { return }
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

/// stasel/WebRTC offerer probe。只保留决定架构的最小能力，不复制完整 DeviceRouter。
final class NativeWebRTCOfferer: NSObject, @unchecked Sendable {
    private let lock = NSLock()
    private let frameWriter = NativeP2PFrameWriter()
    private let factory: RTCPeerConnectionFactory
    private var assembler = NativeP2PFrameAssembler()
    private var receivedFrames: [Data] = []
    private var receiveError: Error?
    private var stateEvents: [String] = ["created"]
    private var generatedCandidateKinds: [String: Int] = [:]
    private(set) var peerConnection: RTCPeerConnection!
    private(set) var dataChannel: RTCDataChannel!

    init(channelID: String, iceServers: [String]) throws {
        guard RTCInitializeSSL() else {
            throw NativeWebRTCProbeError.unavailable("RTCInitializeSSL 失败")
        }
        factory = RTCPeerConnectionFactory()
        super.init()

        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherOnce
        configuration.iceServers = iceServers.isEmpty ? [] : [RTCIceServer(urlStrings: iceServers)]
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peerConnection = factory.peerConnection(
            with: configuration,
            constraints: constraints,
            delegate: self
        ) else {
            throw NativeWebRTCProbeError.unavailable("RTCPeerConnection 创建失败")
        }
        self.peerConnection = peerConnection

        let channelConfiguration = RTCDataChannelConfiguration()
        channelConfiguration.isOrdered = true
        channelConfiguration.maxPacketLifeTime = -1
        channelConfiguration.maxRetransmits = -1
        channelConfiguration.isNegotiated = false
        guard let dataChannel = peerConnection.dataChannel(
            forLabel: channelID,
            configuration: channelConfiguration
        ) else {
            peerConnection.close()
            throw NativeWebRTCProbeError.unavailable("RTCDataChannel 创建失败")
        }
        self.dataChannel = dataChannel
        dataChannel.delegate = self
    }

    func createGatheredOffer(timeout: TimeInterval = 12) throws -> String {
        let offerResult = NativeBlockingResult<RTCSessionDescription>()
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        peerConnection.offer(for: constraints) { description, error in
            if let error { offerResult.complete(.failure(error)) }
            else if let description { offerResult.complete(.success(description)) }
            else { offerResult.complete(.failure(NativeWebRTCProbeError.invalidMessage("offer 无 SDP"))) }
        }
        let offer = try offerResult.wait(timeout: timeout, label: "create offer")

        let setResult = NativeBlockingResult<Void>()
        peerConnection.setLocalDescription(offer) { error in
            if let error { setResult.complete(.failure(error)) }
            else { setResult.complete(.success(())) }
        }
        _ = try setResult.wait(timeout: timeout, label: "set local offer")

        let deadline = Date().addingTimeInterval(timeout)
        while peerConnection.iceGatheringState != .complete, deadline.timeIntervalSinceNow > 0 {
            Thread.sleep(forTimeInterval: 0.02)
        }
        // 与生产 Web Router 相同：超时只是不可达 STUN 的兜底，不是失败；带着已经
        // 收集的 host candidates 继续，避免把公网可达性混进 native 跨栈能力门。
        guard let sdp = peerConnection.localDescription?.sdp, !sdp.isEmpty else {
            throw NativeWebRTCProbeError.invalidMessage("gather 后 localDescription 为空")
        }
        return sdp
    }

    func setRemoteAnswer(_ sdp: String, timeout: TimeInterval = 12) throws {
        let answer = RTCSessionDescription(type: .answer, sdp: sdp)
        let result = NativeBlockingResult<Void>()
        peerConnection.setRemoteDescription(answer) { error in
            if let error { result.complete(.failure(error)) }
            else { result.complete(.success(())) }
        }
        _ = try result.wait(timeout: timeout, label: "set remote answer")
    }

    func waitForDataChannelOpen(timeout: TimeInterval = 20) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while deadline.timeIntervalSinceNow > 0 {
            switch dataChannel.readyState {
            case .open: return
            case .closing, .closed:
                throw NativeWebRTCProbeError.unavailable("DataChannel 建立期间关闭")
            case .connecting: break
            @unknown default: break
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        throw NativeWebRTCProbeError.timeout("DataChannel open（\(stateDescription)）")
    }

    /// 整帧串行后按 16 KiB 排水；任何 sendData=false 都关闭整条 channel，
    /// 不允许两个 frame 交错，也不允许半帧失败后继续发送。
    func sendFrame(_ frame: Data, timeout: TimeInterval = 120) throws {
        try frameWriter.send(frame: frame, timeout: timeout, channel: dataChannel)
    }

    func nextFrame(timeout: TimeInterval) throws -> Data? {
        let deadline = Date().addingTimeInterval(timeout)
        while deadline.timeIntervalSinceNow > 0 {
            lock.lock()
            let error = receiveError
            let frame = receivedFrames.isEmpty ? nil : receivedFrames.removeFirst()
            lock.unlock()
            if let frame { return frame }
            if let error { throw error }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return nil
    }

    var stateDescription: String {
        let observed = lock.withLock {
            let candidates = generatedCandidateKinds
                .sorted { $0.key < $1.key }
                .map { "\($0.key):\($0.value)" }
                .joined(separator: ",")
            return (stateEvents.suffix(24).joined(separator: ">"), candidates)
        }
        return "peer=\(peerConnection.connectionState.rawValue),ice=\(peerConnection.iceConnectionState.rawValue)," +
            "gather=\(peerConnection.iceGatheringState.rawValue),signal=\(peerConnection.signalingState.rawValue)," +
            "channel=\(dataChannel.readyState.rawValue),local=\(candidateSummary(peerConnection.localDescription?.sdp))," +
            "remote=\(candidateSummary(peerConnection.remoteDescription?.sdp)),generated=[\(observed.1)]," +
            "events=[\(observed.0)]"
    }

    var localCandidateCount: Int { candidateCount(peerConnection.localDescription?.sdp) }
    var remoteUDPHostCandidateCount: Int {
        candidateCount(peerConnection.remoteDescription?.sdp, matching: "udp-host")
    }

    private func recordState(_ value: String) {
        lock.withLock { stateEvents.append(value) }
    }

    private func candidateKind(_ line: String) -> String {
        let fields = line.split(separator: " ")
        let transport = fields.count > 2 ? fields[2].lowercased() : "unknown"
        let typeIndex = fields.firstIndex(of: "typ")
        let type = typeIndex.flatMap { fields.indices.contains($0 + 1) ? fields[$0 + 1] : nil } ?? "unknown"
        return "\(transport)-\(type)"
    }

    /// 只保留 candidate 的 transport/type 计数，不泄露 IP、端口、ufrag 或 SDP。
    private func candidateSummary(_ sdp: String?) -> String {
        guard let sdp else { return "none" }
        var counts: [String: Int] = [:]
        for line in sdp.split(whereSeparator: \.isNewline) where line.hasPrefix("a=candidate:") {
            counts[candidateKind(String(line)), default: 0] += 1
        }
        if counts.isEmpty { return "empty" }
        return counts.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ",")
    }

    private func candidateCount(_ sdp: String?, matching expectedKind: String) -> Int {
        guard let sdp else { return 0 }
        return sdp.split(whereSeparator: \.isNewline).count {
            $0.hasPrefix("a=candidate:") && candidateKind(String($0)) == expectedKind
        }
    }

    private func candidateCount(_ sdp: String?) -> Int {
        guard let sdp else { return 0 }
        return sdp.split(whereSeparator: \.isNewline).count { $0.hasPrefix("a=candidate:") }
    }

    func close() {
        lock.withLock {
            if receiveError == nil {
                receiveError = NativeP2PFramingError.dataChannelClosed
            }
        }
        dataChannel?.delegate = nil
        dataChannel?.close()
        peerConnection?.delegate = nil
        peerConnection?.close()
    }
}

extension NativeWebRTCOfferer: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        recordState("channel:\(dataChannel.readyState.rawValue)")
        guard dataChannel.readyState == .closed else { return }
        lock.withLock {
            if receiveError == nil {
                receiveError = NativeP2PFramingError.dataChannelClosed
            }
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard buffer.isBinary else {
            lock.lock()
            receiveError = NativeWebRTCProbeError.invalidMessage("DataChannel 收到 text message")
            lock.unlock()
            dataChannel.close()
            return
        }
        lock.lock()
        do {
            receivedFrames.append(contentsOf: try assembler.push(buffer.data))
        } catch {
            receiveError = error
        }
        let shouldClose = receiveError != nil
        lock.unlock()
        if shouldClose { dataChannel.close() }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didChangeBufferedAmount amount: UInt64) {}
}

extension RTCDataChannel: NativeP2PChunkChannel {
    var isOpen: Bool { readyState == .open }

    func sendChunk(_ chunk: Data) -> Bool {
        sendData(RTCDataBuffer(data: chunk, isBinary: true))
    }
}

extension NativeWebRTCOfferer: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        recordState("signal:\(stateChanged.rawValue)")
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        recordState("ice:\(newState.rawValue)")
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        recordState("gather:\(newState.rawValue)")
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let kind = candidateKind(candidate.sdp)
        lock.withLock { generatedCandidateKinds[kind, default: 0] += 1 }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        recordState("remote-channel:\(dataChannel.readyState.rawValue)")
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        recordState("peer:\(newState.rawValue)")
    }
}

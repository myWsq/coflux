import Foundation
@preconcurrency import WebRTC

enum NativeRTCError: Error {
    case creationFailed
    case closed
    case gatheringTimedOut
    case missingDescription
}

/// 只建立数据通道，不创建音视频轨道。中心信令与每条 channel 的授权由上层负责。
/// WebRTC 自有线程处理 ICE/SCTP；应用状态在 MainActor 上串行提交。
@MainActor
final class NativeRTCPeer: NSObject {
    private static let factory = RTCPeerConnectionFactory()
    private var peer: RTCPeerConnection?
    private var closed = false
    var onDataChannel: ((RTCDataChannel) -> Void)?
    var isAvailable: Bool {
        guard !closed, let peer else { return false }
        return peer.connectionState != .failed && peer.connectionState != .closed
    }

    init(iceServers: [String]) throws {
        super.init()
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.iceServers = iceServers.isEmpty ? [] : [RTCIceServer(urlStrings: iceServers)]
        peer = Self.factory.peerConnection(with: configuration,
            constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self)
        guard peer != nil else { throw NativeRTCError.creationFailed }
    }

    func createDataChannel(label: String) throws -> RTCDataChannel {
        guard !closed, let peer else { throw NativeRTCError.closed }
        let configuration = RTCDataChannelConfiguration()
        configuration.isOrdered = true
        // 不设置重传次数/时限：分帧协议要求 reliable + ordered。
        guard let channel = peer.dataChannel(forLabel: label, configuration: configuration) else {
            throw NativeRTCError.creationFailed
        }
        return channel
    }

    /// 首条 DataChannel 必须在调用前创建，offer 才包含 application m-line。
    func makeOffer() async throws -> String {
        do { return try await localDescription(type: .offer) }
        catch { close(); throw error }
    }

    func answer(offer: String) async throws -> String {
        do {
            try await setRemote(sdp: offer, type: .offer)
            return try await localDescription(type: .answer)
        } catch { close(); throw error }
    }

    func accept(answer: String) async throws {
        do { try await setRemote(sdp: answer, type: .answer) }
        catch { close(); throw error }
    }

    func close() {
        guard !closed else { return }
        closed = true
        onDataChannel = nil
        peer?.delegate = nil
        peer?.close()
        peer = nil
    }

    private func setRemote(sdp: String, type: RTCSdpType) async throws {
        try Task.checkCancellation()
        guard !closed, let peer else { throw NativeRTCError.closed }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            peer.setRemoteDescription(RTCSessionDescription(type: type, sdp: sdp)) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
        try Task.checkCancellation()
        guard !closed else { throw NativeRTCError.closed }
    }

    private func localDescription(type: RTCSdpType) async throws -> String {
        try Task.checkCancellation()
        guard !closed, let peer else { throw NativeRTCError.closed }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let description: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            let completion: @Sendable (RTCSessionDescription?, (any Error)?) -> Void = { description, error in
                if let error { continuation.resume(throwing: error) }
                else if let description { continuation.resume(returning: description) }
                else { continuation.resume(throwing: NativeRTCError.missingDescription) }
            }
            if type == .offer { peer.offer(for: constraints, completionHandler: completion) }
            else { peer.answer(for: constraints, completionHandler: completion) }
        }
        try Task.checkCancellation()
        guard !closed else { throw NativeRTCError.closed }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            peer.setLocalDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
        // 与 Web 一致：vanilla ICE 最多收集 3 秒，STUN 无响应时仍用已有候选继续。
        // 截止时间只结束收集等待，不代表连接失败；真正失败由后续建连/授权超时裁决。
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while peer.iceGatheringState != .complete {
            guard !closed else { throw NativeRTCError.closed }
            if ContinuousClock.now >= deadline { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        try Task.checkCancellation()
        guard !closed else { throw NativeRTCError.closed }
        guard let sdp = peer.localDescription?.sdp else { throw NativeRTCError.missingDescription }
        return sdp
    }
}

extension NativeRTCPeer: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closed else { dataChannel.close(); return }
            self.onDataChannel?(dataChannel)
        }
    }
}

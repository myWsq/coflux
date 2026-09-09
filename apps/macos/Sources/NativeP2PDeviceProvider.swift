import CofluxClientCore
import CofluxProtocol
import Foundation
@preconcurrency import WebRTC

struct NativeP2PError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// 按账号、设备、客户端实例复用 PeerConnection；每条 lane 独立申请中心授权。
@MainActor
final class NativeP2PDeviceProvider: P2PDeviceTransportProvider {
    private struct Key: Hashable {
        let account: String
        let daemon: String
        let client: String
    }
    @MainActor private final class Peer {
        let id = "p2p-\(UUID().uuidString)"
        let rtc: NativeRTCPeer
        let iceServers: [String]
        var negotiation: Task<Void, Never>?
        var result: Result<Void, any Error>?
        var channels: [String: NativeRTCConnection] = [:]
        init(iceServers: [String]) throws {
            self.iceServers = iceServers
            rtc = try NativeRTCPeer(iceServers: iceServers)
        }
    }
    private var peers: [Key: Peer] = [:]

    func closeAll() {
        for key in Array(peers.keys) { evict(key) }
    }
    func remove(daemonID: String) {
        for key in Array(peers.keys) where key.daemon == daemonID { evict(key) }
    }
    private func evict(_ key: Key) {
        guard let peer = peers.removeValue(forKey: key) else { return }
        peer.negotiation?.cancel()
        peer.rtc.close()
        let channels = Array(peer.channels.values)
        peer.channels.removeAll()
        for connection in channels { Task { await connection.close() } }
    }
    private func release(_ key: Key, peer: Peer, channelID: String) {
        guard peers[key] === peer else { return }
        if let connection = peer.channels.removeValue(forKey: channelID) {
            Task { await connection.close() }
        }
        if peer.channels.isEmpty { evict(key) }
    }

    func open(daemonID: String, accountID: String, clientInstanceID: String, generation: UInt64,
              iceServers: [String],
              authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload) async throws -> P2PDeviceChannel {
        try Task.checkCancellation()
        let key = Key(account: accountID, daemon: daemonID, client: clientInstanceID)
        if let peer = peers[key], !peer.rtc.isAvailable || peer.iceServers != iceServers { evict(key) }
        let peer: Peer
        if let existing = peers[key] { peer = existing }
        else { peer = try Peer(iceServers: iceServers); peers[key] = peer }
        let channelID = "p2p-\(UUID().uuidString)"
        let channel: RTCDataChannel
        do { channel = try peer.rtc.createDataChannel(label: channelID) }
        catch { if peer.channels.isEmpty { evict(key) }; throw error }
        let connection = NativeRTCConnection(channel: channel)
        peer.channels[channelID] = connection
        // 首个 channel 已创建，再生成 offer；后续 channel 走 DCEP，无需重复 SDP。
        if peer.negotiation == nil {
            peer.negotiation = Task { [weak self, weak peer] in
                guard let self, let peer else { return }
                do {
                    var offer = Coflux_V1_DeviceP2pOffer()
                    offer.daemonID = daemonID; offer.connectionID = peer.id
                    offer.clientInstanceID = clientInstanceID; offer.protocolVersion = 1
                    offer.sdp = try await peer.rtc.makeOffer()
                    try Task.checkCancellation()
                    let response = try await authorize(.deviceP2POffer(offer))
                    try Task.checkCancellation()
                    guard self.peers[key] === peer else { throw CancellationError() }
                    guard case .deviceP2PAnswer(let answer) = response, answer.connectionID == peer.id,
                          answer.ok, answer.hasSdp, !answer.sdp.isEmpty else {
                        throw NativeP2PError(message: "P2P 协商被拒绝或响应无效")
                    }
                    try await peer.rtc.accept(answer: answer.sdp)
                    peer.result = .success(())
                } catch { peer.result = .failure(error) }
            }
        }
        return try await withTaskCancellationHandler {
            do {
                let deadline = ContinuousClock.now.advanced(by: .seconds(10))
                while peer.result == nil {
                    try validate(key, peer: peer, channelID: channelID)
                    guard ContinuousClock.now < deadline else { throw NativeRTCError.gatheringTimedOut }
                    try await Task.sleep(for: .milliseconds(20))
                }
                try peer.result!.get()
                try validate(key, peer: peer, channelID: channelID)
                var request = Coflux_V1_DeviceP2pChannelOpen()
                request.daemonID = daemonID; request.connectionID = peer.id; request.channelID = channelID
                request.clientInstanceID = clientInstanceID; request.transportGeneration = generation
                request.protocolVersion = 1
                let response = try await authorize(.deviceP2PChannelOpen(request))
                try validate(key, peer: peer, channelID: channelID)
                guard case .deviceP2PChannelResult(let result) = response,
                      result.channelID == channelID, result.ok else {
                    throw NativeP2PError(message: "P2P 通道授权被拒绝或响应无效")
                }
                let openDeadline = ContinuousClock.now.advanced(by: .seconds(10))
                while true {
                    try validate(key, peer: peer, channelID: channelID)
                    // WebRTC 在自身线程推进状态；一轮只能读一次，避免 connecting→open 被第二次读取误拒。
                    let state = channel.readyState
                    if state == .open { break }
                    guard state == .connecting, ContinuousClock.now < openDeadline else {
                        NSLog("P2P channel open failed: state=%ld peerAvailable=%d timedOut=%d", state.rawValue, peer.rtc.isAvailable, ContinuousClock.now >= openDeadline)
                        throw NativeP2PError(message: "P2P 数据通道未能打开")
                    }
                    try await Task.sleep(for: .milliseconds(20))
                }
                try validate(key, peer: peer, channelID: channelID)
                let leased = P2PChannelLease(connection: connection) { [weak self] in
                    self?.release(key, peer: peer, channelID: channelID)
                }
                return P2PDeviceChannel(connection: leased, channelID: channelID)
            } catch {
                release(key, peer: peer, channelID: channelID)
                throw error
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.release(key, peer: peer, channelID: channelID) }
        }
    }

    private func validate(_ key: Key, peer: Peer, channelID: String) throws {
        try Task.checkCancellation()
        guard peers[key] === peer, peer.channels[channelID] != nil, peer.rtc.isAvailable else {
            throw NativeP2PError(message: "P2P 连接已关闭")
        }
    }
}

private final class P2PChannelLease: TransportConnection, Sendable {
    let connection: NativeRTCConnection
    let release: @MainActor @Sendable () -> Void
    init(connection: NativeRTCConnection, release: @escaping @MainActor @Sendable () -> Void) {
        self.connection = connection; self.release = release
    }
    func send(_ data: Data) async throws { try await connection.send(data) }
    func receive() async throws -> Data { try await connection.receive() }
    func close() async { await connection.close(); await release() }
}

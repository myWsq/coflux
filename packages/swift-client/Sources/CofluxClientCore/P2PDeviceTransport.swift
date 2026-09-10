import CofluxProtocol
import Foundation

public struct P2PDeviceChannel: Sendable {
    public let connection: any TransportConnection
    public let channelID: String
    public init(connection: any TransportConnection, channelID: String) {
        self.connection = connection
        self.channelID = channelID
    }
}

/// P2P 与 relay 均依赖中心在线授权。路由在中心断开或账号变更时必须 closeAll，
/// 设备移除时 remove；每条 channel 在中心授权成功后才能返回给路由。
@MainActor public protocol P2PDeviceTransportProvider: AnyObject {
    func open(daemonID: String, accountID: String, clientInstanceID: String, generation: UInt64,
              iceServers: [String],
              authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload) async throws -> P2PDeviceChannel
    func closeAll()
    func remove(daemonID: String)
}

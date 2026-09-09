import CofluxProtocol
import Foundation

public struct LocalDeviceChannel: Sendable {
    public let connection: any TransportConnection
    public let channelID: String
    public let scopes: [Coflux_V1_DeviceScope]
    public let leaseExpiresAt: Double?
    public init(connection: any TransportConnection, channelID: String, scopes: [Coflux_V1_DeviceScope], leaseExpiresAt: Double? = nil) {
        self.connection = connection; self.channelID = channelID; self.scopes = scopes; self.leaseExpiresAt = leaseExpiresAt
    }
}

/// Apple 组合层实现身份/存储/签名；协议核心仅管理授权请求、lane 和单调连接代际。
@MainActor public protocol LocalDeviceTransportProvider: AnyObject {
    func open(daemonID: String, accountID: String, clientInstanceID: String, generation: UInt64, elevated: Bool,
              authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload) async throws -> LocalDeviceChannel
    func clearGrants(accountID: String) throws
    func removeGrant(daemonID: String, accountID: String) throws
}

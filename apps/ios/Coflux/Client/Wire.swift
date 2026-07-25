import Foundation

/// protobuf 信封 encode/decode，对应 TS 的 encodeClientToServer/decodeServerToClient
/// （proto/coflux/v1/client.proto 的 oneof payload）。
enum Wire {
    static func encode(_ payload: Coflux_V1_ClientToServer.OneOf_Payload) throws -> Data {
        var envelope = Coflux_V1_ClientToServer()
        envelope.payload = payload
        return try envelope.serializedBytes()
    }

    static func decode(_ data: Data) -> Coflux_V1_ServerToClient.OneOf_Payload? {
        guard let envelope = try? Coflux_V1_ServerToClient(serializedBytes: data) else { return nil }
        return envelope.payload
    }
}

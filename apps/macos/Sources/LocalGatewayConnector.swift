import CofluxClientCore
import CofluxProtocol
import CryptoKit
import Foundation

struct LocalGatewayError: LocalizedError {
    let message: String
    let code: Coflux_V1_LocalAuthErrorCode?
    init(message: String, code: Coflux_V1_LocalAuthErrorCode? = nil) { self.message = message; self.code = code }
    var errorDescription: String? { message }
}

/// 当前 device.proto 的 P-256 / P1363 签名协议；仅负责认证，路由与授权续期由上层管理。
struct LocalGatewayConnector {
    let daemonID: String
    let origin: String
    let grantID: String
    let gateway: Coflux_V1_LocalGatewayDescriptor
    let identity: any LocalSigningIdentity

    static func number<T: FixedWidthInteger>(_ value: T) -> Data {
        var big = value.bigEndian
        return withUnsafeBytes(of: &big) { Data($0) }
    }
    static func transcript(_ domain: String, _ fields: [Data]) -> Data {
        var bytes = Data(domain.utf8); bytes.append(0)
        for field in fields { bytes.append(number(UInt32(field.count))); bytes.append(field) }
        return bytes
    }
    static func gatewayTranscript(_ hello: Coflux_V1_LocalGatewayHello) -> Data {
        transcript("coflux-local-gateway-v1", [number(hello.protocolVersion), Data(hello.daemonID.utf8), Data(hello.origin.utf8), hello.nonce])
    }
    func verify(_ hello: Coflux_V1_LocalGatewayHello) -> Bool {
        guard gateway.protocolVersion == 1, hello.protocolVersion == 1,
              hello.daemonID == daemonID, hello.origin == origin,
              hello.nonce.count == 32, hello.signatureP1363.count == 64,
              gateway.publicKeySec1.count == 65, gateway.publicKeySec1.first == 4,
              hello.gatewayPublicKeySec1 == gateway.publicKeySec1,
              let key = try? P256.Signing.PublicKey(x963Representation: gateway.publicKeySec1),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: hello.signatureP1363) else { return false }
        return key.isValidSignature(signature, for: Self.gatewayTranscript(hello))
    }
    func clientHello(_ hello: Coflux_V1_LocalGatewayHello, clientInstanceID: String, generation: UInt64, leaseID: String?) throws -> Coflux_V1_LocalClientHello {
        guard verify(hello), !grantID.isEmpty, !clientInstanceID.isEmpty else { throw LocalGatewayError(message: "本机网关身份验证失败") }
        var client = Coflux_V1_LocalClientHello()
        client.protocolVersion = 1; client.grantID = grantID
        client.browserPublicKeySec1 = identity.publicKeySec1
        client.clientInstanceID = clientInstanceID; client.transportGeneration = generation
        client.gatewayNonce = hello.nonce
        if let leaseID { client.leaseID = leaseID }
        let bytes = Self.transcript("coflux-local-client-v1", [Self.number(UInt32(1)), Data(daemonID.utf8), Data(origin.utf8),
            hello.nonce, gateway.publicKeySec1, Data(grantID.utf8), client.browserPublicKeySec1,
            Data(clientInstanceID.utf8), Self.number(generation), Data((leaseID ?? "").utf8)])
        client.signatureP1363 = try identity.signTranscript(bytes)
        return client
    }

    struct Authenticated: Sendable {
        let connection: any TransportConnection
        let channelID: String
        let scopes: [Coflux_V1_DeviceScope]
    }
    func connect(transport: any Transport, clientInstanceID: String, generation: UInt64, leaseID: String? = nil) async throws -> Authenticated {
        guard gateway.protocolVersion == 1, (1...65535).contains(gateway.port),
              let url = URL(string: "ws://127.0.0.1:\(gateway.port)/device") else { throw LocalGatewayError(message: "本机网关地址无效") }
        let connection = try await transport.connect(to: url)
        do {
            let envelope = try await Self.receive(connection)
            guard envelope.protocolVersion == 1, envelope.channelID.isEmpty,
                  case .localGatewayHello(let hello) = envelope.payload else { throw LocalGatewayError(message: "本机网关握手帧无效") }
            let client = try clientHello(hello, clientInstanceID: clientInstanceID, generation: generation, leaseID: leaseID)
            var request = Coflux_V1_DeviceEnvelope(); request.protocolVersion = 1; request.payload = .localClientHello(client)
            try await connection.send(request.serializedData())
            let response = try await Self.receive(connection)
            guard response.protocolVersion == 1, response.channelID.isEmpty,
                  case .localAuthResult(let auth) = response.payload else { throw LocalGatewayError(message: "本机网关认证响应无效") }
            guard auth.ok, auth.hasChannelID, !auth.channelID.isEmpty else { throw LocalGatewayError(message: auth.hasError ? auth.error : "本机网关拒绝认证", code: auth.errorCode) }
            try Task.checkCancellation()
            return Authenticated(connection: connection, channelID: auth.channelID, scopes: auth.scopes)
        } catch { await connection.close(); throw error }
    }
    private static func receive(_ connection: any TransportConnection) async throws -> Coflux_V1_DeviceEnvelope {
        try await withTaskCancellationHandler {
          try await withThrowingTaskGroup(of: Coflux_V1_DeviceEnvelope.self) { group in
            group.addTask { try Coflux_V1_DeviceEnvelope(serializedBytes: await connection.receive()) }
            group.addTask {
                try await Task.sleep(for: .seconds(3))
                await connection.close()
                throw LocalGatewayError(message: "本机网关握手超时")
            }
            defer { group.cancelAll() }
            return try await group.next()!
          }
        } onCancel: {
            Task { await connection.close() }
        }
    }
}

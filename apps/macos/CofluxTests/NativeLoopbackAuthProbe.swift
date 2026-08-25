import Foundation
import SwiftProtobuf
@testable import Coflux

enum NativeLoopbackProbeError: Error, CustomStringConvertible {
    case invalidMessage(String)
    case unavailable(String)

    var description: String {
        switch self {
        case .invalidMessage(let detail): return "loopback 消息无效：\(detail)"
        case .unavailable(let detail): return "loopback 不可用：\(detail)"
        }
    }
}

/// 最小 native loopback adapter：实际发 URLSession WebSocket upgrade、验证 worker P-256
/// challenge，再发送生产 protobuf LocalClientHello。它只服务可行性门，不复制完整 DeviceRouter。
final class NativeLoopbackAuthClient {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private var channelID: String?

    init(url: URL, origin: String) throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
        let request = try NativeLocalAuthWire.webSocketRequest(url: url, origin: origin)
        socket = session.webSocketTask(with: request)
        socket.resume()
    }

    func authenticate(
        identity: NativeP256Identity,
        grantID: String,
        daemonID: String,
        origin: String,
        expectedGateway: Coflux_V1_LocalGatewayDescriptor,
        clientInstanceID: String,
        transportGeneration: UInt64,
        leaseID: String? = nil,
        timeout: TimeInterval = 15
    ) throws -> Coflux_V1_LocalAuthResult {
        guard transportGeneration > 0 else {
            throw NativeLoopbackProbeError.invalidMessage("transport generation 必须大于 0")
        }
        let gatewayEnvelope = try receiveEnvelope(timeout: timeout)
        guard gatewayEnvelope.protocolVersion == NativeLocalAuthWire.protocolVersion,
              gatewayEnvelope.channelID.isEmpty,
              case .localGatewayHello(let hello)? = gatewayEnvelope.payload
        else {
            throw NativeLoopbackProbeError.invalidMessage("首帧不是 LocalGatewayHello")
        }
        guard hello.protocolVersion == NativeLocalAuthWire.protocolVersion,
              hello.daemonID == daemonID,
              hello.origin == origin,
              hello.nonce.count == 32,
              hello.gatewayPublicKeySec1 == expectedGateway.publicKeySec1,
              expectedGateway.protocolVersion == NativeLocalAuthWire.protocolVersion
        else {
            throw NativeLoopbackProbeError.invalidMessage("signed gateway hello 与 pair descriptor 不一致")
        }
        let gatewayTranscript = try NativeLocalAuthWire.gatewayTranscript(
            daemonID: hello.daemonID,
            origin: hello.origin,
            nonce: hello.nonce
        )
        guard NativeLocalAuthWire.verifyGatewaySignature(
            publicKeySec1: hello.gatewayPublicKeySec1,
            signatureP1363: hello.signatureP1363,
            transcript: gatewayTranscript
        ) else {
            throw NativeLoopbackProbeError.invalidMessage("gateway P-256 signature 无效")
        }

        let clientTranscript = try NativeLocalAuthWire.clientTranscript(
            daemonID: daemonID,
            origin: origin,
            nonce: hello.nonce,
            gatewayPublicKeySec1: hello.gatewayPublicKeySec1,
            grantID: grantID,
            browserPublicKeySec1: identity.publicKeySec1,
            clientInstanceID: clientInstanceID,
            transportGeneration: transportGeneration,
            leaseID: leaseID
        )
        var clientHello = Coflux_V1_LocalClientHello()
        clientHello.protocolVersion = NativeLocalAuthWire.protocolVersion
        clientHello.grantID = grantID
        clientHello.browserPublicKeySec1 = identity.publicKeySec1
        clientHello.clientInstanceID = clientInstanceID
        clientHello.transportGeneration = transportGeneration
        if let leaseID { clientHello.leaseID = leaseID }
        clientHello.gatewayNonce = hello.nonce
        clientHello.signatureP1363 = try identity.signP1363(clientTranscript)

        var envelope = Coflux_V1_DeviceEnvelope()
        envelope.protocolVersion = NativeLocalAuthWire.protocolVersion
        envelope.channelID = ""
        envelope.payload = .localClientHello(clientHello)
        try sendEnvelope(envelope, timeout: timeout)

        let authEnvelope = try receiveEnvelope(timeout: timeout)
        guard authEnvelope.protocolVersion == NativeLocalAuthWire.protocolVersion,
              authEnvelope.channelID.isEmpty,
              case .localAuthResult(let result)? = authEnvelope.payload
        else {
            throw NativeLoopbackProbeError.invalidMessage("第二帧不是 LocalAuthResult")
        }
        if result.ok {
            guard result.hasChannelID, !result.channelID.isEmpty else {
                throw NativeLoopbackProbeError.invalidMessage("成功认证缺少 channelId")
            }
            channelID = result.channelID
        }
        return result
    }

    func requestSessionCatalog(timeout: TimeInterval = 10) throws -> Coflux_V1_DeviceEnvelope.OneOf_Payload {
        let requestID = "native-catalog-\(UUID().uuidString)"
        var request = Coflux_V1_DeviceSessionCatalogRequest()
        request.requestID = requestID
        return try requestResponse(payload: .sessionCatalogRequest(request), requestID: requestID, timeout: timeout) {
            if case .sessionCatalog(let value) = $0 { return value.requestID == requestID }
            return false
        }
    }

    func requestPorts(timeout: TimeInterval = 10) throws -> Coflux_V1_DeviceEnvelope.OneOf_Payload {
        let requestID = "native-ports-\(UUID().uuidString)"
        var request = Coflux_V1_DevicePortsRequest()
        request.requestID = requestID
        return try requestResponse(payload: .portsRequest(request), requestID: requestID, timeout: timeout) {
            if case .portsResult(let value) = $0 { return value.requestID == requestID }
            return false
        }
    }

    func ping(timeout: TimeInterval = 10) throws -> Coflux_V1_DeviceEnvelope.OneOf_Payload {
        let requestID = "native-ping-\(UUID().uuidString)"
        var request = Coflux_V1_DevicePing()
        request.requestID = requestID
        return try requestResponse(payload: .ping(request), requestID: requestID, timeout: timeout) {
            if case .pong(let value) = $0 { return value.requestID == requestID }
            return false
        }
    }

    func waitForClosure(timeout: TimeInterval) -> Bool {
        do {
            _ = try receiveEnvelope(timeout: timeout)
            return false
        } catch NativeWebRTCProbeError.timeout {
            return false
        } catch {
            return true
        }
    }

    func awaitFirstEnvelope(timeout: TimeInterval) throws -> Coflux_V1_DeviceEnvelope {
        try receiveEnvelope(timeout: timeout)
    }

    func close() {
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    private func requestResponse(
        payload: Coflux_V1_DeviceEnvelope.OneOf_Payload,
        requestID: String,
        timeout: TimeInterval,
        matching predicate: (Coflux_V1_DeviceEnvelope.OneOf_Payload) -> Bool
    ) throws -> Coflux_V1_DeviceEnvelope.OneOf_Payload {
        guard let channelID else {
            throw NativeLoopbackProbeError.unavailable("尚未认证")
        }
        var envelope = Coflux_V1_DeviceEnvelope()
        envelope.protocolVersion = NativeLocalAuthWire.protocolVersion
        envelope.channelID = channelID
        envelope.payload = payload
        try sendEnvelope(envelope, timeout: timeout)

        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { throw NativeWebRTCProbeError.timeout("loopback response") }
            let response = try receiveEnvelope(timeout: remaining)
            guard response.protocolVersion == NativeLocalAuthWire.protocolVersion,
                  response.channelID == channelID,
                  let responsePayload = response.payload
            else { continue }
            if predicate(responsePayload) { return responsePayload }
            if case .error(let error) = responsePayload,
               !error.hasRequestID || error.requestID == requestID {
                return responsePayload
            }
        }
    }

    private func sendEnvelope(_ envelope: Coflux_V1_DeviceEnvelope, timeout: TimeInterval) throws {
        let completion = NativeBlockingResult<Void>()
        let bytes = try envelope.serializedData()
        socket.send(.data(bytes)) { error in
            if let error { completion.complete(.failure(error)) }
            else { completion.complete(.success(())) }
        }
        _ = try completion.wait(timeout: timeout, label: "loopback WS send")
    }

    private func receiveEnvelope(timeout: TimeInterval) throws -> Coflux_V1_DeviceEnvelope {
        let completion = NativeBlockingResult<URLSessionWebSocketTask.Message>()
        socket.receive { result in completion.complete(result.mapError { $0 as Error }) }
        let message = try completion.wait(timeout: timeout, label: "loopback WS receive")
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string: throw NativeLoopbackProbeError.invalidMessage("收到 text frame")
        @unknown default: throw NativeLoopbackProbeError.invalidMessage("收到未知 frame")
        }
        return try Coflux_V1_DeviceEnvelope(serializedBytes: data)
    }
}

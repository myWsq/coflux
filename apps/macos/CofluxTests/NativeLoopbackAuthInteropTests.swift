import Darwin
import Foundation
import XCTest
@testable import Coflux

final class NativeLoopbackAuthInteropTests: XCTestCase {
    func testNativeIdentityInteroperatesWithRealLoopbackGateway() throws {
        let config = try interopConfiguration()
        let store = NativeIdentityStore(service: config.identityService, account: config.identityAccount)
        switch config.phase {
        case .bootstrap:
            try bootstrap(config: config, store: store)
        case .restart:
            try restart(config: config, store: store)
        case .networkDenied:
            try assertSandboxDeniesNetwork(config: config)
        case .cleanup:
            try store.delete()
            XCTAssertNil(try store.load(), "interop Keychain identity 必须删除")
            try emitMarker(["cleanup": true])
        }
    }

    private func bootstrap(config: InteropConfiguration, store: NativeIdentityStore) throws {
        try store.delete()
        let identity = try store.loadOrCreate()
        let control = NativeP2PControlClient(url: config.controlURL, origin: config.origin)
        defer { control.close() }
        _ = try control.authenticate(username: config.username, password: config.password)

        let mismatch = try pair(
            control: control,
            daemonID: config.daemonID,
            origin: config.wrongOrigin,
            identity: identity
        )
        XCTAssertFalse(mismatch.ok)
        XCTAssertTrue(mismatch.hasError)
        XCTAssertTrue(mismatch.error.contains("Origin"), mismatch.error)

        let paired = try pair(
            control: control,
            daemonID: config.daemonID,
            origin: config.origin,
            identity: identity
        )
        try assertPairSucceeded(paired)
        let gateway = paired.gateway
        let gatewayURL = try loopbackURL(gateway)

        let wrongOriginClient = try NativeLoopbackAuthClient(url: gatewayURL, origin: config.wrongOrigin)
        defer { wrongOriginClient.close() }
        do {
            _ = try wrongOriginClient.awaitFirstEnvelope(timeout: 5)
            XCTFail("未授权 Origin 的 loopback upgrade 必须被 worker 拒绝")
        } catch NativeWebRTCProbeError.timeout {
            throw NativeLoopbackProbeError.unavailable("错误 Origin 的 upgrade 没有明确失败，只发生超时")
        } catch let probeError as NativeLoopbackProbeError {
            throw NativeLoopbackProbeError.unavailable(
                "错误 Origin 返回了协议错误而非 HTTP upgrade 拒绝：\(probeError)"
            )
        } catch {
            let handshakeError = error as NSError
            guard handshakeError.domain == NSURLErrorDomain,
                  handshakeError.code == NSURLErrorBadServerResponse else {
                throw NativeLoopbackProbeError.unavailable(
                    "错误 Origin 返回了非 HTTP handshake 错误：\(handshakeError.domain) \(handshakeError.code)"
                )
            }
        }

        let direct = try NativeLoopbackAuthClient(url: gatewayURL, origin: config.origin)
        defer { direct.close() }
        let auth = try direct.authenticate(
            identity: identity,
            grantID: paired.grantID,
            daemonID: config.daemonID,
            origin: config.origin,
            expectedGateway: gateway,
            clientInstanceID: config.clientInstanceID,
            transportGeneration: 1
        )
        XCTAssertTrue(auth.ok, auth.error)
        XCTAssertEqual(Set(auth.scopes), Set([.sessionRead, .sessionControl]))
        guard case .sessionCatalog = try direct.requestSessionCatalog() else {
            throw NativeLoopbackProbeError.invalidMessage("session grant 未完成真实 catalog 请求")
        }
        try assertScopeDenied(try direct.requestPorts())

        let state = PersistedInteropState(
            phaseAComplete: true,
            grantID: paired.grantID,
            gateway: gateway,
            browserPublicKeySec1: identity.publicKeySec1,
            controlOriginObserved: true,
            loopbackOriginObserved: true,
            gatewaySignatureVerified: true
        )
        try emitState(state)
        print("COFLUX_LOOPBACK_ORIGIN control=observed loopback=observed signature=verified")
    }

    private func restart(config: InteropConfiguration, store: NativeIdentityStore) throws {
        defer { try? store.delete() }
        let state = try XCTUnwrap(config.state, "第二个 XCTest process 必须收到 phase A 的非秘密 grant metadata")
        XCTAssertTrue(state.phaseAComplete)
        let identity = try XCTUnwrap(store.load(), "第二个 XCTest process 必须从 Keychain 读取原 identity")
        XCTAssertEqual(identity.publicKeySec1, state.browserPublicKeySec1)
        let gatewayURL = try loopbackURL(state.gateway)

        // 在重新 pair 之前直接使用 phase A 缓存的 grant/gateway，证明 App restart 不依赖
        // 中心重新授权即可恢复 session scope。
        let resumed = try NativeLoopbackAuthClient(url: gatewayURL, origin: config.origin)
        defer { resumed.close() }
        let resumedAuth = try resumed.authenticate(
            identity: identity,
            grantID: state.grantID,
            daemonID: config.daemonID,
            origin: config.origin,
            expectedGateway: state.gateway,
            clientInstanceID: config.clientInstanceID,
            transportGeneration: 2
        )
        XCTAssertTrue(resumedAuth.ok, resumedAuth.error)
        XCTAssertEqual(Set(resumedAuth.scopes), Set([.sessionRead, .sessionControl]))
        guard case .sessionCatalog = try resumed.requestSessionCatalog() else {
            throw NativeLoopbackProbeError.invalidMessage("restart 后缓存 grant 不能读取 session catalog")
        }
        try assertScopeDenied(try resumed.requestPorts())

        let control = NativeP2PControlClient(url: config.controlURL, origin: config.origin)
        defer { control.close() }
        _ = try control.authenticate(username: config.username, password: config.password)
        let repaired = try pair(
            control: control,
            daemonID: config.daemonID,
            origin: config.origin,
            identity: identity
        )
        try assertPairSucceeded(repaired)
        XCTAssertEqual(repaired.grantID, state.grantID, "同 key/origin 的 restart pair 必须复用 grant")
        XCTAssertEqual(repaired.gateway.publicKeySec1, state.gateway.publicKeySec1)

        // stale grant + 新 key 必须给出可分类的 KEY_MISMATCH，而不是模糊 timeout。
        try store.delete()
        let replacementIdentity = try store.loadOrCreate()
        XCTAssertNotEqual(replacementIdentity.publicKeySec1, identity.publicKeySec1)
        XCTAssertEqual(
            try XCTUnwrap(store.load()).publicKeySec1,
            replacementIdentity.publicKeySec1,
            "key mismatch 恢复后的 replacement identity 必须写回 Keychain"
        )
        let mismatched = try NativeLoopbackAuthClient(url: gatewayURL, origin: config.origin)
        defer { mismatched.close() }
        let mismatchAuth = try mismatched.authenticate(
            identity: replacementIdentity,
            grantID: state.grantID,
            daemonID: config.daemonID,
            origin: config.origin,
            expectedGateway: state.gateway,
            clientInstanceID: "replacement-\(UUID().uuidString)",
            transportGeneration: 3
        )
        XCTAssertFalse(mismatchAuth.ok)
        XCTAssertEqual(mismatchAuth.errorCode, .keyMismatch)

        // 客户端清掉 stale cache 后以当前 key 重新 pair，得到新 grant 并恢复 direct。
        let replacementPair = try pair(
            control: control,
            daemonID: config.daemonID,
            origin: config.origin,
            identity: replacementIdentity
        )
        try assertPairSucceeded(replacementPair)
        XCTAssertNotEqual(replacementPair.grantID, state.grantID)
        let replacement = try NativeLoopbackAuthClient(url: try loopbackURL(replacementPair.gateway), origin: config.origin)
        defer { replacement.close() }
        let replacementAuth = try replacement.authenticate(
            identity: replacementIdentity,
            grantID: replacementPair.grantID,
            daemonID: config.daemonID,
            origin: config.origin,
            expectedGateway: replacementPair.gateway,
            clientInstanceID: "replacement-\(UUID().uuidString)",
            transportGeneration: 4
        )
        XCTAssertTrue(replacementAuth.ok, replacementAuth.error)
        guard case .sessionCatalog = try replacement.requestSessionCatalog() else {
            throw NativeLoopbackProbeError.invalidMessage("key mismatch 恢复后 session scope 不可用")
        }

        // rotate 后所有新能力都必须由当前持久化 identity/grant 获得；旧私钥仅用于下方
        // 验证旧 grant 的撤销，不允许它替代真实客户端状态继续取得 elevated scope。
        let lease = try requestLease(
            control: control,
            daemonID: config.daemonID,
            grantID: replacementPair.grantID
        )
        XCTAssertEqual(Set(lease.scopes), Set([.rpc, .lifecycle]))
        XCTAssertTrue(NativeLocalAuthWire.leaseIsValid(expiresAtMilliseconds: lease.expiresAt))
        let elevated = try openElevatedWithInstallRaceRetry(
            identity: replacementIdentity,
            grantID: replacementPair.grantID,
            gateway: replacementPair.gateway,
            lease: lease,
            config: config
        )
        defer { elevated.client.close() }
        XCTAssertEqual(Set(elevated.auth.scopes), Set([.sessionRead, .sessionControl, .rpc, .lifecycle]))
        guard case .portsResult = try elevated.client.requestPorts() else {
            throw NativeLoopbackProbeError.invalidMessage("elevated lease 未完成真实 RPC")
        }

        let expiryWait = max(0, lease.expiresAt / 1_000 - Date().timeIntervalSince1970 + 0.35)
        Thread.sleep(forTimeInterval: expiryWait)
        XCTAssertFalse(NativeLocalAuthWire.leaseIsValid(expiresAtMilliseconds: lease.expiresAt))
        try assertScopeDenied(try elevated.client.requestPorts())
        guard case .pong = try elevated.client.ping() else {
            throw NativeLoopbackProbeError.invalidMessage("lease expiry 后 session scope 未保留")
        }

        let expired = try NativeLoopbackAuthClient(
            url: try loopbackURL(replacementPair.gateway),
            origin: config.origin
        )
        defer { expired.close() }
        let expiredAuth = try expired.authenticate(
            identity: replacementIdentity,
            grantID: replacementPair.grantID,
            daemonID: config.daemonID,
            origin: config.origin,
            expectedGateway: replacementPair.gateway,
            clientInstanceID: config.clientInstanceID,
            transportGeneration: 6,
            leaseID: lease.leaseID
        )
        XCTAssertFalse(expiredAuth.ok)
        XCTAssertEqual(expiredAuth.errorCode, .leaseInvalid)

        let unpaired = try unpair(control: control, daemonID: config.daemonID, grantID: state.grantID)
        XCTAssertTrue(unpaired.ok, unpaired.error)
        XCTAssertTrue(resumed.waitForClosure(timeout: 10), "unpair 返回后必须关闭旧 grant channel")

        // replacement grant 保留同一 Origin allowlist，因此旧 grant 的新握手应到达 auth 层并
        // 明确返回 GRANT_UNKNOWN，而不是被 403 掩盖。
        var revokedCode: Coflux_V1_LocalAuthErrorCode?
        for attempt in 0..<8 where revokedCode == nil {
            let revoked = try NativeLoopbackAuthClient(url: gatewayURL, origin: config.origin)
            let result = try revoked.authenticate(
                identity: identity,
                grantID: state.grantID,
                daemonID: config.daemonID,
                origin: config.origin,
                expectedGateway: state.gateway,
                clientInstanceID: config.clientInstanceID,
                transportGeneration: UInt64(7 + attempt)
            )
            revoked.close()
            if !result.ok { revokedCode = result.errorCode }
            else { Thread.sleep(forTimeInterval: 0.05) }
        }
        XCTAssertEqual(revokedCode, .grantUnknown)
        guard case .pong = try replacement.ping() else {
            throw NativeLoopbackProbeError.invalidMessage("撤销旧 grant 破坏了恢复后的 replacement grant")
        }
        guard case .pong = try elevated.client.ping() else {
            throw NativeLoopbackProbeError.invalidMessage("撤销旧 grant 破坏了 replacement elevated channel 的 session scope")
        }

        let replacementUnpair = try unpair(
            control: control,
            daemonID: config.daemonID,
            grantID: replacementPair.grantID
        )
        XCTAssertTrue(replacementUnpair.ok, replacementUnpair.error)
        XCTAssertTrue(replacement.waitForClosure(timeout: 10), "撤销 replacement grant 后必须关闭 session channel")
        XCTAssertTrue(elevated.client.waitForClosure(timeout: 10), "撤销 replacement grant 后必须关闭 elevated channel")
        try emitMarker(
            [
                "restart": true,
                "grantReused": true,
                "keyMismatchRecovered": true,
                "leaseExpired": true,
                "grantRevoked": true,
            ]
        )
        print("COFLUX_LOOPBACK_AUTH restart=reused key_mismatch=recovered lease=expired revoke=observed")
    }

    private func assertSandboxDeniesNetwork(config: InteropConfiguration) throws {
        let control = NativeP2PControlClient(url: config.controlURL, origin: config.origin)
        defer { control.close() }
        do {
            _ = try control.authenticate(username: config.username, password: config.password, timeout: 5)
            XCTFail("缺少 network.client entitlement 的 App Sandbox 构型不应连接 control WS")
        } catch let probeError as NativeWebRTCProbeError {
            throw NativeLoopbackProbeError.unavailable(
                "sandbox 负向门收到协议/超时错误而非底层网络拒绝：\(probeError)"
            )
        } catch {
            let networkError = error as NSError
            guard isSandboxPermissionDenied(networkError) else {
                throw NativeLoopbackProbeError.unavailable(
                    "sandbox 负向门收到非 EPERM/EACCES 错误：\(networkError.domain) \(networkError.code)"
                )
            }
            try emitMarker([
                "networkDenied": true,
                "errorDomain": networkError.domain,
                "errorCode": networkError.code,
            ])
            print(
                "COFLUX_LOOPBACK_PERMISSION sandbox_without_network_client=denied "
                + "domain=\(networkError.domain) code=\(networkError.code)"
            )
        }
    }

    /// macOS 27 的 URLSession 会把 App Sandbox deny 报为 `NSURLErrorDomain/1`；
    /// 旧系统也可能把同一 errno 放在 `NSUnderlyingErrorKey` 的 NSPOSIXErrorDomain 中。
    /// 只接受 EPERM/EACCES，明确排除 timeout、cancel、HTTP upgrade 与普通连接失败。
    private func isSandboxPermissionDenied(_ error: NSError, depth: Int = 0) -> Bool {
        guard depth < 8 else { return false }
        let permissionCodes = [Int(EPERM), Int(EACCES)]
        if error.domain == NSPOSIXErrorDomain, permissionCodes.contains(error.code) {
            return true
        }
        if error.domain == NSURLErrorDomain, permissionCodes.contains(error.code) {
            return true
        }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            return isSandboxPermissionDenied(underlying, depth: depth + 1)
        }
        return false
    }

    private struct ElevatedConnection {
        let client: NativeLoopbackAuthClient
        let auth: Coflux_V1_LocalAuthResult
    }

    private func openElevatedWithInstallRaceRetry(
        identity: NativeP256Identity,
        grantID: String,
        gateway: Coflux_V1_LocalGatewayDescriptor,
        lease: Coflux_V1_OnlineDeviceLease,
        config: InteropConfiguration
    ) throws -> ElevatedConnection {
        var lastError = "lease 尚未安装"
        let deadline = Date().addingTimeInterval(3)
        var attempt = 0
        while Date() < deadline {
            let client = try NativeLoopbackAuthClient(url: try loopbackURL(gateway), origin: config.origin)
            let auth = try client.authenticate(
                identity: identity,
                grantID: grantID,
                daemonID: config.daemonID,
                origin: config.origin,
                expectedGateway: gateway,
                clientInstanceID: config.clientInstanceID,
                transportGeneration: UInt64(100 + attempt),
                leaseID: lease.leaseID
            )
            if auth.ok { return ElevatedConnection(client: client, auth: auth) }
            lastError = auth.error
            client.close()
            guard auth.errorCode == .leaseInvalid else {
                throw NativeLoopbackProbeError.unavailable("elevated auth 被拒：\(auth.error)")
            }
            Thread.sleep(forTimeInterval: min(0.25, 0.05 * pow(1.5, Double(attempt))))
            attempt += 1
        }
        throw NativeLoopbackProbeError.unavailable(lastError)
    }

    private func pair(
        control: NativeP2PControlClient,
        daemonID: String,
        origin: String,
        identity: NativeP256Identity
    ) throws -> Coflux_V1_LocalPairResult {
        let requestID = "native-pair-\(UUID().uuidString)"
        var request = Coflux_V1_LocalPairRequest()
        request.requestID = requestID
        request.daemonID = daemonID
        request.origin = origin
        request.browserPublicKeySec1 = identity.publicKeySec1
        try control.send(.localPairRequest(request))
        let payload = try control.waitPayload(timeout: 20) {
            if case .localPairResult(let result) = $0 { return result.requestID == requestID }
            return false
        }
        guard case .localPairResult(let result) = payload else {
            throw NativeLoopbackProbeError.invalidMessage("未收到 LocalPairResult")
        }
        return result
    }

    private func requestLease(
        control: NativeP2PControlClient,
        daemonID: String,
        grantID: String
    ) throws -> Coflux_V1_OnlineDeviceLease {
        let requestID = "native-lease-\(UUID().uuidString)"
        var request = Coflux_V1_LocalLeaseRequest()
        request.requestID = requestID
        request.daemonID = daemonID
        request.grantID = grantID
        try control.send(.localLeaseRequest(request))
        let payload = try control.waitPayload(timeout: 20) {
            if case .localLeaseResult(let result) = $0 { return result.requestID == requestID }
            return false
        }
        guard case .localLeaseResult(let result) = payload,
              result.ok,
              result.hasLease else {
            throw NativeLoopbackProbeError.unavailable("中心未签发 elevated lease")
        }
        return result.lease
    }

    private func unpair(
        control: NativeP2PControlClient,
        daemonID: String,
        grantID: String
    ) throws -> Coflux_V1_LocalUnpairResult {
        let requestID = "native-unpair-\(UUID().uuidString)"
        var request = Coflux_V1_LocalUnpairRequest()
        request.requestID = requestID
        request.daemonID = daemonID
        request.grantID = grantID
        try control.send(.localUnpairRequest(request))
        let payload = try control.waitPayload(timeout: 20) {
            if case .localUnpairResult(let result) = $0 { return result.requestID == requestID }
            return false
        }
        guard case .localUnpairResult(let result) = payload else {
            throw NativeLoopbackProbeError.invalidMessage("未收到 LocalUnpairResult")
        }
        return result
    }

    private func assertPairSucceeded(
        _ result: Coflux_V1_LocalPairResult,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        XCTAssertTrue(result.ok, result.error, file: file, line: line)
        guard result.ok, result.hasGrantID, !result.grantID.isEmpty, result.hasGateway else {
            throw NativeLoopbackProbeError.invalidMessage("pair 成功结果缺少 grant/gateway")
        }
        XCTAssertEqual(result.gateway.protocolVersion, NativeLocalAuthWire.protocolVersion, file: file, line: line)
        XCTAssertGreaterThan(result.gateway.port, 0, file: file, line: line)
        XCTAssertEqual(result.gateway.publicKeySec1.count, 65, file: file, line: line)
        XCTAssertEqual(result.gateway.publicKeySec1.first, 4, file: file, line: line)
    }

    private func assertScopeDenied(
        _ payload: Coflux_V1_DeviceEnvelope.OneOf_Payload,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        guard case .error(let error) = payload else {
            XCTFail("无 elevated lease 的 RPC 必须返回 DeviceError", file: file, line: line)
            return
        }
        XCTAssertEqual(error.code, "scope_denied", file: file, line: line)
    }

    private func loopbackURL(_ gateway: Coflux_V1_LocalGatewayDescriptor) throws -> URL {
        guard gateway.port > 0,
              gateway.port < 65_536,
              let url = URL(string: "ws://127.0.0.1:\(gateway.port)/device") else {
            throw NativeLoopbackProbeError.invalidMessage("gateway port 无效")
        }
        return url
    }

    private enum Phase: String, Decodable {
        case bootstrap
        case restart
        case networkDenied
        case cleanup
    }

    private struct InteropConfiguration: Decodable {
        let phase: Phase
        let controlURL: URL
        let origin: String
        let wrongOrigin: String
        let username: String
        let password: String
        let daemonID: String
        let clientInstanceID: String
        let identityService: String
        let identityAccount: String
        let state: PersistedInteropState?
    }

    private struct PersistedInteropState: Codable {
        let phaseAComplete: Bool
        let grantID: String
        let gatewayProtocolVersion: UInt32
        let gatewayPort: UInt32
        let gatewayPublicKeySec1: Data
        let browserPublicKeySec1: Data
        let controlOriginObserved: Bool
        let loopbackOriginObserved: Bool
        let gatewaySignatureVerified: Bool

        init(
            phaseAComplete: Bool,
            grantID: String,
            gateway: Coflux_V1_LocalGatewayDescriptor,
            browserPublicKeySec1: Data,
            controlOriginObserved: Bool,
            loopbackOriginObserved: Bool,
            gatewaySignatureVerified: Bool
        ) {
            self.phaseAComplete = phaseAComplete
            self.grantID = grantID
            gatewayProtocolVersion = gateway.protocolVersion
            gatewayPort = gateway.port
            gatewayPublicKeySec1 = gateway.publicKeySec1
            self.browserPublicKeySec1 = browserPublicKeySec1
            self.controlOriginObserved = controlOriginObserved
            self.loopbackOriginObserved = loopbackOriginObserved
            self.gatewaySignatureVerified = gatewaySignatureVerified
        }

        var gateway: Coflux_V1_LocalGatewayDescriptor {
            var value = Coflux_V1_LocalGatewayDescriptor()
            value.protocolVersion = gatewayProtocolVersion
            value.port = gatewayPort
            value.publicKeySec1 = gatewayPublicKeySec1
            return value
        }
    }

    private func interopConfiguration() throws -> InteropConfiguration {
        let environment = ProcessInfo.processInfo.environment
        guard let encoded = environment["COFLUX_LOOPBACK_CONFIG_BASE64"],
              !encoded.isEmpty,
              encoded != "$(COFLUX_LOOPBACK_CONFIG_BASE64)" else {
            throw XCTSkip("真实 loopback auth interop 仅由 test-loopback-auth-interop.sh 启动")
        }
        guard let data = Data(base64Encoded: encoded) else {
            throw NativeLoopbackProbeError.invalidMessage("loopback interop 配置不是合法 base64")
        }
        return try JSONDecoder().decode(
            InteropConfiguration.self,
            from: data
        )
    }

    private func emitState(_ state: PersistedInteropState) throws {
        let data = try JSONEncoder().encode(state)
        print("COFLUX_LOOPBACK_STATE \(data.base64EncodedString())")
    }

    private func emitMarker(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print("COFLUX_LOOPBACK_RESULT \(data.base64EncodedString())")
    }
}

import CryptoKit
import Foundation
import Security
import XCTest
@testable import Coflux

final class NativeIdentityTests: XCTestCase {
    func testP256WireFormatAndFrozenTranscripts() throws {
        let scalarOne = Data(repeating: 0, count: 31) + Data([1])
        let knownIdentity = try NativeP256Identity(rawPrivateKey: scalarOne)
        XCTAssertEqual(
            knownIdentity.publicKeySec1.map { String(format: "%02x", $0) }.joined(),
            "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
                + "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
        )

        let identity = NativeP256Identity()
        XCTAssertEqual(identity.publicKeySec1.count, 65)
        XCTAssertEqual(identity.publicKeySec1.first, 4)

        let nonce = Data((0..<32).map(UInt8.init))
        let gateway = try NativeLocalAuthWire.gatewayTranscript(
            daemonID: "daemon-测试",
            origin: "https://app.coflux.dev",
            nonce: nonce
        )
        XCTAssertEqual(gateway.count, 111)
        XCTAssertEqual(
            sha256Hex(gateway),
            "7dcafb623b211d7dcf21dfbabf170983e487db3d8b8a934e0cd7843dd39c1a28"
        )

        let gatewayKey = Data([4]) + Data(repeating: 0x11, count: 64)
        let browserKey = Data([4]) + Data(repeating: 0x22, count: 64)
        let client = try NativeLocalAuthWire.clientTranscript(
            daemonID: "daemon-测试",
            origin: "https://app.coflux.dev",
            nonce: nonce,
            gatewayPublicKeySec1: gatewayKey,
            grantID: "grant-1",
            browserPublicKeySec1: browserKey,
            clientInstanceID: "client-1",
            transportGeneration: 42,
            leaseID: "lease-1"
        )
        XCTAssertEqual(client.count, 294)
        XCTAssertEqual(
            sha256Hex(client),
            "d00b45d561fa8ab6de1081bf9c48f4e86f445ba111a0e4b2670c5ee4cac4b26d"
        )

        let signature = try identity.signP1363(client)
        XCTAssertEqual(signature.count, 64)
        XCTAssertTrue(
            NativeLocalAuthWire.verifyGatewaySignature(
                publicKeySec1: identity.publicKeySec1,
                signatureP1363: signature,
                transcript: client
            )
        )
        var tamperedSignature = signature
        tamperedSignature[0] ^= 1
        XCTAssertFalse(
            NativeLocalAuthWire.verifyGatewaySignature(
                publicKeySec1: identity.publicKeySec1,
                signatureP1363: tamperedSignature,
                transcript: client
            )
        )
        XCTAssertFalse(
            NativeLocalAuthWire.verifyGatewaySignature(
                publicKeySec1: identity.publicKeySec1,
                signatureP1363: signature,
                transcript: client + Data([0])
            )
        )
    }

    func testConcurrentKeychainCreationHasOneWinner() async throws {
        // 使用固定且仅供测试的 locator：即使 XCTest 被 SIGKILL，下次运行也能在开头
        // 精确清掉残留，不留下只能靠枚举整个 Keychain 才能定位的随机 item。
        let service = "dev.coflux.macos.identity-race-tests"
        let store = NativeIdentityStore(service: service, account: "p256-signing-key")
        defer { try? store.delete() }
        try store.delete()

        let publicKeys = try await withThrowingTaskGroup(of: Data.self) { group in
            for _ in 0..<8 {
                group.addTask { try store.loadOrCreate().publicKeySec1 }
            }
            var values: [Data] = []
            for try await value in group { values.append(value) }
            return values
        }

        XCTAssertEqual(publicKeys.count, 8)
        XCTAssertEqual(Set(publicKeys).count, 1, "并发首次创建必须全部读取同一个 Keychain winner")
        XCTAssertEqual(try store.load()?.publicKeySec1, publicKeys[0])
    }

    func testCorruptKeychainIdentityFailsClosed() throws {
        let service = "dev.coflux.macos.identity-corrupt-tests"
        let account = "p256-signing-key"
        let store = NativeIdentityStore(service: service, account: account)
        defer { try? store.delete() }
        try store.delete()

        let status = SecItemAdd([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(repeating: 0xa5, count: 31),
        ] as CFDictionary, nil)
        XCTAssertEqual(status, errSecSuccess)

        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(error as? NativeIdentityError, .corruptKey)
        }
        XCTAssertThrowsError(try store.loadOrCreate()) { error in
            XCTAssertEqual(error as? NativeIdentityError, .corruptKey)
        }
    }

    func testKeychainIdentityPersistsAcrossStoreInstances() throws {
        let service = "dev.coflux.macos.identity-tests"
        let account = "p256-signing-key"
        let firstStore = NativeIdentityStore(service: service, account: account)
        defer { try? firstStore.delete() }
        try firstStore.delete()

        let first = try firstStore.loadOrCreate()
        let secondStore = NativeIdentityStore(service: service, account: account)
        let second = try XCTUnwrap(secondStore.load())
        let raced = try secondStore.loadOrCreate()

        XCTAssertEqual(first.publicKeySec1, second.publicKeySec1)
        XCTAssertEqual(first.publicKeySec1, raced.publicKeySec1)
        XCTAssertEqual(try first.signP1363(Data("restart".utf8)).count, 64)
        XCTAssertEqual(try second.signP1363(Data("restart".utf8)).count, 64)

        try secondStore.delete()
        XCTAssertNil(try NativeIdentityStore(service: service, account: account).load())
    }

    func testOriginRequestAndLeaseWindowAreStrict() throws {
        let request = try NativeLocalAuthWire.webSocketRequest(
            url: try XCTUnwrap(URL(string: "ws://127.0.0.1:8787/device")),
            origin: "https://app.coflux.dev"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://app.coflux.dev")
        XCTAssertNoThrow(try NativeLocalAuthWire.webSocketRequest(
            url: try XCTUnwrap(URL(string: "ws://127.0.0.1:8787/device")),
            origin: "https://app.coflux.dev:8443"
        ))
        XCTAssertNoThrow(try NativeLocalAuthWire.webSocketRequest(
            url: try XCTUnwrap(URL(string: "ws://127.0.0.1:8787/device")),
            origin: "https://xn--bcher-kva.example"
        ))

        for invalid in [
            "wss://app.coflux.dev",
            "HTTPS://app.coflux.dev",
            "https://APP.coflux.dev",
            "https://app.coflux.dev:443",
            "http://app.coflux.dev:80",
            "https://bücher.example",
            "https://user@app.coflux.dev",
            "https://app.coflux.dev/",
            "https://app.coflux.dev/path",
            "https://app.coflux.dev?query=1",
            "https://app.coflux.dev#fragment",
        ] {
            XCTAssertThrowsError(
                try NativeLocalAuthWire.webSocketRequest(
                    url: try XCTUnwrap(URL(string: "ws://127.0.0.1:8787/device")),
                    origin: invalid
                ),
                "必须拒绝非精确 origin：\(invalid)"
            )
        }

        let now = Date(timeIntervalSince1970: 100)
        XCTAssertTrue(NativeLocalAuthWire.leaseIsValid(expiresAtMilliseconds: 100_001, now: now))
        XCTAssertFalse(NativeLocalAuthWire.leaseIsValid(expiresAtMilliseconds: 100_000, now: now))
        XCTAssertFalse(NativeLocalAuthWire.leaseIsValid(expiresAtMilliseconds: .nan, now: now))
        XCTAssertFalse(NativeLocalAuthWire.leaseIsValid(expiresAtMilliseconds: .infinity, now: now))
    }

    private func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

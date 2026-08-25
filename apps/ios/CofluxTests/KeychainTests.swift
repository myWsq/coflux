import CofluxApplePlatform
import Foundation
import Testing
@testable import Coflux

@MainActor
struct KeychainTests {
    @Test func hostedAppCompositionIsIsolated() {
        #expect(ProcessInfo.processInfo.environment["COFLUX_IOS_TEST_HOST"] == "1")
        let store = CofluxAppComposition.makeTokenStore()
        #expect(store is TestHostTokenStore)
    }

    @Test func roundtrip() throws {
        let namespace = UUID().uuidString
        let store = KeychainTokenStore(
            service: "dev.coflux.CofluxTests.\(namespace)",
            account: "clientToken.\(namespace)"
        )
        defer { try? store.clear() }

        try store.clear()
        #expect(try store.read() == nil)
        try store.write("ck_sess_roundtrip")
        #expect(try store.read() == "ck_sess_roundtrip")
        try store.write("ck_sess_overwrite")
        #expect(try store.read() == "ck_sess_overwrite")
        try store.clear()
        #expect(try store.read() == nil)
    }
}

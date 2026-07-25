import Testing
@testable import Coflux

@MainActor
struct KeychainTests {
    @Test func roundtrip() {
        let store = KeychainTokenStore()
        store.clear()
        #expect(store.read() == nil)
        store.write("ck_sess_roundtrip")
        #expect(store.read() == "ck_sess_roundtrip")
        store.write("ck_sess_overwrite")
        #expect(store.read() == "ck_sess_overwrite")
        store.clear()
        #expect(store.read() == nil)
    }
}

import CofluxProtocol
import XCTest

final class ProtocolGenerationTests: XCTestCase {
    func testGeneratedEnvelopeRoundTrips() throws {
        var auth = Coflux_V1_ClientAuth()
        auth.clientVersion = "package-test"
        auth.clientToken = "token"

        var envelope = Coflux_V1_ClientToServer()
        envelope.payload = .clientAuth(auth)

        let bytes: Data = try envelope.serializedBytes()
        let decoded = try Coflux_V1_ClientToServer(serializedBytes: bytes)
        guard case .clientAuth(let value) = decoded.payload else {
            return XCTFail("未恢复 clientAuth payload")
        }
        XCTAssertEqual(value.clientVersion, "package-test")
        XCTAssertEqual(value.clientToken, "token")
    }
}

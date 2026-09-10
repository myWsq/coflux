import XCTest
@testable import Coflux

final class ServerEndpointTests: XCTestCase {
    func testDefaultAppliesOnlyWhenOverrideIsAbsent() throws {
        let fallback = "wss://api.coflux.dev/client"
        XCTAssertEqual(try ServerEndpoint.resolve(override: nil, defaultServer: fallback).absoluteString, fallback)
        for invalid in ["", " ", "not a url", "/client", "https://example.com/client", "ws:///client", "ws://user:secret@example.com/client", "ws://example.com/client#secret", "ws://example.com:0/client", "ws://example.com:65536/client"] {
            XCTAssertThrowsError(try ServerEndpoint.resolve(override: invalid, defaultServer: fallback), invalid)
        }
    }
    func testValidCustomServerIsPreserved() throws {
        for server in ["ws://127.0.0.1:19873/client", "wss://custom.example/path/client", "ws://[::1]:19873/client"] {
            XCTAssertEqual(try ServerEndpoint.resolve(override: server, defaultServer: "wss://api.coflux.dev/client").absoluteString, server)
        }
    }
}

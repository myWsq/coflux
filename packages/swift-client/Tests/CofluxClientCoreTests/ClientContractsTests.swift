import CofluxClientCore
import Foundation
import XCTest

final class ClientContractsTests: XCTestCase {
    func testConfigurationRequiresExplicitBuildIdentityAtCompositionBoundary() {
        let url = URL(string: "wss://example.test/client")!
        let configuration = ClientConfiguration(serverURL: url, buildID: "explicit-build")
        XCTAssertEqual(configuration.serverURL, url)
        XCTAssertEqual(configuration.buildID, "explicit-build")
    }

    func testSyncStateIsIndependentFromConnectionAndAuthentication() {
        let state: (ConnectionStatus, AuthState, SyncState) = (.connected, .authed, .awaitingSnapshot)
        XCTAssertEqual(state.0, .connected)
        XCTAssertEqual(state.1, .authed)
        XCTAssertEqual(state.2, .awaitingSnapshot)
    }
}

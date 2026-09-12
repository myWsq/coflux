import CofluxApplePlatform
import CofluxClientCore
import Foundation
import Testing
@testable import Coflux

private struct IntegrationTokenStore: TokenStore {
    func read() throws -> String? { nil }
    func write(_: String) throws {}
    func clear() throws {}
}

@MainActor
private func integrationWaitUntil(
    timeout: Duration,
    _ condition: () -> Bool
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while clock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
}

/// iOS has no remote native provider yet; the public API must say so promptly.
@MainActor
struct DeviceIntegrationTests {
    @Test(.timeLimit(.minutes(1)))
    func remoteDeviceAccessReportsUnavailable() async throws {
        let client = CofluxClient(
            configuration: ClientConfiguration(serverURL: URL(string: "ws://127.0.0.1:8787/client")!, buildID: "dev"),
            transport: NetworkFrameworkTransport(), tokenStore: IntegrationTokenStore()
        )
        defer { client.logout() }
        do {
            _ = try await client.listDeviceDirectory(daemonID: "remote", path: "/")
            Issue.record("iOS remote access must not silently use a removed transport")
        } catch {
            #expect(error.localizedDescription.contains("远程设备连接"))
        }
    }
}

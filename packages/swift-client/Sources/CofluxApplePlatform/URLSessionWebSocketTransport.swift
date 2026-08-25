import CofluxClientCore
import Foundation

public enum URLSessionWebSocketTransportError: Error, Equatable, Sendable {
    case invalidWebSocketURL
    case invalidOrigin
    case concurrentReceive
    case textFrame
}

enum PlatformWebSocketMessage: Equatable, Sendable {
    case data(Data)
    case string(String)
}

protocol URLSessionWebSocketDriving: Sendable {
    func resume()
    func send(_ message: PlatformWebSocketMessage) async throws
    func receive() async throws -> PlatformWebSocketMessage
    func cancel()
}

protocol URLSessionWebSocketTaskFactory: Sendable {
    func makeTask(for request: URLRequest) -> any URLSessionWebSocketDriving
}

private struct SystemURLSessionWebSocketTaskFactory: URLSessionWebSocketTaskFactory {
    func makeTask(for request: URLRequest) -> any URLSessionWebSocketDriving {
        SystemURLSessionWebSocketDriver(request: request)
    }
}

private final class SystemURLSessionWebSocketDriver: URLSessionWebSocketDriving, @unchecked Sendable {
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(request: URLRequest) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
        task = session.webSocketTask(with: request)
    }

    func resume() {
        task.resume()
    }

    func send(_ message: PlatformWebSocketMessage) async throws {
        switch message {
        case .data(let data):
            try await task.send(.data(data))
        case .string(let string):
            try await task.send(.string(string))
        }
    }

    func receive() async throws -> PlatformWebSocketMessage {
        switch try await task.receive() {
        case .data(let data): return .data(data)
        case .string(let string): return .string(string)
        @unknown default: throw URLSessionWebSocketTransportError.textFrame
        }
    }

    func cancel() {
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

/// macOS 14 控制面 WebSocket。Origin 是 composition root 的稳定产品身份，而非从 URL 猜测。
public struct URLSessionWebSocketTransport: Transport, Sendable {
    private let origin: String
    private let factory: any URLSessionWebSocketTaskFactory

    public init(origin: String) {
        self.origin = origin
        factory = SystemURLSessionWebSocketTaskFactory()
    }

    init(origin: String, factory: any URLSessionWebSocketTaskFactory) {
        self.origin = origin
        self.factory = factory
    }

    public func connect(to url: URL) async throws -> any TransportConnection {
        let request = try Self.makeRequest(url: url, origin: origin)
        let driver = factory.makeTask(for: request)
        driver.resume()
        return URLSessionWebSocketConnection(driver: driver)
    }

    static func makeRequest(url: URL, origin: String) throws -> URLRequest {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.fragment == nil
        else { throw URLSessionWebSocketTransportError.invalidWebSocketURL }

        guard let originComponents = URLComponents(string: origin),
              let originScheme = originComponents.scheme?.lowercased(),
              originScheme == "http" || originScheme == "https",
              let host = originComponents.host,
              !host.isEmpty,
              originComponents.user == nil,
              originComponents.password == nil,
              originComponents.percentEncodedPath.isEmpty,
              originComponents.query == nil,
              originComponents.fragment == nil,
              canonicalOrigin(scheme: originScheme, host: host, port: originComponents.port) == origin
        else { throw URLSessionWebSocketTransportError.invalidOrigin }

        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 30
        )
        request.setValue(origin, forHTTPHeaderField: "Origin")
        return request
    }

    private static func canonicalOrigin(scheme: String, host: String, port: Int?) -> String {
        let normalizedHost = host.contains(":") ? "[\(host.lowercased())]" : host.lowercased()
        let defaultPort = scheme == "http" ? 80 : 443
        let suffix = port.flatMap { $0 == defaultPort ? nil : ":\($0)" } ?? ""
        return "\(scheme)://\(normalizedHost)\(suffix)"
    }
}

private actor URLSessionWebSocketConnection: TransportConnection {
    private struct PendingSend {
        let id: UUID
        let data: Data
        let continuation: CheckedContinuation<Void, any Error>
    }

    private struct PendingReceive {
        let id: UUID
        let continuation: CheckedContinuation<Data, any Error>
    }

    private let driver: any URLSessionWebSocketDriving
    private var pendingSends: [PendingSend] = []
    private var activeSend: PendingSend?
    private var activeReceive: PendingReceive?
    private var isDrainingSends = false
    private var isClosed = false

    init(driver: any URLSessionWebSocketDriving) {
        self.driver = driver
    }

    func send(_ data: Data) async throws {
        guard !isClosed else { throw TransportClosedError() }
        try await withCheckedThrowingContinuation { continuation in
            pendingSends.append(PendingSend(id: UUID(), data: data, continuation: continuation))
            guard !isDrainingSends else { return }
            isDrainingSends = true
            Task { await self.drainSends() }
        }
    }

    func receive() async throws -> Data {
        guard !isClosed else { throw TransportClosedError() }
        guard activeReceive == nil else { throw URLSessionWebSocketTransportError.concurrentReceive }
        return try await withCheckedThrowingContinuation { continuation in
            let pending = PendingReceive(id: UUID(), continuation: continuation)
            activeReceive = pending
            Task { await self.performReceive(id: pending.id) }
        }
    }

    func close() async {
        terminate()
    }

    private func performReceive(id: UUID) async {
        let result: Result<PlatformWebSocketMessage, any Error>
        do {
            result = .success(try await driver.receive())
        } catch {
            result = .failure(error)
        }
        guard let pending = activeReceive, pending.id == id else { return }
        activeReceive = nil
        switch result {
        case .success(.data(let data)):
            pending.continuation.resume(returning: data)
        case .success(.string):
            pending.continuation.resume(throwing: URLSessionWebSocketTransportError.textFrame)
            terminate()
        case .failure(let error):
            pending.continuation.resume(throwing: error)
            terminate()
        }
    }

    private func drainSends() async {
        while !isClosed, !pendingSends.isEmpty {
            let pending = pendingSends.removeFirst()
            activeSend = pending
            let result: Result<Void, any Error>
            do {
                try await driver.send(.data(pending.data))
                result = .success(())
            } catch {
                result = .failure(error)
            }
            guard let active = activeSend, active.id == pending.id else { return }
            activeSend = nil
            switch result {
            case .success:
                active.continuation.resume()
            case .failure(let error):
                active.continuation.resume(throwing: error)
                terminate()
                return
            }
        }
        isDrainingSends = false
    }

    private func terminate() {
        guard !isClosed else { return }
        isClosed = true
        driver.cancel()
        let sending = activeSend
        activeSend = nil
        let receiving = activeReceive
        activeReceive = nil
        let queued = pendingSends
        pendingSends.removeAll()
        isDrainingSends = false
        sending?.continuation.resume(throwing: TransportClosedError())
        receiving?.continuation.resume(throwing: TransportClosedError())
        for pending in queued {
            pending.continuation.resume(throwing: TransportClosedError())
        }
    }
}

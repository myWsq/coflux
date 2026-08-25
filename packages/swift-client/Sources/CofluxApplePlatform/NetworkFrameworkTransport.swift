#if os(iOS)
import CofluxClientCore
import Foundation
import Network

/// iOS 26 的结构化并发 WebSocket adapter；macOS 14 使用独立 URLSession 实现。
@available(iOS 26.0, *)
public struct NetworkFrameworkTransport: Transport {
    public init() {}

    public func connect(to url: URL) async throws -> any TransportConnection {
        let secure = url.scheme?.lowercased() == "wss"
        let connection: NetworkConnection<WebSocket> = secure
            ? NetworkConnection(to: .url(url)) { WebSocket { TLS() }.autoReplyPing(true) }
            : NetworkConnection(to: .url(url)) { WebSocket { TCP() }.autoReplyPing(true) }
        return NetworkFrameworkWebSocketConnection(connection: connection)
    }
}

/// iterator 只由 CofluxClient 的单一 receive loop 消费。
@available(iOS 26.0, *)
private final class NetworkFrameworkWebSocketConnection: TransportConnection, @unchecked Sendable {
    private let connection: NetworkConnection<WebSocket>
    private var iterator: AsyncThrowingStream<WebSocket.Message<Data>, any Error>.Iterator

    init(connection: NetworkConnection<WebSocket>) {
        self.connection = connection
        iterator = connection.messages.makeAsyncIterator()
    }

    func send(_ data: Data) async throws {
        try await connection.send(data)
    }

    func receive() async throws -> Data {
        while let message = try await iterator.next() {
            if message.metadata.opcode == .binary { return message.content }
        }
        throw TransportClosedError()
    }

    func close() async {
        try? await connection.close()
    }
}
#endif

import Foundation
import Network

/// 单条 WS 连接的抽象：归约层只见字节流，便于测试注入 fake（plan 044 决策：封装边界
/// 隔离 NetworkConnection / NWConnection 的切换）。
protocol TransportConnection: Sendable {
    func send(_ data: Data) async throws
    /// 下一条 binary 消息；全 binary 协议，非二进制帧一律忽略（connection.ts:97 同语义）。
    /// 连接关闭/失败以抛错结束。
    func receive() async throws -> Data
    func close() async
}

protocol Transport: Sendable {
    func connect(to url: URL) async throws -> any TransportConnection
}

struct TransportClosedError: Error {}

/// Network.framework 新 NetworkConnection API（iOS 26+，结构化并发原生）。plan 044 决策：
/// 不用 URLSessionWebSocketTask（close code 不可靠、无背压）。
struct NetworkTransport: Transport {
    func connect(to url: URL) async throws -> any TransportConnection {
        let secure = url.scheme?.lowercased() == "wss"
        let connection: NetworkConnection<WebSocket> = secure
            ? NetworkConnection(to: .url(url)) { WebSocket { TLS() }.autoReplyPing(true) }
            : NetworkConnection(to: .url(url)) { WebSocket { TCP() }.autoReplyPing(true) }
        return NetworkWebSocketConnection(connection: connection)
    }
}

/// 用 messages 流而非逐次 receive()：iOS 26 的 NetworkConnection.receive() 收到 WS ping
/// 控制帧时以 EINVAL 失败并弃连接（server 30s 心跳一到必断，实测复现）；messages 流
/// 无此问题，ping 作为消息投递（忽略即可），pong 由 autoReplyPing 自动回。
/// @unchecked Sendable：iterator 仅被 runConnection 的单一循环串行消费，无并发访问。
private final class NetworkWebSocketConnection: TransportConnection, @unchecked Sendable {
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
            if message.metadata.opcode == .binary {
                return message.content
            }
        }
        throw TransportClosedError()
    }

    func close() async {
        try? await connection.close()
    }
}

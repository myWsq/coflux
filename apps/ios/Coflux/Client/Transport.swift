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

private struct NetworkWebSocketConnection: TransportConnection {
    let connection: NetworkConnection<WebSocket>

    func send(_ data: Data) async throws {
        try await connection.send(data)
    }

    func receive() async throws -> Data {
        while true {
            let message = try await connection.receive()
            if message.metadata.opcode == .binary {
                return message.content
            }
        }
    }

    func close() async {
        try? await connection.close()
    }
}

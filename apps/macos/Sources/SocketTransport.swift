import CofluxClientCore
import Foundation

/// Foundation 原生二进制 WebSocket；单连接独占 session，关闭时立即取消挂起的接收。
struct SocketTransport: Transport {
    func connect(to url: URL) async throws -> any TransportConnection {
        guard ["ws", "wss"].contains(url.scheme), url.host != nil,
              url.user == nil, url.password == nil, url.fragment == nil else {
            throw URLError(.badURL)
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        let session = URLSession(configuration: config)
        var request = URLRequest(url: url)
        request.setValue("https://coflux.dev", forHTTPHeaderField: "Origin")
        let socket = session.webSocketTask(with: request)
        // 当前协议设备数据帧上限含 30 MiB 文件；Foundation 默认 1 MiB 会错误断连。
        socket.maximumMessageSize = 32 * 1024 * 1024
        socket.resume()
        return SocketConnection(session: session, socket: socket, observesTerminalPressure: url.path != "/client")
    }
}

private actor SocketConnection: TransportConnection {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private let observesTerminalPressure: Bool
    private var closed = false
    private var receiving = false
    private var sendTail: Task<Void, any Error>?

    init(session: URLSession, socket: URLSessionWebSocketTask, observesTerminalPressure: Bool) {
        self.session = session
        self.socket = socket
        self.observesTerminalPressure = observesTerminalPressure
    }

    func send(_ data: Data) async throws {
        guard !closed else { throw TransportClosedError() }
        // actor 在 await 处可重入，显式连接发送任务以保证线上的消息顺序。
        let previous = sendTail
        let operation = Task { [socket] in
            if let previous { try await previous.value }
            try Task.checkCancellation()
            try await socket.send(.data(data))
        }
        sendTail = operation
        try await operation.value
    }

    func receive() async throws -> Data {
        guard !closed else { throw TransportClosedError() }
        guard !receiving else { throw URLError(.resourceUnavailable) }
        receiving = true
        defer { receiving = false }
        // 中心控制面不等待终端消费；设备面保留发送能力，接收在积压时让出执行。
        if observesTerminalPressure { try await TerminalOutputPump.waitForReceiveCapacity() }
        guard !closed else { throw TransportClosedError() }
        let message = try await socket.receive()
        guard !closed else { throw TransportClosedError() }
        guard case .data(let data) = message else { throw URLError(.cannotParseResponse) }
        return data
    }

    func close() async {
        guard !closed else { return }
        closed = true
        sendTail?.cancel()
        sendTail = nil
        socket.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }
}

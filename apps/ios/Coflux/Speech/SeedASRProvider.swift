import Foundation
import os

/// Why `SeedASRProvider.start()` failed (D9): the user can fix an invalid key; anything else is
/// reported as the service being unreachable.
enum SeedASRStartError: Error, Equatable {
    /// The WebSocket handshake was answered with HTTP 401.
    case invalidKey
    /// Everything else: no network, a different handshake status, a protocol failure.
    case unreachable
}

/// 豆包 Seed-ASR 2.0 streaming recognition (plan 20261108-ios-seed-asr), over the Volcengine
/// "bigmodel_async" binary WebSocket protocol, billed to the account's Agent Plan key.
///
/// Frame layout, both directions: a 4-byte header
/// `[version 1 | header size 1 (×4 bytes)] [message type | flags] [serialization | compression] [reserved]`,
/// then (per flags) a big-endian Int32 sequence, then a big-endian UInt32 payload size and the
/// payload. Nothing is ever compressed (D2). The conversation context goes only in the first frame
/// (D3). One connection per dictation; never retried and never replaced by another engine (D1).
actor SeedASRProvider: SpeechTranscribing {
    nonisolated let events: AsyncStream<SpeechTranscriptEvent>
    private let eventContinuation: AsyncStream<SpeechTranscriptEvent>.Continuation

    private static let endpoint = URL(string: "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async")!
    private static let resourceID = "volc.seedasr.sauc.duration"
    /// 200 ms of 16 kHz mono Int16 PCM.
    private static let bytesPerFrame = 6400
    /// Seed's two-pass final result arrives ~0.7–0.9 s after the last frame.
    private static let finalResultTimeout: Duration = .seconds(2)
    private static let log = Logger(subsystem: "dev.coflux.ios", category: "speech")

    private enum MessageType {
        static let fullClientRequest: UInt8 = 0b0001
        static let audioOnlyRequest: UInt8 = 0b0010
        static let fullServerResponse: UInt8 = 0b1001
        static let serverError: UInt8 = 0b1111
    }
    private enum Flags {
        static let sequence: UInt8 = 0b0001
        static let last: UInt8 = 0b0010
        static let event: UInt8 = 0b0100
        static let lastWithNegativeSequence: UInt8 = 0b0011
    }
    private enum Serialization {
        static let none: UInt8 = 0
        static let json: UInt8 = 1
    }

    private let apiKey: String
    private let contextItems: [String]
    private var session: URLSession?
    private var ws: URLSessionWebSocketTask?
    /// The service's trace id for this connection (`X-Tt-Logid`), for the failure log line only.
    private var logID = ""
    private var pcmBuffer = Data()
    /// Sequence number of the last frame sent (the first frame is 1).
    private var sequence: Int32 = 0
    private var audioSent = false
    private var finishing = false
    private var torndown = false
    private var lastText = ""
    private var listenTask: Task<Void, Never>?
    private var finalWaiter: CheckedContinuation<Void, Never>?

    /// `contextItems`: plain-text dialog context, most relevant first; empty = no context.
    init(apiKey: String, contextItems: [String]) {
        self.apiKey = apiKey
        self.contextItems = contextItems
        var continuation: AsyncStream<SpeechTranscriptEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        eventContinuation = continuation
    }

    // MARK: - SpeechTranscribing

    func start() async throws {
        guard !torndown else { throw SeedASRStartError.unreachable }
        let connectID = UUID().uuidString
        var request = URLRequest(url: Self.endpoint)
        request.setValue(apiKey, forHTTPHeaderField: "X-Api-Key")
        request.setValue(Self.resourceID, forHTTPHeaderField: "X-Api-Resource-Id")
        request.setValue(connectID, forHTTPHeaderField: "X-Api-Request-Id")
        request.setValue(connectID, forHTTPHeaderField: "X-Api-Connect-Id")
        request.setValue("-1", forHTTPHeaderField: "X-Api-Sequence")

        let session = URLSession(configuration: .ephemeral)
        let task = session.webSocketTask(with: request)
        self.session = session
        ws = task
        task.resume()

        let payload: Data
        do {
            payload = try Self.configPayload(contextItems: contextItems)
        } catch {
            teardown(emitClosed: false)
            throw SeedASRStartError.unreachable
        }
        sequence = 1
        do {
            // The send completes only once the handshake has succeeded.
            try await task.send(.data(Self.frame(
                type: MessageType.fullClientRequest, flags: Flags.sequence,
                serialization: Serialization.json, sequence: sequence, payload: payload
            )))
        } catch {
            let http = task.response as? HTTPURLResponse
            logID = http?.value(forHTTPHeaderField: "X-Tt-Logid") ?? ""
            let status = http?.statusCode ?? 0
            let id = logID
            Self.log.error("seed-asr handshake failed: status \(status, privacy: .public), logid \(id, privacy: .public)")
            teardown(emitClosed: false)
            throw status == 401 ? SeedASRStartError.invalidKey : SeedASRStartError.unreachable
        }
        guard !torndown else { throw SeedASRStartError.unreachable }
        logID = (task.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Tt-Logid") ?? ""
        listenTask = Task { [weak self] in
            await self?.listenLoop(task)
        }
    }

    func feed(pcm: Data) async {
        guard !finishing, !torndown, ws != nil else { return }
        pcmBuffer.append(pcm)
        // Re-checked after every send: finish() may run while this one is suspended, and nothing
        // may follow the final frame.
        while !finishing, !torndown, pcmBuffer.count >= Self.bytesPerFrame {
            let chunk = Data(pcmBuffer.prefix(Self.bytesPerFrame))
            pcmBuffer.removeFirst(Self.bytesPerFrame)
            await sendAudio(chunk, last: false)
        }
    }

    /// Send the remaining audio and the final frame, then wait (bounded) for the last package. On
    /// return the event stream has finished either way.
    func finish() async {
        guard !finishing, !torndown, ws != nil else { return }
        finishing = true
        var final = pcmBuffer
        pcmBuffer.removeAll()
        // The service needs at least one audio frame: a session without any still sends 200 ms of
        // silence as its final frame.
        if !audioSent, final.isEmpty { final = Data(count: Self.bytesPerFrame) }
        await sendAudio(final, last: true)
        guard !torndown else { return }

        let timeout = Task { [weak self] in
            do { try await Task.sleep(for: Self.finalResultTimeout) } catch { return }
            await self?.finalResultTimedOut()
        }
        await withCheckedContinuation { continuation in
            if torndown {
                continuation.resume()
            } else {
                finalWaiter = continuation
            }
        }
        timeout.cancel()
    }

    func cancel() async {
        finishing = true
        teardown(emitClosed: true)
    }

    // MARK: - Sending

    private func sendAudio(_ pcm: Data, last: Bool) async {
        guard let ws, !torndown else { return }
        sequence += 1
        let frame = Self.frame(
            type: MessageType.audioOnlyRequest,
            flags: last ? Flags.lastWithNegativeSequence : Flags.sequence,
            serialization: Serialization.none,
            sequence: last ? -sequence : sequence,
            payload: pcm
        )
        do {
            try await ws.send(.data(frame))
            audioSent = true
        } catch {
            // A failed send means the connection is gone; the listen loop reports it.
        }
    }

    // MARK: - Receiving

    private func listenLoop(_ task: URLSessionWebSocketTask) async {
        while !Task.isCancelled, !torndown {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                guard !torndown else { return }
                fail("connection lost")
                return
            }
            guard case .data(let data) = message else { continue }
            guard let response = Self.parse(data) else {
                fail("malformed frame")
                return
            }
            switch response {
            case .error(let code):
                fail("server error \(code)")
                return
            case .result(let payload, let isLast):
                handle(payload)
                if isLast {
                    if !lastText.isEmpty { eventContinuation.yield(.finalized(lastText)) }
                    teardown(emitClosed: true)
                    return
                }
            }
        }
    }

    private func handle(_ payload: Data) {
        guard !payload.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
        else { return }
        let result: [String: Any]?
        if let single = object["result"] as? [String: Any] {
            result = single
        } else {
            result = (object["result"] as? [[String: Any]])?.first
        }
        guard let result, let text = result["text"] as? String, !text.isEmpty else { return }
        lastText = text
        let utterances = result["utterances"] as? [[String: Any]] ?? []
        let settled = utterances.allSatisfy { ($0["definite"] as? Bool) == true }
        eventContinuation.yield(settled ? .finalized(text) : .volatile(text))
    }

    private func fail(_ reason: String) {
        let id = logID
        Self.log.error("seed-asr failed: \(reason, privacy: .public), logid \(id, privacy: .public)")
        eventContinuation.yield(.failed("无法连接识别服务"))
        teardown(emitClosed: true)
    }

    private func finalResultTimedOut() {
        guard finalWaiter != nil else { return }
        let id = logID
        Self.log.notice("seed-asr final result timed out, logid \(id, privacy: .public)")
        teardown(emitClosed: true)
    }

    private func teardown(emitClosed: Bool) {
        guard !torndown else { return }
        torndown = true
        listenTask?.cancel()
        ws?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        if emitClosed { eventContinuation.yield(.closed) }
        eventContinuation.finish()
        finalWaiter?.resume()
        finalWaiter = nil
    }

    // MARK: - Wire format

    private static func configPayload(contextItems: [String]) throws -> Data {
        var request: [String: Any] = [
            "model_name": "bigmodel",
            "enable_itn": true,
            "enable_punc": true,
            "enable_nonstream": true,
            "show_utterances": true,
            "result_type": "full",
        ]
        if !contextItems.isEmpty {
            let context: [String: Any] = [
                "context_type": "dialog_ctx",
                "context_data": contextItems.map { ["text": $0] },
            ]
            let contextJSON = try JSONSerialization.data(withJSONObject: context)
            request["corpus"] = ["context": String(decoding: contextJSON, as: UTF8.self)]
        }
        let body: [String: Any] = [
            "user": ["uid": "coflux-ios"],
            "audio": ["format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1],
            "request": request,
        ]
        return try JSONSerialization.data(withJSONObject: body)
    }

    private static func frame(type: UInt8, flags: UInt8, serialization: UInt8, sequence: Int32, payload: Data) -> Data {
        var data = Data([0x11, (type << 4) | flags, (serialization << 4) | 0x00, 0x00])
        withUnsafeBytes(of: sequence.bigEndian) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: UInt32(payload.count).bigEndian) { data.append(contentsOf: $0) }
        data.append(payload)
        return data
    }

    private enum ServerFrame {
        case result(Data, isLast: Bool)
        case error(Int32)
    }

    /// Nil = a frame this client cannot read (truncated, or compressed, which it never asks for).
    private static func parse(_ data: Data) -> ServerFrame? {
        let bytes = [UInt8](data)
        guard bytes.count >= 4 else { return nil }
        let headerSize = Int(bytes[0] & 0x0F) * 4
        let type = bytes[1] >> 4
        let flags = bytes[1] & 0x0F
        let compression = bytes[2] & 0x0F
        guard headerSize >= 4, compression == 0 else { return nil }
        var offset = headerSize

        func readUInt32() -> UInt32? {
            guard offset + 4 <= bytes.count else { return nil }
            let value = bytes[offset ..< offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            offset += 4
            return value
        }

        if flags & Flags.sequence != 0 { guard readUInt32() != nil else { return nil } }
        if flags & Flags.event != 0 { guard readUInt32() != nil else { return nil } }
        if type == MessageType.serverError {
            guard let code = readUInt32() else { return nil }
            return .error(Int32(bitPattern: code))
        }
        guard let size = readUInt32() else { return nil }
        let end = offset + Int(size)
        guard end <= bytes.count else { return nil }
        let payload = Data(bytes[offset ..< end])
        guard type == MessageType.fullServerResponse else {
            return .result(Data(), isLast: flags & Flags.last != 0)
        }
        return .result(payload, isLast: flags & Flags.last != 0)
    }
}

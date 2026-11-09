import Foundation
import os

/// OpenAI Realtime transcription (plan 20261109-speech-providers D6/D10), over the JSON WebSocket
/// protocol of a transcription-only session, billed to the account's OpenAI key.
///
/// One connection per dictation: `session.update` configures a `transcription` session with 24 kHz
/// mono PCM, the live model, the conversation context as `prompt` and no turn detection (live models
/// support neither server nor semantic VAD, and the push-to-talk release is the turn's end). Audio
/// goes as base64 `input_audio_buffer.append` events while the user speaks and one
/// `input_audio_buffer.commit` on release. Never retried and never replaced by another engine.
actor OpenAIRealtimeTranscriber: SpeechTranscribing {
    nonisolated let events: AsyncStream<SpeechTranscriptEvent>
    private let eventContinuation: AsyncStream<SpeechTranscriptEvent>.Continuation

    /// 150 ms of 24 kHz mono Int16 PCM per append event.
    private static let bytesPerChunk = 7200
    /// Bounded wait for the completed transcript after the commit. Measured live (2026-11-09, from
    /// China): the live model's last deltas and the completion arrive 3–13 s after the commit, so a
    /// short bound cuts off the end of what was said. On timeout the draft so far is kept.
    private static let finalResultTimeout: Duration = .seconds(10)
    private static let log = Logger(subsystem: "dev.coflux.ios", category: "speech")

    private let apiKey: String
    /// The REST base (`https://…`), defaults already resolved; the socket URL is derived from it.
    private let baseURL: String
    private let model: String
    private let prompt: String
    private var session: URLSession?
    private var ws: URLSessionWebSocketTask?
    /// The service's id for this session (`session.created`), for the failure log line only.
    private var sessionID = ""
    private var pcmBuffer = Data()
    /// The service has applied our `session.update`. Audio is held until then: appended before it,
    /// a live probe once got no deltas at all until the commit.
    private var configured = false
    private var audioSent = false
    private var finishing = false
    private var torndown = false
    /// All transcript text received so far: deltas are appended, events always carry the whole.
    private var draft = ""
    private var listenTask: Task<Void, Never>?
    private var finalWaiter: CheckedContinuation<Void, Never>?

    /// `baseURL` / `model`: the OpenAI slot's values with defaults resolved. `contextItems`:
    /// plain-text context, the workspace sentence first and then conversation entries newest first
    /// (`DictationContext.items`); empty = no context.
    init(apiKey: String, baseURL: String, model: String, contextItems: [String]) {
        self.apiKey = apiKey
        self.baseURL = baseURL
        self.model = model
        prompt = Self.prompt(from: contextItems)
        var continuation: AsyncStream<SpeechTranscriptEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        eventContinuation = continuation
    }

    // MARK: - SpeechTranscribing

    func start() async throws {
        guard !torndown else { throw SpeechStartError.unreachable }
        guard let url = Self.socketURL(baseURL: baseURL) else {
            Self.log.error("openai-realtime base URL is not an https URL")
            teardown(emitClosed: false)
            throw SpeechStartError.unreachable
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .ephemeral)
        let task = session.webSocketTask(with: request)
        self.session = session
        ws = task
        task.resume()

        let update: String
        do {
            update = try Self.sessionUpdate(model: model, prompt: prompt)
        } catch {
            teardown(emitClosed: false)
            throw SpeechStartError.unreachable
        }
        do {
            // The send completes only once the handshake has succeeded.
            try await task.send(.string(update))
        } catch {
            let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
            Self.log.error("openai-realtime handshake failed: status \(status, privacy: .public)")
            teardown(emitClosed: false)
            throw status == 401 ? SpeechStartError.invalidKey : SpeechStartError.unreachable
        }
        guard !torndown else { throw SpeechStartError.unreachable }
        listenTask = Task { [weak self] in
            await self?.listenLoop(task)
        }
    }

    func feed(pcm: Data) async {
        guard !finishing, !torndown, ws != nil else { return }
        pcmBuffer.append(pcm)
        await sendBufferedChunks()
    }

    /// Send every whole chunk buffered so far, once the session is configured. Re-checked after
    /// every send: finish() may run while this one is suspended, and nothing may follow the commit.
    private func sendBufferedChunks() async {
        while configured, !finishing, !torndown, pcmBuffer.count >= Self.bytesPerChunk {
            let chunk = Data(pcmBuffer.prefix(Self.bytesPerChunk))
            pcmBuffer.removeFirst(Self.bytesPerChunk)
            await sendAudio(chunk)
        }
    }

    /// Send the remaining audio and the commit, then wait (bounded) for the completed transcript. On
    /// return the event stream has finished either way.
    func finish() async {
        guard !finishing, !torndown, ws != nil else { return }
        finishing = true
        var remaining = pcmBuffer
        pcmBuffer.removeAll()
        // Committing an empty buffer is an error: a session without any audio still sends one chunk
        // of silence first.
        if !audioSent, remaining.isEmpty { remaining = Data(count: Self.bytesPerChunk) }
        if !remaining.isEmpty { await sendAudio(remaining) }
        guard !torndown else { return }
        await sendEvent(["type": "input_audio_buffer.commit"])
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

    private func sendAudio(_ pcm: Data) async {
        guard !torndown else { return }
        await sendEvent(["type": "input_audio_buffer.append", "audio": pcm.base64EncodedString()])
        audioSent = true
    }

    private func sendEvent(_ event: [String: Any]) async {
        guard let ws, !torndown,
              let data = try? JSONSerialization.data(withJSONObject: event)
        else { return }
        do {
            try await ws.send(.string(String(decoding: data, as: UTF8.self)))
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
            let data: Data
            switch message {
            case .string(let text): data = Data(text.utf8)
            case .data(let bytes): data = bytes
            @unknown default: continue
            }
            guard let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = event["type"] as? String
            else {
                fail("malformed event")
                return
            }
            switch type {
            case "session.created", "session.updated":
                if let session = event["session"] as? [String: Any], let id = session["id"] as? String {
                    sessionID = id
                }
                if type == "session.updated", !configured {
                    configured = true
                    await sendBufferedChunks()
                }
            case "conversation.item.input_audio_transcription.delta":
                guard let delta = event["delta"] as? String, !delta.isEmpty else { continue }
                draft += delta
                eventContinuation.yield(.volatile(draft))
            case "conversation.item.input_audio_transcription.completed":
                let transcript = event["transcript"] as? String ?? ""
                if !transcript.isEmpty {
                    draft = transcript
                    eventContinuation.yield(.finalized(transcript))
                }
                // One commit per dictation: its completion is the end of the session.
                teardown(emitClosed: true)
                return
            case "error":
                // Only the error's type and code: its message may quote request details.
                let error = event["error"] as? [String: Any]
                let kind = error?["type"] as? String ?? "?"
                let code = error?["code"] as? String ?? "?"
                // A wrong key passes the handshake (HTTP 101) and is reported as this event right
                // after it (measured 2026-11-09), never as a 401.
                fail("server error \(kind)/\(code)", message: code == "invalid_api_key" ? DictationSession.invalidKeyMessage : nil)
                return
            default:
                continue
            }
        }
    }

    private func fail(_ reason: String, message: String? = nil) {
        let id = sessionID
        Self.log.error("openai-realtime failed: \(reason, privacy: .public), session \(id, privacy: .public)")
        eventContinuation.yield(.failed(message ?? DictationSession.unreachableMessage))
        teardown(emitClosed: true)
    }

    private func finalResultTimedOut() {
        guard finalWaiter != nil else { return }
        let id = sessionID
        Self.log.notice("openai-realtime final transcript timed out, session \(id, privacy: .public)")
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

    /// `https://host/base` → `wss://host/base/realtime?intent=transcription` (D6). Nil for anything
    /// that is not an https URL.
    static func socketURL(baseURL: String) -> URL? {
        let scheme = "https://"
        guard baseURL.lowercased().hasPrefix(scheme) else { return nil }
        var rest = String(baseURL.dropFirst(scheme.count))
        while rest.hasSuffix("/") { rest.removeLast() }
        guard !rest.isEmpty else { return nil }
        return URL(string: "wss://\(rest)/realtime?intent=transcription")
    }

    private static func sessionUpdate(model: String, prompt: String) throws -> String {
        var transcription: [String: Any] = ["model": model, "languages": ["zh", "en"]]
        if !prompt.isEmpty { transcription["prompt"] = prompt }
        let event: [String: Any] = [
            "type": "session.update",
            "session": [
                "type": "transcription",
                "audio": [
                    "input": [
                        "format": ["type": "audio/pcm", "rate": 24000] as [String: Any],
                        "transcription": transcription,
                        "turn_detection": NSNull(),
                    ] as [String: Any],
                ],
            ] as [String: Any],
        ]
        let data = try JSONSerialization.data(withJSONObject: event)
        return String(decoding: data, as: UTF8.self)
    }

    /// The context as one prompt, one item per line in reading order: the workspace sentence, then
    /// the conversation oldest to newest so the latest turn sits next to the speech. The items
    /// already fit the token budget; the oldest conversation entries are dropped should the line
    /// breaks push it over.
    static func prompt(from items: [String]) -> String {
        // Conversation entries carry their speaker prefix (DictationTranscript.context); anything
        // else is the workspace sentence.
        let isConversation = { (item: String) in item.hasPrefix("我：") || item.hasPrefix("Agent：") }
        let sentence = items.filter { !isConversation($0) }
        var conversation = Array(items.filter(isConversation).reversed())
        func joined() -> String { (sentence + conversation).joined(separator: "\n") }
        while !conversation.isEmpty, DictationTranscript.estimatedTokens(joined()) > DictationTranscript.tokenBudget {
            conversation.removeFirst()
        }
        return joined()
    }
}

import Foundation

enum DoubaoIMEError: Error {
    case notConnected
    case handshakeFailed(String, Int32, String)
}

/// 豆包输入法 ASR 免 key 通道的转写实现。协议/字段/流程与
/// koe/koe-asr/src/doubaoime.rs 逐一对照移植（该文件为 plan 064 的权威参考，
/// 非记忆复现）。actor 承载：WebSocket 收发与共享采音器的 CoreAudio 回调线程
/// 天然并发，靠 actor 隔离兜底，无需手动加锁。
actor DoubaoIMEProvider: SpeechTranscribing {
    nonisolated let events: AsyncStream<SpeechTranscriptEvent>
    private let eventContinuation: AsyncStream<SpeechTranscriptEvent>.Continuation

    // 常量对应 doubaoime.rs 第 12-29 行
    private static let websocketURL = URL(string: "wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws")!
    private static let sampleRate = 16000
    private static let frameDurationMs = 20
    private static let samplesPerFrame = 320
    private static let bytesPerFrame = 640

    private var ws: URLSessionWebSocketTask?
    private let requestID = UUID().uuidString
    private var token = ""
    private var deviceID = ""
    private var opusEncoder: DoubaoOpusEncoder?
    private var pcmBuffer = Data()
    private var frameIndex = 0
    private var timestampMs: UInt64 = 0
    private var sessionFinished = false
    private var torndown = false
    private var confirmedText = ""
    private var lastSegmentText = ""
    private var listenTask: Task<Void, Never>?

    init() {
        var continuation: AsyncStream<SpeechTranscriptEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        eventContinuation = continuation
    }

    // MARK: - SpeechTranscribing

    func start() async throws {
        // 对应 doubaoime.rs:792-795：connect 时把 timestamp_ms 起点定为当前 epoch
        // 毫秒（不是从 0 起）——伪装参数须与参考实现一致，服务端行为未知不引入差异
        timestampMs = UInt64(Date().timeIntervalSince1970 * 1000)

        let creds = try await DoubaoCredentialStore.ensureCredentials()
        token = creds.token
        deviceID = creds.deviceID
        opusEncoder = try DoubaoOpusEncoder()

        var components = URLComponents(url: Self.websocketURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "aid", value: String(DoubaoCredentialStore.aid)),
            URLQueryItem(name: "device_id", value: deviceID),
        ]
        var request = URLRequest(url: components.url!)
        request.setValue(DoubaoCredentialStore.userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("v2", forHTTPHeaderField: "proto-version")
        request.setValue("true", forHTTPHeaderField: "x-custom-keepalive")

        let task = URLSession.shared.webSocketTask(with: request)
        ws = task
        task.resume()

        // StartTask（对应 doubaoime.rs DoubaoImeProvider::connect 前半段）
        let startTaskFrame = DoubaoProtobuf.encodeAsrRequest(
            token: token, serviceName: "ASR", methodName: "StartTask", payload: "",
            audioData: Data(), requestID: requestID, frameState: nil
        )
        try await send(startTaskFrame)
        let taskResp = try await receiveOne()
        if taskResp.messageType.contains("TaskFailed") {
            throw DoubaoIMEError.handshakeFailed(taskResp.messageType, taskResp.statusCode, taskResp.statusMessage)
        }

        // StartSession
        let sessionConfig = Self.buildSessionConfig(deviceID: deviceID)
        let startSessionFrame = DoubaoProtobuf.encodeAsrRequest(
            token: token, serviceName: "ASR", methodName: "StartSession", payload: sessionConfig,
            audioData: Data(), requestID: requestID, frameState: nil
        )
        try await send(startSessionFrame)
        let sessionResp = try await receiveOne()
        if sessionResp.messageType.contains("SessionFailed") {
            throw DoubaoIMEError.handshakeFailed(sessionResp.messageType, sessionResp.statusCode, sessionResp.statusMessage)
        }

        listenTask = Task { [weak self] in
            await self?.listenLoop()
        }
    }

    func feed(pcm: Data) async {
        guard !sessionFinished else { return }
        pcmBuffer.append(pcm)
        while pcmBuffer.count >= Self.bytesPerFrame {
            let frame = Data(pcmBuffer.prefix(Self.bytesPerFrame))
            pcmBuffer.removeFirst(Self.bytesPerFrame)
            await sendOpusFrame(frame, state: frameIndex == 0 ? .first : .middle)
        }
    }

    /// 对应 doubaoime.rs finish_input：flush 剩余不足一帧的音频（pad 到 640B）；
    /// 若全程不足一帧（含完全无声），服务端拒绝裸 Last，须先发一帧 First 再发
    /// 静音 Last（landmine，doubaoime.rs 第 930-958 行）。
    func finish() async {
        guard !sessionFinished else { return }
        sessionFinished = true

        var final = pcmBuffer
        if !final.isEmpty {
            final.append(Data(count: Self.bytesPerFrame - final.count))
        }
        pcmBuffer.removeAll()

        if frameIndex == 0 {
            let firstFrame = final.isEmpty ? Data(count: Self.bytesPerFrame) : final
            await sendOpusFrame(firstFrame, state: .first)
            await sendSilentLast()
        } else if !final.isEmpty {
            await sendOpusFrame(final, state: .last)
        } else {
            await sendSilentLast()
        }

        let finishFrame = DoubaoProtobuf.encodeAsrRequest(
            token: token, serviceName: "ASR", methodName: "FinishSession", payload: "",
            audioData: Data(), requestID: requestID, frameState: nil
        )
        try? await send(finishFrame)
    }

    /// 幂等收尾：finish() 已经把 sessionFinished 提前置位（不让 feed 再灌新音频），
    /// 但那不代表 ws 已经关——SessionFinished 丢包/服务端不回时连接会一直挂着。
    /// 之前用 sessionFinished 当收尾判据，会被 finish() 提前置位挡住导致 ws 永远
    /// 不关；改用独立的 torndown 标志，finish() 之后再调 cancel() 仍能真正关闭。
    func cancel() async {
        sessionFinished = true
        teardown(emitClosed: true)
    }

    private func teardown(emitClosed: Bool) {
        guard !torndown else { return }
        torndown = true
        listenTask?.cancel()
        ws?.cancel(with: .goingAway, reason: nil)
        if emitClosed {
            eventContinuation.yield(.closed)
        }
        eventContinuation.finish()
    }

    // MARK: - 发送

    private func sendOpusFrame(_ pcm: Data, state: DoubaoProtobuf.FrameState) async {
        guard let opusEncoder else { return }
        do {
            let opusData = try opusEncoder.encodeFrame(pcm)
            let payload = "{\"extra\":{},\"timestamp_ms\":\(timestampMs)}"
            let frame = DoubaoProtobuf.encodeAsrRequest(
                token: "", serviceName: "ASR", methodName: "TaskRequest", payload: payload,
                audioData: opusData, requestID: requestID, frameState: state
            )
            try await send(frame)
            frameIndex += 1
            timestampMs += UInt64(Self.frameDurationMs)
        } catch {
            // ponytail: 单帧编码/发送失败静默丢弃、不中断会话；listenLoop 的
            // 接收错误路径负责判定连接是否已经不可用
        }
    }

    private func sendSilentLast() async {
        await sendOpusFrame(Data(count: Self.bytesPerFrame), state: .last)
    }

    private func send(_ data: Data) async throws {
        guard let ws else { throw DoubaoIMEError.notConnected }
        try await ws.send(.data(data))
    }

    private func receiveOne() async throws -> DoubaoProtobuf.AsrResponse {
        guard let ws else { throw DoubaoIMEError.notConnected }
        while true {
            let message = try await ws.receive()
            if case .data(let data) = message {
                return try DoubaoProtobuf.decodeAsrResponse(data)
            }
        }
    }

    // MARK: - 接收

    private func listenLoop() async {
        guard let ws else { return }
        while !Task.isCancelled {
            do {
                let message = try await ws.receive()
                guard case .data(let data) = message else { continue }
                let resp = try DoubaoProtobuf.decodeAsrResponse(data)
                handle(resp)
                if resp.messageType.contains("SessionFinished") {
                    sessionFinished = true
                    teardown(emitClosed: true)
                    return
                }
            } catch {
                if !sessionFinished {
                    eventContinuation.yield(.failed("豆包语音连接中断"))
                }
                teardown(emitClosed: true)
                return
            }
        }
    }

    /// 对应 doubaoime.rs next_event 的结果 JSON 解析与分段重置启发式
    /// （第 1091-1131 行）：引擎偶尔在分段边界把 text 重置为更短的新分段而非
    /// 继续累加，此时须把上一段并入 confirmed_text 再拼接，否则要么丢字要么
    /// 整段重复。判据按 UTF-8 字节长度（对应 Rust String::len()，CJK 下与
    /// Swift 默认 Character count 语义不同，不能替换）。
    /// landmine：不要在 finalized 分支把 full 并入 confirmed_text——v1.0.22 试过
    /// 会导致文字重复（doubaoime.rs 注释原话），confirmed_text 只靠本启发式增长。
    private func handle(_ resp: DoubaoProtobuf.AsrResponse) {
        if resp.messageType.contains("TaskStarted") || resp.messageType.contains("SessionStarted") {
            return
        }
        if resp.messageType.contains("TaskFailed") || resp.messageType.contains("SessionFailed") {
            eventContinuation.yield(.failed(resp.statusMessage.isEmpty ? resp.messageType : resp.statusMessage))
            return
        }
        guard !resp.resultJSON.isEmpty,
              let jsonData = resp.resultJSON.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
        else { return }

        // 对应 doubaoime.rs:1047-1054：vad_start 是心跳帧，results 字段可能同时
        // 非空，须在解析 results 前就挡掉，否则会被当正常识别结果误处理
        if let extra = obj["extra"] as? [String: Any], extra["vad_start"] != nil {
            return
        }

        guard let results = obj["results"] as? [[String: Any]], !results.isEmpty else { return }

        // 对应 doubaoime.rs:1072-1084：三个 flag 都取「最后一个 result」的值，
        // is_interim 缺省 true（未知即当中间稿，不能默认当定稿）；
        // nonstream_result 挂在 result 级 extra 下，不是顶层 extra（三 pass
        // 终稿检测靠它，取错层级会导致这条判据永远失效）
        var text = ""
        var isInterim = true
        var isVadFinished = false
        var nonstreamResult = false
        for result in results {
            if let t = result["text"] as? String { text += t }
            isInterim = (result["is_interim"] as? Bool) ?? true
            isVadFinished = (result["is_vad_finished"] as? Bool) ?? false
            nonstreamResult = ((result["extra"] as? [String: Any])?["nonstream_result"] as? Bool) ?? false
        }
        // 对应 doubaoime.rs:1087-1089：空 text 是心跳，直接跳过——否则
        // lastSegmentText 会被空串覆盖，hasPrefix("") 恒真使分段重置启发式失效，
        // 屏上文字也会被空前缀稿闪退
        guard !text.isEmpty else { return }

        if !lastSegmentText.isEmpty,
           text.utf8.count < lastSegmentText.utf8.count / 2,
           !lastSegmentText.hasPrefix(text) {
            confirmedText += lastSegmentText
        }
        lastSegmentText = text
        let full = confirmedText + text

        if nonstreamResult || (!isInterim && isVadFinished) {
            eventContinuation.yield(.finalized(full))
        } else if isInterim {
            eventContinuation.yield(.volatile(full))
        } else {
            eventContinuation.yield(.finalized(full))
        }
    }

    // MARK: - 会话配置

    /// 对应 doubaoime.rs build_session_config，字段与取值原样保留
    /// （app_name 硬编码 "com.android.chrome" 是该免 key 通道的准入要求，非笔误）
    private static func buildSessionConfig(deviceID: String) -> String {
        let dict: [String: Any] = [
            "audio_info": ["channel": 1, "format": "speech_opus", "sample_rate": 16000],
            "enable_punctuation": true,
            "enable_speech_rejection": false,
            "extra": [
                "app_name": "com.android.chrome",
                "cell_compress_rate": 8,
                "did": deviceID,
                "enable_asr_threepass": true,
                "enable_asr_twopass": true,
                "input_mode": "tool",
            ],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8)
        else { return "{}" }
        return json
    }
}

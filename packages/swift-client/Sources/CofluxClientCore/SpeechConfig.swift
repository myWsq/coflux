import Foundation

/// A dictation provider (plan 20261109-speech-providers), with what it is called and what an empty
/// base URL or model resolves to. The one place the iOS app reads these from; the centre stores
/// exactly what the user typed and knows none of this.
public enum SpeechProviderID: String, CaseIterable, Identifiable, Sendable {
    case doubao
    case openai

    public var id: String { rawValue }

    /// The full name, for settings and error texts.
    public var displayName: String {
        switch self {
        case .doubao: "豆包 Seed-ASR"
        case .openai: "OpenAI Realtime"
        }
    }

    /// The short name, for the dictation badge.
    public var shortName: String {
        switch self {
        case .doubao: "豆包"
        case .openai: "OpenAI"
        }
    }

    /// 豆包: the full streaming endpoint. OpenAI: the REST base the Realtime socket URL is derived from.
    public var defaultBaseURL: String {
        switch self {
        case .doubao: "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async"
        case .openai: "https://api.openai.com/v1"
        }
    }

    /// 豆包: the `X-Api-Resource-Id`. OpenAI: the live transcription model.
    public var defaultModel: String {
        switch self {
        case .doubao: "volc.seedasr.sauc.duration"
        case .openai: "gpt-live-transcribe"
        }
    }

    /// The scheme a custom base URL must use.
    var baseURLScheme: String {
        switch self {
        case .doubao: "wss"
        case .openai: "https"
        }
    }
}

/// One provider's slot as the centre last reported it: base URL and model as stored (empty = the
/// default), whether a key is stored, and the slot's last write (ms epoch, centre clock, 0 = never).
/// Never the key itself.
public struct SpeechProviderState: Equatable, Sendable {
    public var baseURL: String
    public var model: String
    public var keyConfigured: Bool
    public var updatedAt: Double

    public init(baseURL: String = "", model: String = "", keyConfigured: Bool = false, updatedAt: Double = 0) {
        self.baseURL = baseURL
        self.model = model
        self.keyConfigured = keyConfigured
        self.updatedAt = updatedAt
    }
}

/// The account's dictation correction record as the centre last reported it (plan
/// 20261109-dictation-refine): the switch, the OpenAI-compatible base URL and chat model as stored,
/// whether a key is stored, and the last write (ms epoch, centre clock, 0 = never). Never the key
/// itself. Not an engine: never a `SpeechProviderID`.
public struct SpeechRefineState: Equatable, Sendable {
    public var enabled: Bool
    public var baseURL: String
    public var model: String
    public var keyConfigured: Bool
    public var updatedAt: Double

    public init(enabled: Bool = false, baseURL: String = "", model: String = "", keyConfigured: Bool = false, updatedAt: Double = 0) {
        self.enabled = enabled
        self.baseURL = baseURL
        self.model = model
        self.keyConfigured = keyConfigured
        self.updatedAt = updatedAt
    }

    /// Switched on and complete: a key, a base URL and a model are all stored.
    public var isUsable: Bool { enabled && keyConfigured && !baseURL.isEmpty && !model.isEmpty }
}

/// The account's dictation configuration: the provider in use, both slots and the correction record.
public struct SpeechConfig: Equatable, Sendable {
    public var active: SpeechProviderID
    public var providers: [SpeechProviderID: SpeechProviderState]
    public var refine: SpeechRefineState

    public init(
        active: SpeechProviderID,
        providers: [SpeechProviderID: SpeechProviderState],
        refine: SpeechRefineState = SpeechRefineState()
    ) {
        self.active = active
        self.providers = providers
        self.refine = refine
    }

    /// One provider's slot; an unreported slot reads as empty.
    public subscript(provider: SpeechProviderID) -> SpeechProviderState {
        providers[provider] ?? SpeechProviderState()
    }
}

/// What a slot write does with its key: keep the stored one, replace it, or remove it.
public enum SpeechKeyChange: Equatable, Sendable {
    case keep
    case replace(String)
    case clear
}

/// Answer to `CofluxClient.setSpeechProviderConfig` / `setSpeechActiveProvider` / `setSpeechRefine`:
/// accepted (the status
/// broadcast has already replaced `speechConfig`), or failed with a message for the user.
public enum SpeechWriteResult: Equatable, Sendable {
    case ok
    case failed(String)
}

/// One provider's credentials as fetched from the centre, with an empty base URL or model already
/// resolved to the provider's default. An empty `apiKey` means the slot has no key. Memory only: the
/// description never contains the key.
public struct SpeechCredentials: Equatable, Sendable, CustomStringConvertible {
    public let provider: SpeechProviderID
    public let baseURL: String
    public let model: String
    public let apiKey: String

    public init(provider: SpeechProviderID, baseURL: String, model: String, apiKey: String) {
        self.provider = provider
        self.baseURL = baseURL
        self.model = model
        self.apiKey = apiKey
    }

    public var description: String {
        "SpeechCredentials(\(provider.rawValue), baseURL: \(baseURL), model: \(model), key: \(apiKey.isEmpty ? "none" : "set"))"
    }
}

/// The correction record's credentials as fetched from the centre (plan 20261109-dictation-refine):
/// base URL and model as stored (no defaults; empty means unconfigured). An empty `apiKey` means no
/// key is stored. Memory only: the description never contains the key.
public struct SpeechRefineCredentials: Equatable, Sendable, CustomStringConvertible {
    public let baseURL: String
    public let model: String
    public let apiKey: String

    public init(baseURL: String, model: String, apiKey: String) {
        self.baseURL = baseURL
        self.model = model
        self.apiKey = apiKey
    }

    public var description: String {
        "SpeechRefineCredentials(baseURL: \(baseURL), model: \(model), key: \(apiKey.isEmpty ? "none" : "set"))"
    }
}

/// A failed speech request: not connected, unsupported by the centre, timed out, disconnected, or
/// refused by the centre. `message` is shown to the user as is; it never contains a key.
public struct SpeechError: LocalizedError, Equatable, Sendable {
    public let message: String
    public var errorDescription: String? { message }

    public init(_ message: String) {
        self.message = message
    }
}

/// The first problem with one provider's form input, mirroring the centre's rules for immediate
/// feedback (the centre stays the authority), or nil when it can be sent. Values are checked trimmed;
/// an empty base URL or model means the default, an empty key means "no new key".
public func speechConfigInputError(
    provider: SpeechProviderID,
    baseURL rawBaseURL: String,
    model rawModel: String,
    apiKey rawAPIKey: String
) -> String? {
    let baseURL = rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    let model = rawModel.trimmingCharacters(in: .whitespacesAndNewlines)
    let apiKey = rawAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
    if let error = baseURLInputError(baseURL, scheme: provider.baseURLScheme) { return error }
    if !model.isEmpty {
        if model.utf16.count > 128 { return "模型不能超过 128 个字符" }
        switch provider {
        case .openai:
            if !isOpenAILiveModel(model) { return "OpenAI 只支持 gpt-live-transcribe 系列的实时转写模型" }
        case .doubao:
            if !isDoubaoModel(model) { return "模型只能包含字母、数字、点、下划线和连字符，且以字母或数字开头" }
        }
    }
    return keyInputError(apiKey)
}

/// The first problem with the correction form's input (plan 20261109-dictation-refine), mirroring the
/// centre's rules for immediate feedback (the centre stays the authority), or nil when it can be sent.
/// Values are checked trimmed; an empty key means "no new key". Switching on needs a base URL and a
/// model.
public func speechRefineInputError(
    enabled: Bool,
    baseURL rawBaseURL: String,
    model rawModel: String,
    apiKey rawAPIKey: String
) -> String? {
    let baseURL = rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    let model = rawModel.trimmingCharacters(in: .whitespacesAndNewlines)
    let apiKey = rawAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
    if let error = baseURLInputError(baseURL, scheme: "https") { return error }
    if !model.isEmpty {
        if model.utf16.count > 128 { return "模型不能超过 128 个字符" }
        if !isRefineModel(model) { return "模型只能包含字母、数字、点、下划线、冒号、斜杠和连字符，且以字母或数字开头" }
    }
    if let error = keyInputError(apiKey) { return error }
    if enabled && (baseURL.isEmpty || model.isEmpty) { return "开启识别后整理前请先填写 Base URL 和模型" }
    return nil
}

/// A trimmed base URL's problem: empty is fine; otherwise an absolute URL of `scheme` without
/// credentials, query or fragment.
private func baseURLInputError(_ baseURL: String, scheme: String) -> String? {
    if baseURL.isEmpty { return nil }
    // UTF-16 length, as the centre (JavaScript) counts.
    if baseURL.utf16.count > 512 { return "Base URL 不能超过 512 个字符" }
    if hasWhitespaceOrControl(baseURL) { return "Base URL 不能包含空白或控制字符" }
    let schemeError = "Base URL 必须是完整的 \(scheme):// 地址"
    guard let components = URLComponents(string: baseURL),
          components.scheme?.lowercased() == scheme,
          let host = components.host, !host.isEmpty
    else { return schemeError }
    if components.user != nil || components.password != nil { return "Base URL 不能包含用户名或密码" }
    if baseURL.contains("?") || baseURL.contains("#") { return "Base URL 不能包含查询参数或片段" }
    return nil
}

/// A trimmed key's problem; empty means "no new key" and is fine.
private func keyInputError(_ apiKey: String) -> String? {
    if apiKey.utf16.count > 256 { return "API Key 不能超过 256 个字符" }
    if hasWhitespaceOrControl(apiKey) { return "API Key 不能包含空白或控制字符" }
    return nil
}

private func hasWhitespaceOrControl(_ value: String) -> Bool {
    value.unicodeScalars.contains { $0.properties.isWhitespace || $0.value < 0x20 || $0.value == 0x7f }
}

private func isModelCharacter(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar {
    case "A"..."Z", "a"..."z", "0"..."9", ".", "_", "-": true
    default: false
    }
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]*$`
private func isDoubaoModel(_ model: String) -> Bool {
    let scalars = Array(model.unicodeScalars)
    guard let first = scalars.first, first != ".", first != "_", first != "-", isModelCharacter(first) else { return false }
    return scalars.allSatisfy(isModelCharacter)
}

/// `^[A-Za-z0-9][A-Za-z0-9._:/-]*$`
private func isRefineModel(_ model: String) -> Bool {
    let scalars = Array(model.unicodeScalars)
    guard let first = scalars.first, first != ".", first != "_", first != "-", isModelCharacter(first) else { return false }
    return scalars.allSatisfy { isModelCharacter($0) || $0 == ":" || $0 == "/" }
}

/// `^gpt-live-transcribe(-[A-Za-z0-9._-]+)?$`
private func isOpenAILiveModel(_ model: String) -> Bool {
    let family = "gpt-live-transcribe"
    guard model.hasPrefix(family) else { return false }
    let rest = Array(model.unicodeScalars.dropFirst(family.unicodeScalars.count))
    if rest.isEmpty { return true }
    guard rest.first == "-", rest.count > 1 else { return false }
    return rest.dropFirst().allSatisfy(isModelCharacter)
}

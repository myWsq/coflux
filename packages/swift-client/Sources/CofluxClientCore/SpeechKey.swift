import Foundation

/// Whether the account stores a dictation API key (plan 20261108-ios-seed-asr), as the centre last
/// reported it. Never carries the key itself.
public struct SpeechKeyStatus: Equatable, Sendable {
    public var configured: Bool
    /// The last write in ms epoch, centre clock (0 when not configured).
    public var updatedAt: Double

    public init(configured: Bool, updatedAt: Double) {
        self.configured = configured
        self.updatedAt = updatedAt
    }
}

/// Answer to `CofluxClient.setSpeechKey`: the centre accepted the write (its status broadcast has
/// already replaced `speechKeyStatus`), or it failed with a message fit for the user.
public enum SpeechKeyWriteResult: Equatable, Sendable {
    case ok
    case failed(String)
}

/// A failed `CofluxClient.speechKey()`; `message` is fit for the user and never contains the key.
public struct SpeechKeyError: LocalizedError, Equatable, Sendable {
    public let message: String
    public var errorDescription: String? { message }

    public init(_ message: String) {
        self.message = message
    }
}

import Foundation

/// Whether the account has a dictation API key (plan 20261108-ios-seed-asr), as the centre last
/// reported it. Never the key itself.
public struct SpeechKeyStatus: Equatable, Sendable {
    public var configured: Bool
    /// The last write, ms epoch on the centre's clock; 0 when not configured.
    public var updatedAt: Double

    public init(configured: Bool, updatedAt: Double) {
        self.configured = configured
        self.updatedAt = updatedAt
    }
}

/// Answer to `CofluxClient.setSpeechKey`: accepted (the status broadcast has already replaced
/// `speechKeyStatus`), or failed with a message for the user.
public enum SpeechKeyWriteResult: Equatable, Sendable {
    case ok
    case failed(String)
}

/// A failed speech-key request: not connected, unsupported by the centre, timed out, disconnected,
/// or refused by the centre. `message` is shown to the user as is; it never contains the key.
public struct SpeechKeyError: LocalizedError, Equatable, Sendable {
    public let message: String
    public var errorDescription: String? { message }

    public init(_ message: String) {
        self.message = message
    }
}

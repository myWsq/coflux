import Foundation

/// Transcription events of one dictation session, collapsed into two grades: volatile (a draft that
/// may still change) and finalized (confirmed). The caller only cares about the full text to show
/// and whether it can still change, not about the engine's segmentation. Both events carry the full
/// text, never a delta.
enum SpeechTranscriptEvent: Sendable {
    /// Full text; later events may still rewrite it.
    case volatile(String)
    /// Full text; confirmed (further speech grows after it without rewriting it).
    case finalized(String)
    /// Unrecoverable error. There is a single engine and no fallback (plan 20261108-ios-seed-asr):
    /// the caller keeps whatever was transcribed so far and ends the session.
    case failed(String)
    /// The session has ended; the stream yields nothing more.
    case closed
}

/// Why a transcriber's `start()` failed (plan 20261108-ios-seed-asr D9), shared by every provider:
/// the user can fix an invalid key; anything else is reported as the service being unreachable.
enum SpeechStartError: Error, Equatable {
    /// The WebSocket handshake was answered with HTTP 401.
    case invalidKey
    /// Everything else: no network, a different handshake status, a protocol failure.
    case unreachable
}

/// The thinnest transcription engine protocol: start once, feed PCM, end with finish or cancel,
/// events through an AsyncStream. The implementations (豆包 Seed-ASR 2.0, OpenAI Realtime
/// transcription) are actors: the audio tap runs on the CoreAudio real-time thread and the UI
/// consumes on the MainActor, so actor isolation covers the cross-thread access without extra locks.
protocol SpeechTranscribing: Sendable {
    var events: AsyncStream<SpeechTranscriptEvent> { get }
    /// Open the connection; throws `SpeechStartError` when it cannot be established. Never retried.
    func start() async throws
    /// Feed a chunk of mono Int16 PCM from the shared capture, at the rate the provider was started
    /// for (16 kHz for 豆包, 24 kHz for OpenAI); the engine frames it itself.
    func feed(pcm: Data) async
    /// Normal end: flush the remaining audio and wait (bounded) for the final result; afterwards
    /// `events` has delivered `.closed`.
    func finish() async
    /// Abandon: disconnect at once without waiting for a final result.
    func cancel() async
}

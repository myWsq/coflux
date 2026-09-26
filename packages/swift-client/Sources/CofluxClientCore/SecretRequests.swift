import CofluxProtocol
import Foundation

/// A pending agent secret request (plans 20260926-agent-secret-input / 20260926-ios-secret-input):
/// an agent in the terminal `sessionID` / `taskID` ran `coflux secret ask NAME` and the worker waits
/// for a client to provide or decline the value. Metadata only — the value never passes through the
/// client state. `reason` is the agent's own text and must be presented as such. Mirrors
/// `SecretRequestState` in packages/client/src/store.ts.
public struct SecretRequestInfo: Equatable, Sendable, Identifiable {
    public var requestID: String
    public var daemonID: String
    public var sessionID: String
    public var taskID: String
    public var name: String
    public var reason: String
    /// ms epoch
    public var createdAt: Double
    /// ms epoch; decoration only — expiry is driven by the live set, not by a local timer.
    public var expiresAt: Double

    public var id: String { requestID }

    public init(daemonID: String, request: Coflux_V1_SecretRequestRef) {
        requestID = request.requestID
        self.daemonID = daemonID
        sessionID = request.sessionID
        taskID = request.taskID
        name = request.name
        reason = request.reason
        createdAt = request.createdAt
        expiresAt = request.expiresAt
    }

    /// Oldest first (the order the agent asked in); ties broken by request id, as on desktop.
    static func ordered(_ lhs: SecretRequestInfo, _ rhs: SecretRequestInfo) -> Bool {
        lhs.createdAt != rhs.createdAt ? lhs.createdAt < rhs.createdAt : lhs.requestID < rhs.requestID
    }
}

/// The user's answer to a secret request. The provided value is only carried to the router for a
/// single send; every textual rendering of this type redacts it so it can never reach a log.
public enum SecretAnswer: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    case provide(String)
    case decline
    case cancel

    public enum Kind: Equatable, Sendable {
        case provide, decline, cancel
    }

    public var kind: Kind {
        switch self {
        case .provide: .provide
        case .decline: .decline
        case .cancel: .cancel
        }
    }

    public var description: String {
        switch self {
        case .provide: "SecretAnswer.provide(<redacted>)"
        case .decline: "SecretAnswer.decline"
        case .cancel: "SecretAnswer.cancel"
        }
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .enum) }
}

/// The worker's acknowledgement of a secret answer, or a local failure to deliver it (`failed`: the
/// device was unreachable or the request timed out — the card keeps its input for a retry).
/// Mirrors `SecretAnswerResult` in packages/client/src/store.ts.
public enum SecretAnswerResult: Equatable, Sendable {
    case accepted
    case alreadyAnswered
    case expired
    case unknownRequest
    case invalid
    case failed(String)

    init(status: Coflux_V1_SecretAnswerStatus) {
        switch status {
        case .accepted: self = .accepted
        case .alreadyAnswered: self = .alreadyAnswered
        case .expired: self = .expired
        case .unknownRequest: self = .unknownRequest
        default: self = .invalid
        }
    }
}

/// Where a request card is. `closed` removes it at once, before the live set catches up. Mirrors
/// `SecretCardPhase` in apps/desktop/src/renderer/components/workbench/secret-request.ts.
public enum SecretCardPhase: Equatable, Sendable {
    public enum CloseReason: Equatable, Sendable {
        case provided, declined, cancelled, answeredElsewhere, expired
    }

    case pending
    case submitting(SecretAnswer.Kind)
    case failed(String)
    case closed(CloseReason)

    /// The card's next phase once the worker acknowledged (or the send failed).
    public static func after(_ answer: SecretAnswer.Kind, result: SecretAnswerResult) -> SecretCardPhase {
        switch result {
        case .accepted:
            switch answer {
            case .provide: return .closed(.provided)
            case .decline: return .closed(.declined)
            case .cancel: return .closed(.cancelled)
            }
        case .alreadyAnswered:
            return .closed(.answeredElsewhere)
        case .expired, .unknownRequest:
            return .closed(.expired)
        case .invalid:
            return .failed("设备拒绝了这个值：不能为空、不能超过 64 KB，也不能含 NUL 字符")
        case .failed(let error):
            return .failed("没能送达设备：\(error)")
        }
    }
}

import CofluxClientCore
import CofluxProtocol
import Foundation

@MainActor final class NativeLocalDeviceProvider: LocalDeviceTransportProvider {
    private let serverURL: URL
    private let origin = "https://coflux.dev"
    private let credentialNamespace: String?
    private let credentialStoreFactory: ((String) throws -> any LocalCredentialStore)?
    init(serverURL: URL, credentialNamespace: String? = nil,
         credentialStoreFactory: ((String) throws -> any LocalCredentialStore)? = nil) {
        self.serverURL = serverURL
        self.credentialNamespace = credentialNamespace
        self.credentialStoreFactory = credentialStoreFactory
    }
    private func store(_ account: String) throws -> any LocalCredentialStore {
        if let credentialStoreFactory { return try credentialStoreFactory(account) }
        return try LocalIdentityStore(serverURL: serverURL, accountID: credentialNamespace.map { "\($0):\(account)" } ?? account, origin: origin)
    }
    private struct PairKey: Hashable { let account: String; let daemon: String }
    private final class PairAttempt {
        var task: Task<Void, Never>?
        var waiters: [UUID: CheckedContinuation<LocalIdentityStore.CachedGrant, any Error>] = [:]
    }
    private var pairs: [PairKey: PairAttempt] = [:]

    private func cancelPairs(accountID: String, daemonID: String? = nil) {
        for key in Array(pairs.keys) where key.account == accountID && (daemonID == nil || key.daemon == daemonID) {
            guard let attempt = pairs.removeValue(forKey: key) else { continue }
            attempt.task?.cancel()
            for waiter in attempt.waiters.values { waiter.resume(throwing: CancellationError()) }
            attempt.waiters.removeAll()
        }
    }
    func clearIdentityAndGrants(accountID: String) throws {
        cancelPairs(accountID: accountID)
        try store(accountID).clearIdentityAndGrants()
    }
    func clearGrants(accountID: String) throws {
        cancelPairs(accountID: accountID)
        try store(accountID).clearGrants()
    }
    func removeGrant(daemonID: String, accountID: String) throws {
        cancelPairs(accountID: accountID, daemonID: daemonID)
        try store(accountID).removeGrant(daemonID: daemonID)
    }

    /// 同账号、同设备的首次配对共享请求；单个 lane 取消不影响其他 lane，全部取消才撤销请求。
    func pairedGrant(daemonID: String, accountID: String,
                     authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload) async throws -> LocalIdentityStore.CachedGrant {
        try Task.checkCancellation()
        let store = try store(accountID)
        if let cached = try store.grant(daemonID: daemonID) { return cached }
        let identity = try store.identity()
        let key = PairKey(account: accountID, daemon: daemonID)
        let waiterID = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                if let attempt = pairs[key] { attempt.waiters[waiterID] = continuation; return }
                let attempt = PairAttempt()
                attempt.waiters[waiterID] = continuation
                pairs[key] = attempt
                attempt.task = Task { [weak self] in
                    let outcome: Result<LocalIdentityStore.CachedGrant, any Error>
                    do {
                        var request = Coflux_V1_LocalPairRequest()
                        request.requestID = UUID().uuidString; request.daemonID = daemonID
                        request.origin = self?.origin ?? "https://coflux.dev"
                        request.browserPublicKeySec1 = identity.publicKeySec1
                        let response = try await authorize(.localPairRequest(request))
                        try Task.checkCancellation()
                        guard case .localPairResult(let result) = response, result.ok, result.hasGateway, result.hasGrantID else {
                            throw LocalGatewayError(message: "本机设备配对失败")
                        }
                        try store.saveGrant(daemonID: daemonID, grantID: result.grantID, gateway: result.gateway)
                        guard let saved = try store.grant(daemonID: daemonID) else { throw LocalGatewayError(message: "本机设备配对未保存") }
                        outcome = .success(saved)
                    } catch { outcome = .failure(error) }
                    guard let self, self.pairs[key] === attempt else { return }
                    self.pairs[key] = nil
                    for waiter in attempt.waiters.values { waiter.resume(with: outcome) }
                    attempt.waiters.removeAll()
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, let attempt = self.pairs[key], let waiter = attempt.waiters.removeValue(forKey: waiterID) else { return }
                waiter.resume(throwing: CancellationError())
                if attempt.waiters.isEmpty { self.pairs[key] = nil; attempt.task?.cancel() }
            }
        }
    }
    func open(daemonID: String, accountID: String, clientInstanceID: String, generation: UInt64, elevated: Bool,
              authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload) async throws -> LocalDeviceChannel {
        let store = try store(accountID)
        let identity = try store.identity()
        let grant = try await pairedGrant(daemonID: daemonID, accountID: accountID, authorize: authorize)
        try Task.checkCancellation()
        func lease() async throws -> Coflux_V1_OnlineDeviceLease {
            var request = Coflux_V1_LocalLeaseRequest(); request.requestID = UUID().uuidString; request.daemonID = daemonID; request.grantID = grant.grantID
            let response = try await authorize(.localLeaseRequest(request))
            try Task.checkCancellation()
            guard case .localLeaseResult(let result) = response, result.ok, result.hasLease,
                  result.lease.grantID == grant.grantID, result.lease.daemonID == daemonID, result.lease.accountID == accountID,
                  result.lease.expiresAt > Date().timeIntervalSince1970 * 1000 + 2000 else { throw LocalGatewayError(message: "本机设备授权 lease 无效") }
            return result.lease
        }
        var authorization = elevated ? try await lease() : nil
        let connector = LocalGatewayConnector(daemonID: daemonID, origin: origin, grantID: grant.grantID, gateway: grant.gateway, identity: identity)
        do {
            let opened: LocalGatewayConnector.Authenticated
            do { opened = try await connector.connect(transport: SocketTransport(), clientInstanceID: clientInstanceID, generation: generation, leaseID: authorization?.leaseID) }
            catch let error as LocalGatewayError where error.code == .leaseInvalid && elevated {
                authorization = try await lease()
                opened = try await connector.connect(transport: SocketTransport(), clientInstanceID: clientInstanceID, generation: generation, leaseID: authorization?.leaseID)
            }
            return LocalDeviceChannel(connection: opened.connection, channelID: opened.channelID, scopes: opened.scopes, leaseExpiresAt: authorization?.expiresAt)
        } catch let error as LocalGatewayError {
            if (error.code == .grantUnknown || error.code == .keyMismatch),
               try store.grant(daemonID: daemonID)?.grantID == grant.grantID {
                try store.removeGrant(daemonID: daemonID)
            }
            throw error
        }
    }
}

import AppKit
import Foundation
import Network
import SwiftUI

private let peerProtocolVersion = "coflux-local-network-tcc-peer-v1"
private let coordinatorProtocolVersion = "coflux-local-network-tcc-coordinator-v1"

private enum ExpectedDecision: String, Sendable {
    case allow
    case deny

    var title: String {
        switch self {
        case .allow: "允许"
        case .deny: "不允许"
        }
    }

    var systemChoice: String {
        switch self {
        case .allow: "允许"
        case .deny: "不允许"
        }
    }
}

private struct CompiledVariant: Sendable {
    let expectedDecision: ExpectedDecision
    let binaryTag: String
}

#if COFLUX_TCC_ALLOW_PROBE
private let compiledVariant = CompiledVariant(expectedDecision: .allow, binaryTag: "allow-probe-v1")
#elseif COFLUX_TCC_DENY_PROBE
private let compiledVariant = CompiledVariant(expectedDecision: .deny, binaryTag: "deny-probe-v1")
#else
#error("Local Network TCC probe 必须由 allow 或 deny target 构建")
#endif

private enum ProbeConfigurationError: Error, CustomStringConvertible {
    case invalid(String)

    var description: String {
        switch self {
        case .invalid(let detail): "验收配置无效：\(detail)"
        }
    }
}

private struct ProbeConfiguration: Sendable {
    let expectedDecision: ExpectedDecision
    let runID: String
    let peerHost: String
    let peerPort: NWEndpoint.Port
    let expectedPeerID: String
    let nonce: String
    let coordinatorPort: NWEndpoint.Port
    let coordinatorToken: String
    let context: String
    let bundleID: String

    init(bundle: Bundle = .main) throws {
        func string(_ key: String) throws -> String {
            guard let value = bundle.object(forInfoDictionaryKey: key) as? String,
                  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                throw ProbeConfigurationError.invalid("Info.plist 缺少 \(key)")
            }
            return value
        }

        let configuredDecision = try string("CofluxTCCExpectedDecision")
        guard let expectedDecision = ExpectedDecision(rawValue: configuredDecision),
              expectedDecision == compiledVariant.expectedDecision
        else {
            throw ProbeConfigurationError.invalid("Info.plist decision 与编译 target 不一致")
        }

        let runID = try string("CofluxTCCRunID")
        guard runID.range(of: #"^[a-z][a-z0-9-]{7,63}$"#, options: .regularExpression) != nil else {
            throw ProbeConfigurationError.invalid("run ID 格式错误")
        }

        let bundleID = bundle.bundleIdentifier ?? ""
        let expectedPrefix = "dev.coflux.macos.tcc.\(expectedDecision.rawValue)."
        guard bundleID == expectedPrefix + runID, !bundleID.hasSuffix(".template") else {
            throw ProbeConfigurationError.invalid("bundle ID 不是本次一次性身份")
        }

        let peerHost = try string("CofluxTCCPeerHost")
        let loweredPeerHost = peerHost.lowercased()
        guard loweredPeerHost != "localhost",
              loweredPeerHost != "::1",
              !loweredPeerHost.hasPrefix("127.")
        else {
            throw ProbeConfigurationError.invalid("peer 不得是 loopback")
        }

        let peerPortText = try string("CofluxTCCPeerPort")
        guard let peerPortValue = UInt16(peerPortText),
              let peerPort = NWEndpoint.Port(rawValue: peerPortValue),
              peerPortValue > 0
        else {
            throw ProbeConfigurationError.invalid("peer port 无效")
        }
        let expectedPeerID = try string("CofluxTCCExpectedPeerID")

        let coordinatorPortText = try string("CofluxTCCCoordinatorPort")
        guard let coordinatorPortValue = UInt16(coordinatorPortText),
              let coordinatorPort = NWEndpoint.Port(rawValue: coordinatorPortValue),
              coordinatorPortValue > 0
        else {
            throw ProbeConfigurationError.invalid("coordinator port 无效")
        }

        let nonce = try string("CofluxTCCNonce")
        let coordinatorToken = try string("CofluxTCCCoordinatorToken")
        guard nonce.count >= 24, coordinatorToken.count >= 24 else {
            throw ProbeConfigurationError.invalid("nonce/token 长度不足")
        }

        self.expectedDecision = expectedDecision
        self.runID = runID
        self.peerHost = peerHost
        self.peerPort = peerPort
        self.expectedPeerID = expectedPeerID
        self.nonce = nonce
        self.coordinatorPort = coordinatorPort
        self.coordinatorToken = coordinatorToken
        self.context = try string("CofluxTCCContext")
        self.bundleID = bundleID
    }
}

private struct PeerRequest: Codable, Sendable {
    let protocolVersion: String
    let runID: String
    let nonce: String
}

private struct PeerResponse: Codable, Sendable {
    let protocolVersion: String
    let runID: String
    let nonce: String
    let peerID: String
}

private struct CoordinatorEvent: Codable, Sendable {
    let protocolVersion: String
    let event: String
    let runID: String
    let token: String
    let bundleID: String
    let binaryTag: String
    let expectedDecision: String
    let context: String
    let pid: Int32
    let parentPID: Int32
    let outcome: String?
    let observedDecision: String?
    let peerID: String?
    let pathInterfaceType: String?
    let detail: String
}

private enum VerificationObservation: Sendable {
    case allowed(peerID: String, pathInterfaceType: String)
    case denied(detail: String)
    case inconclusive(detail: String)

    var decision: String? {
        switch self {
        case .allowed: "allow"
        case .denied: "deny"
        case .inconclusive: nil
        }
    }

    var detail: String {
        switch self {
        case .allowed(let peerID, let pathInterfaceType):
            "受控 peer 已回显随机 nonce（peerID=\(peerID)，path=\(pathInterfaceType)）"
        case .denied(let detail), .inconclusive(let detail): detail
        }
    }

    var peerID: String? {
        if case .allowed(let peerID, _) = self { return peerID }
        return nil
    }

    var pathInterfaceType: String? {
        if case .allowed(_, let pathInterfaceType) = self { return pathInterfaceType }
        return nil
    }
}

private final class LocalNetworkVerification: @unchecked Sendable {
    private let configuration: ProbeConfiguration
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "dev.coflux.macos.tcc.verification")
    private let lock = NSLock()
    private let completion: @Sendable (VerificationObservation) -> Void
    private var completed = false
    private var requestSent = false
    private var response = Data()

    init(
        configuration: ProbeConfiguration,
        completion: @escaping @Sendable (VerificationObservation) -> Void
    ) {
        self.configuration = configuration
        self.completion = completion
        connection = NWConnection(
            host: NWEndpoint.Host(configuration.peerHost),
            port: configuration.peerPort,
            using: .tcp
        )
    }

    func start(timeout: TimeInterval = 20) {
        connection.stateUpdateHandler = { [weak self] state in
            self?.handle(state)
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
            self?.finish(.inconclusive(detail: "验证连接超时；不能归因为 Local Network Deny"))
        }
    }

    func cancel() {
        finish(.inconclusive(detail: "验证被取消"))
    }

    private func handle(_ state: NWConnection.State) {
        switch state {
        case .ready:
            guard let pathInterfaceType = physicalPathInterfaceType(connection.currentPath) else {
                finish(.inconclusive(detail: "ready connection 没有使用 Wi-Fi/Ethernet physical path"))
                return
            }
            sendPeerRequestOnce(pathInterfaceType: pathInterfaceType)
        case .waiting(let error):
            if #available(macOS 15.0, *),
               case .localNetworkDenied? = connection.currentPath?.unsatisfiedReason
            {
                finish(.denied(detail: "NWPath.unsatisfiedReason=localNetworkDenied（\(error)）"))
            }
        case .failed(let error):
            finish(.inconclusive(detail: "连接失败但不是可证明的 localNetworkDenied：\(error)"))
        case .cancelled:
            break
        default:
            break
        }
    }

    private func physicalPathInterfaceType(_ path: NWPath?) -> String? {
        guard let path else { return nil }
        if path.usesInterfaceType(.wifi) { return "wifi" }
        if path.usesInterfaceType(.wiredEthernet) { return "wiredEthernet" }
        return nil
    }

    private func sendPeerRequestOnce(pathInterfaceType: String) {
        lock.lock()
        guard !completed, !requestSent else {
            lock.unlock()
            return
        }
        requestSent = true
        lock.unlock()

        do {
            var payload = try JSONEncoder().encode(PeerRequest(
                protocolVersion: peerProtocolVersion,
                runID: configuration.runID,
                nonce: configuration.nonce
            ))
            payload.append(0x0A)
            connection.send(content: payload, completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                if let error {
                    self.finish(.inconclusive(detail: "peer nonce 发送失败：\(error)"))
                    return
                }
                self.receivePeerResponse(pathInterfaceType: pathInterfaceType)
            })
        } catch {
            finish(.inconclusive(detail: "peer request 编码失败：\(error)"))
        }
    }

    private func receivePeerResponse(pathInterfaceType: String) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data { self.response.append(data) }
            if self.response.count > 65_536 {
                self.finish(.inconclusive(detail: "peer response 超过 64 KiB"))
                return
            }
            if let newline = self.response.firstIndex(of: 0x0A) {
                let line = self.response[..<newline]
                do {
                    let decoded = try JSONDecoder().decode(PeerResponse.self, from: Data(line))
                    guard decoded.protocolVersion == peerProtocolVersion,
                          decoded.runID == self.configuration.runID,
                          decoded.nonce == self.configuration.nonce,
                          decoded.peerID == self.configuration.expectedPeerID
                    else {
                        self.finish(.inconclusive(detail: "peer response 与本次随机挑战不一致"))
                        return
                    }
                    self.finish(.allowed(
                        peerID: decoded.peerID,
                        pathInterfaceType: pathInterfaceType
                    ))
                } catch {
                    self.finish(.inconclusive(detail: "peer response 解码失败：\(error)"))
                }
                return
            }
            if let error {
                self.finish(.inconclusive(detail: "peer response 接收失败：\(error)"))
            } else if isComplete {
                self.finish(.inconclusive(detail: "peer 在回显完整挑战前关闭连接"))
            } else {
                self.receivePeerResponse(pathInterfaceType: pathInterfaceType)
            }
        }
    }

    private func finish(_ observation: VerificationObservation) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()
        connection.stateUpdateHandler = nil
        connection.cancel()
        completion(observation)
    }
}

private final class CoordinatorReporter: @unchecked Sendable {
    private let configuration: ProbeConfiguration

    init(configuration: ProbeConfiguration) {
        self.configuration = configuration
    }

    func send(
        event: CoordinatorEvent,
        timeout: TimeInterval = 8,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        let connection = NWConnection(host: "127.0.0.1", port: configuration.coordinatorPort, using: .tcp)
        let queue = DispatchQueue(label: "dev.coflux.macos.tcc.coordinator.\(event.event)")
        let state = CoordinatorSendState(connection: connection, event: event, completion: completion)
        connection.stateUpdateHandler = { connectionState in state.handle(connectionState) }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + timeout) { state.timeout() }
    }
}

private final class CoordinatorSendState: @unchecked Sendable {
    private let connection: NWConnection
    private let event: CoordinatorEvent
    private let completion: @Sendable (Result<Void, Error>) -> Void
    private let lock = NSLock()
    private var completed = false
    private var sent = false
    private var response = Data()

    init(
        connection: NWConnection,
        event: CoordinatorEvent,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        self.connection = connection
        self.event = event
        self.completion = completion
    }

    func handle(_ state: NWConnection.State) {
        switch state {
        case .ready:
            sendOnce()
        case .failed(let error):
            finish(.failure(error))
        case .waiting:
            break
        case .cancelled:
            break
        default:
            break
        }
    }

    func timeout() {
        finish(.failure(ProbeConfigurationError.invalid("coordinator callback 超时")))
    }

    private func sendOnce() {
        lock.lock()
        guard !completed, !sent else {
            lock.unlock()
            return
        }
        sent = true
        lock.unlock()

        do {
            var payload = try JSONEncoder().encode(event)
            payload.append(0x0A)
            connection.send(content: payload, completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                if let error {
                    self.finish(.failure(error))
                    return
                }
                self.receiveAcknowledgement()
            })
        } catch {
            finish(.failure(error))
        }
    }

    private func receiveAcknowledgement() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data { self.response.append(data) }
            if self.response.count > 64 {
                self.finish(.failure(ProbeConfigurationError.invalid("coordinator ACK 过长")))
                return
            }
            if let newline = self.response.firstIndex(of: 0x0A) {
                let line = self.response[...newline]
                if Data(line) == Data("ok\n".utf8) {
                    self.finish(.success(()))
                } else {
                    self.finish(.failure(ProbeConfigurationError.invalid("coordinator ACK 无效")))
                }
            } else if let error {
                self.finish(.failure(error))
            } else if isComplete {
                self.finish(.failure(ProbeConfigurationError.invalid("coordinator ACK 不完整")))
            } else {
                self.receiveAcknowledgement()
            }
        }
    }

    private func finish(_ result: Result<Void, Error>) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()
        connection.stateUpdateHandler = nil
        connection.cancel()
        completion(result)
    }
}

@MainActor
private final class LocalNetworkProbeModel: ObservableObject {
    @Published var headline = "准备验收"
    @Published var detail = "请确认本窗口由 Finder 启动，再开始请求本地网络权限。"
    @Published var requestStarted = false
    @Published var verificationRunning = false
    @Published var resultReported = false
    @Published var configurationFailed = false

    let configuration: ProbeConfiguration?
    private var promptConnection: NWConnection?
    private var verification: LocalNetworkVerification?
    private var pendingFinalEvent: CoordinatorEvent?
    private let networkQueue = DispatchQueue(label: "dev.coflux.macos.tcc.prompt")
    private let reporter: CoordinatorReporter?

    init() {
        do {
            let configuration = try ProbeConfiguration()
            self.configuration = configuration
            reporter = CoordinatorReporter(configuration: configuration)
            report(event: "launched", detail: "GUI probe 已启动，尚未请求 Local Network", outcome: nil, observed: nil)
        } catch {
            configuration = nil
            reporter = nil
            configurationFailed = true
            headline = "配置无效"
            detail = String(describing: error)
        }
    }

    var expectedChoice: String {
        configuration?.expectedDecision.systemChoice ?? "—"
    }

    var identitySummary: String {
        guard let configuration else { return "不可用" }
        return "\(configuration.bundleID)\nrun=\(configuration.runID) · context=\(configuration.context)"
    }

    func requestLocalNetworkAccess() {
        guard let configuration, !requestStarted else { return }
        requestStarted = true
        headline = "等待系统弹窗选择“\(configuration.expectedDecision.systemChoice)”"
        detail = "首次连接只负责触发权限弹窗，不据此判定结果。完成系统选择后，请回到这里点击“验证选择结果”。"

        let connection = NWConnection(
            host: NWEndpoint.Host(configuration.peerHost),
            port: configuration.peerPort,
            using: .tcp
        )
        promptConnection = connection
        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.promptConnection === connection else { return }
                switch state {
                case .ready:
                    self.detail = "首次连接已 ready；这可能是刚选择了允许，也可能是已有权限，仍须新建连接验证。"
                case .waiting:
                    self.detail = "首次连接正在等待；弹窗未回应时也可能暂时被策略阻断，不能据此认定拒绝。"
                case .failed(let error):
                    self.detail = "首次连接失败（\(error)）；请先完成系统弹窗，再用第二次连接分类。"
                default:
                    break
                }
            }
        }
        connection.start(queue: networkQueue)
        report(event: "requestStarted", detail: "已启动首次 LAN connection", outcome: nil, observed: nil)
    }

    func verifyDecision() {
        guard let configuration, requestStarted, !verificationRunning else { return }
        promptConnection?.stateUpdateHandler = nil
        promptConnection?.cancel()
        promptConnection = nil
        verification?.cancel()
        verificationRunning = true
        resultReported = false
        headline = "正在用新的 LAN 连接验证"
        detail = "只接受 nonce echo 作为 Allow，或 NWPath.localNetworkDenied 作为 Deny。"

        let verifier = LocalNetworkVerification(configuration: configuration) { [weak self] observation in
            Task { @MainActor [weak self] in self?.handle(observation) }
        }
        verification = verifier
        verifier.start()
    }

    func resendResult() {
        guard let event = pendingFinalEvent else { return }
        sendFinal(event)
    }

    func terminate() {
        promptConnection?.cancel()
        verification?.cancel()
        NSApplication.shared.terminate(nil)
    }

    private func handle(_ observation: VerificationObservation) {
        guard let configuration else { return }
        verificationRunning = false
        verification = nil

        let outcome: String
        if observation.decision == configuration.expectedDecision.rawValue {
            outcome = "passed"
            headline = "\(configuration.expectedDecision.title)路径通过"
        } else if observation.decision == nil {
            outcome = "inconclusive"
            headline = "结果不可判定"
        } else {
            outcome = "failed"
            headline = "选择与预期不一致"
        }
        detail = observation.detail
        let event = makeEvent(
            event: "verification",
            detail: observation.detail,
            outcome: outcome,
            observed: observation.decision,
            peerID: observation.peerID,
            pathInterfaceType: observation.pathInterfaceType
        )
        pendingFinalEvent = event
        sendFinal(event)
    }

    private func sendFinal(_ event: CoordinatorEvent) {
        guard let reporter else { return }
        resultReported = false
        reporter.send(event: event) { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch result {
                case .success:
                    self.resultReported = true
                    self.detail += "\n结果已回传。请点击“结束并退出”，让 harness 执行严格清理。"
                case .failure(let error):
                    self.resultReported = false
                    self.detail += "\n结果回传失败：\(error)。请保持窗口并点击“重新发送结果”。"
                }
            }
        }
    }

    private func report(
        event: String,
        detail: String,
        outcome: String?,
        observed: String?
    ) {
        guard let reporter else { return }
        reporter.send(event: makeEvent(
            event: event,
            detail: detail,
            outcome: outcome,
            observed: observed
        )) { _ in }
    }

    private func makeEvent(
        event: String,
        detail: String,
        outcome: String?,
        observed: String?,
        peerID: String? = nil,
        pathInterfaceType: String? = nil
    ) -> CoordinatorEvent {
        guard let configuration else {
            preconditionFailure("缺少 probe configuration")
        }
        return CoordinatorEvent(
            protocolVersion: coordinatorProtocolVersion,
            event: event,
            runID: configuration.runID,
            token: configuration.coordinatorToken,
            bundleID: configuration.bundleID,
            binaryTag: compiledVariant.binaryTag,
            expectedDecision: configuration.expectedDecision.rawValue,
            context: configuration.context,
            pid: ProcessInfo.processInfo.processIdentifier,
            parentPID: getppid(),
            outcome: outcome,
            observedDecision: observed,
            peerID: peerID,
            pathInterfaceType: pathInterfaceType,
            detail: detail
        )
    }
}

private struct LocalNetworkProbeView: View {
    @StateObject private var model = LocalNetworkProbeModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: "network.badge.shield.half.filled")
                    .font(.system(size: 34, weight: .medium))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Local Network TCC · \(model.expectedChoice)路径")
                        .font(.title2.weight(.semibold))
                    Text(model.identitySummary)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    Label(model.headline, systemImage: model.resultReported ? "checkmark.seal.fill" : "info.circle")
                        .font(.headline)
                    Text(model.detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }

            Text("必须从 Finder 双击本 app，并在真实系统弹窗中人工选择“\(model.expectedChoice)”。不要使用 Terminal 主程序、XCTest、自动点击或 tccutil。")
                .font(.callout)

            Text("完成选择后，请在“系统设置 → 隐私与安全性 → 本地网络”核对当前测试 app，再点击验证。")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Button("1. 请求本地网络访问") {
                    model.requestLocalNetworkAccess()
                }
                .disabled(model.configurationFailed || model.requestStarted)

                Button("2. 验证选择结果") {
                    model.verifyDecision()
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.requestStarted || model.verificationRunning)

                Spacer()

                if !model.resultReported, model.requestStarted, !model.verificationRunning {
                    Button("重新发送结果") { model.resendResult() }
                }
                Button("结束并退出") { model.terminate() }
                    .disabled(!model.resultReported)
            }
        }
        .padding(24)
        .frame(minWidth: 700, minHeight: 430)
    }
}

private final class ProbeAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@main
private struct LocalNetworkProbeApp: App {
    @NSApplicationDelegateAdaptor(ProbeAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            LocalNetworkProbeView()
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
    }
}

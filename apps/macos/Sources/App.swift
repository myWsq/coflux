import AppKit
import CofluxApplePlatform
import CofluxClientCore
import CryptoKit
import SwiftUI

struct EmptyTokenStore: TokenStore {
    func read() throws -> String? { nil }
    func write(_: String) throws {}
    func clear() throws {}
}

@MainActor @main
struct CofluxDesktop: App {
    @State private var model: WorkbenchModel?
    init() {
        let environment = ProcessInfo.processInfo.environment
        let testing = environment["COFLUX_MACOS_TEST"] == "1"
        #if DEBUG || COFLUX_PERFORMANCE
        // 允许独立 UI 验收构建选择隔离环境；Release 不读取该调试键。
        let defaultServer = Bundle.main.infoDictionary?["CofluxDebugServerURL"] as? String ?? "ws://127.0.0.1:19873/client"
        // 开发重签名会改变钥匙串访问身份。常规 UI 联调不得读取用户的持久凭据。
        #else
        let defaultServer = "wss://api.coflux.dev/client"
        let persistentCredentials = !testing
        #endif
        guard let serverURL = try? ServerEndpoint.resolve(override: environment["COFLUX_SERVER_URL"], defaultServer: defaultServer) else {
            _model = State(initialValue: nil)
            return
        }
        let server = serverURL.absoluteString
        // 开发服务器与生产 token/界面偏好完全分隔，且不在路径或日志中输出凭据。
        let namespace = SHA256.hash(data: Data(server.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        #if DEBUG || COFLUX_PERFORMANCE
        // 编译期隔离：开发和性能入口不构造钥匙串存储，也不接受环境开关。
        let store: any TokenStore = EmptyTokenStore()
        let buildID = "dev"
        #else
        let store: any TokenStore = !persistentCredentials ? EmptyTokenStore()
            : KeychainTokenStore(service: "dev.coflux.desktop.\(namespace)")
        let buildID = Bundle.main.infoDictionary?["CofluxBuildID"] as? String ?? "unreleased"
        #endif
        let localProvider: NativeLocalDeviceProvider
        #if DEBUG || COFLUX_PERFORMANCE
        localProvider = Self.temporaryLocalProvider(serverURL: serverURL)
        #else
        if persistentCredentials {
            localProvider = NativeLocalDeviceProvider(serverURL: serverURL)
        } else {
            localProvider = Self.temporaryLocalProvider(serverURL: serverURL)
        }
        #endif
        let client = CofluxClient(configuration: ClientConfiguration(
            serverURL: serverURL, buildID: buildID),
            transport: SocketTransport(), tokenStore: store,
            localDeviceProvider: localProvider,
            p2pDeviceProvider: NativeP2PDeviceProvider())
        #if COFLUX_PERFORMANCE
        let preferencesNamespace = "performance." + namespace
        #else
        let preferencesNamespace = namespace
        #endif
        let defaults = UserDefaults(suiteName: "dev.coflux.desktop.\(testing ? "test" : preferencesNamespace)")!
        _model = State(initialValue: WorkbenchModel(client: client, preferences: defaults))
    }
    private static func temporaryLocalProvider(serverURL: URL) -> NativeLocalDeviceProvider {
        let credentials = MemoryLocalCredentialScope()
        return NativeLocalDeviceProvider(serverURL: serverURL, credentialStoreFactory: {
            try credentials.store(accountID: $0)
        })
    }

    var body: some Scene {
        Window("coflux", id: "workbench") {
            Group {
                if let model { RootView(model: model) }
                else { InvalidServerView() }
            }.preferredColorScheme(.dark)
                .frame(minWidth: 1024, minHeight: 640)
                .ignoresSafeArea(.container, edges: .top)
        }
        .defaultSize(width: 1360, height: 860)
        .windowStyle(.hiddenTitleBar)
        .commands {
            if let model {
                CommandGroup(after: .appSettings) {
                    Button("退出登录") { model.logout() }.disabled(model.client.authState != .authed)
                }
                CommandGroup(replacing: .newItem) {
                    Button("新建工作区") { model.performShortcut(.createWorkspace) }.keyboardShortcut("n")
                        .disabled(model.selectedProject == nil)
                    Button("新建终端") { model.createTerminal() }.keyboardShortcut("t")
                        .disabled(model.workspace == nil || model.creatingTerminal)
                }
                CommandMenu("终端") {
                    Button("关闭当前终端") { if let task = model.activeTask { model.requestClose(task) } }
                        .keyboardShortcut("w")
                    Button("上一个终端") { model.selectRelative(-1) }.keyboardShortcut("[")
                    Button("下一个终端") { model.selectRelative(1) }.keyboardShortcut("]")
                    Divider()
                    ForEach(1...9, id: \.self) { number in
                        Button("终端 \(number)") { model.selectTab(number - 1) }
                            .keyboardShortcut(KeyEquivalent(Character(String(number))))
                    }
                }
                CommandGroup(replacing: .help) {
                    Button("快捷键") { model.showHelp.toggle() }.keyboardShortcut("/")
                    Button("第三方许可") {
                        if let url = Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                }
            }
        }
    }
}

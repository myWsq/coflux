import Foundation

enum Config {
    static var serverURL: URL {
        #if DEBUG
        // 本机调试：xcodebuild/simctl 经 SIMCTL_CHILD_COFLUX_SERVER_URL 或 scheme 环境变量注入
        if let override = ProcessInfo.processInfo.environment["COFLUX_SERVER_URL"],
           let url = URL(string: override) {
            return url
        }
        #endif
        return URL(string: "wss://api.coflux.dev/client")!
    }
}

import Foundation

enum Config {
    // 生产 Supabase 常量（anon key 非密可提交）：真机验收时填入。两者均非 nil 时登录页
    // 走 supabase 模式（邮箱密码换票）；否则走 local 模式（用户名密码直发，本机 dev server）。
    static let supabaseURL: String? = nil // TODO: 生产验收时填入，如 "https://xxx.supabase.co"
    static let supabaseAnonKey: String? = nil // TODO: 生产验收时填入

    static var useSupabase: Bool { supabaseURL != nil && supabaseAnonKey != nil }

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

import Foundation

enum Config {
    // 生产 Supabase 常量（publishable key 设计上公开，与 web bundle 同值，可提交）。
    // 两者均非 nil 时登录页走 supabase 模式（邮箱密码换票）；置 nil 则退 local 模式
    // （用户名密码直发，本机 dev server 调试用）。
    static let supabaseURL: String? = "https://yafiocdmkhjuphmmwtrn.supabase.co"
    static let supabaseAnonKey: String? = "sb_publishable_KkFO_9qiJiGknB_kxFwupw_jGjeKaa1"

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

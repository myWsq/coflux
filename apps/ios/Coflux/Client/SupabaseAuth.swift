import Foundation

enum SupabaseLoginResult {
    case ok(accessToken: String)
    case failed(message: String)
}

/// 邮箱密码换 Supabase access_token；coflux 会话换票走 WS clientAuth.supabaseToken，
/// 之后不再触碰 Supabase。与 apps/mobile/src/lib/auth.ts 同一份语义（plan 044 决策：
/// 不引 supabase-swift——为一个 POST 引整包不值）。
enum SupabaseAuth {
    static func exchange(email: String, password: String) async -> SupabaseLoginResult {
        guard let base = Config.supabaseURL,
              let anonKey = Config.supabaseAnonKey,
              let url = URL(string: "\(base)/auth/v1/token?grant_type=password")
        else {
            return .failed(message: "Supabase 未配置")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                return .failed(message: "邮箱或密码错误")
            }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let token = json?["access_token"] as? String, !token.isEmpty else {
                return .failed(message: "登录失败：未获得访问令牌")
            }
            return .ok(accessToken: token)
        } catch {
            return .failed(message: "网络错误：无法连接认证服务")
        }
    }
}
